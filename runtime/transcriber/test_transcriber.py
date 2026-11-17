"""Tests for transcriber.py (unittest; not shipped with the plugin).

    .e2e/venv/bin/python -I runtime/transcriber/test_transcriber.py [-v] [TestClass.test_name]

Needs .e2e/models (silero_vad_v5.onnx, nemo_en_titanet_small.onnx; Piper
voices in .e2e/models/tts to generate the fixtures on first run) and, for the
end-to-end tests, a running GigaAM server: GIGAAM_URL, else the port from
`bb gigaam status --json`. Set MEETINGS_TEST_KEEP=1 to keep the meeting
directories under .e2e/test-runs, MEETINGS_TEST_LONG=1 to run the 3-hour
scale test.
"""

import collections
import http.server
import importlib.util
import itertools
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TRANSCRIBER = os.path.join(HERE, "transcriber.py")
E2E = os.path.join(ROOT, ".e2e")
MODELS = os.environ.get("MEETINGS_TEST_MODELS", os.path.join(E2E, "models"))
FIXTURES = os.environ.get("MEETINGS_TEST_FIXTURES", os.path.join(E2E, "fixtures"))
RUNS = os.path.join(E2E, "test-runs")
SR = 16000


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tr = load_module("transcriber", TRANSCRIBER)
fx = load_module("make_test_dialog", os.path.join(ROOT, "scripts", "make-test-dialog.py"))


def ensure_fixtures():
    if not os.path.exists(os.path.join(FIXTURES, "dialog.wav")):
        fx.make_dialog(FIXTURES, fx.DEFAULT_TTS_DIR)
    return fx.load_gt(FIXTURES)


def find_gigaam():
    url = os.environ.get("GIGAAM_URL")
    if not url:
        try:
            out = subprocess.run(["bb", "gigaam", "status", "--json"], capture_output=True, text=True, timeout=30)
            st = json.loads(out.stdout)
            if st.get("phase") == "ready" and st.get("port"):
                url = f"http://127.0.0.1:{st['port']}"
        except (OSError, ValueError, subprocess.SubprocessError):
            return None
    if not url:
        return None
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url.rstrip("/") + "/health", timeout=10) as r:
            return url.rstrip("/") if json.loads(r.read()).get("ready") else None
    except (OSError, ValueError):
        return None


GIGAAM = find_gigaam()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ----------------------------------------------------------------------------- scoring


def norm_words(text):
    return re.findall(r"[а-яa-z0-9]+", text.lower().replace("ё", "е"))


def word_recall(gt, segments):
    ref = collections.Counter(w for g in gt for w in norm_words(g["text"]))
    hyp = collections.Counter(w for s in segments for w in norm_words(s["text"]))
    return sum(min(c, hyp[w]) for w, c in ref.items()) / sum(ref.values())


def speaker_accuracy(gt, segments, best_mapping=False):
    """(accuracy, coverage) over 10 ms ground-truth speech frames covered by a segment.
    A frame is correct when the segment's label is one of the speakers talking then."""
    truth = collections.defaultdict(set)
    for g in gt:
        for f in range(round(g["start"] * 100), round(g["end"] * 100)):
            truth[f].add(g["speaker"])
    hyp = {}
    for s in segments:
        for f in range(round(s["start"] * 100), round(s["end"] * 100)):
            hyp[f] = s["speaker"]
    frames = [f for f in truth if f in hyp]
    if not frames:
        return 0.0, 0.0
    labels = sorted({hyp[f] for f in frames})
    names = sorted({g["speaker"] for g in gt})
    if best_mapping:
        pool = names + [None] * max(0, len(labels) - len(names))
        maps = [dict(zip(labels, p)) for p in itertools.permutations(pool, len(labels))]
    else:
        maps = [{lab: lab for lab in labels}]
    best = max(sum(1 for f in frames if m[hyp[f]] in truth[f]) for m in maps)
    return best / len(frames), len(frames) / len(truth)


def read_jsonl(path):
    out = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    return out


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ----------------------------------------------------------------------------- unit tests (no GigaAM)


def timeline_from(events, default_lag=0):
    tl = tr.SpeakerTimeline("/nonexistent", default_lag)
    for ev in events:
        tl.add(ev)
    return tl


class PureFunctionTests(unittest.TestCase):
    def test_timeline_lag_and_coverage(self):
        rec = 1_000_000.0
        tl = timeline_from([
            {"t": rec + 1000 + 800, "speakers": ["A"], "src": "track", "lagMs": 800},
            {"t": rec + 3000 + 700, "speakers": ["A", "B"], "src": "store"},  # default lag 700
            {"t": rec + 4000, "speakers": [], "src": "track", "lagMs": 0},
            {"t": "bad", "speakers": ["X"]},
            {"t": rec, "speakers": "not-a-list"},
        ], default_lag=700)
        self.assertEqual(len(tl.times), 3)
        cov = tr.ui_coverage(tl, rec, 0.0, 5.0)  # A alone 1-3 s, A+B 3-4 s, nobody after
        self.assertAlmostEqual(cov["A"], (2.0 + 0.5) / 5.0)
        self.assertAlmostEqual(cov["B"], 0.5 / 5.0)
        self.assertEqual(tr.top_speaker(cov)[0], "A")
        self.assertEqual(tr.ui_coverage(tl, None, 0.0, 5.0), {})
        tl.prune(rec + 3500)
        self.assertEqual(tl.sets[0], ("A", "B"))

    def test_timeline_tail_partial_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "speakers.jsonl")
            with open(path, "w") as f:
                f.write('{"t": 1000, "speakers": ["A"], "src": "tile"}\ngarbage\n{"t": 2000, "speak')
            tl = tr.SpeakerTimeline(path, 0)
            tl.poll()
            self.assertEqual(tl.sets, [("A",)])
            with open(path, "a") as f:
                f.write('ers": ["B"], "src": "tile"}\n')
            tl.poll()
            self.assertEqual(tl.sets, [("A",), ("B",)])

    def test_ui_split_at_quiet_point(self):
        rng = np.random.default_rng(0)
        x = np.concatenate([rng.normal(0, 0.2, 3 * SR), np.zeros(int(0.2 * SR)), rng.normal(0, 0.2, 3 * SR)])
        x = x.astype(np.float32)
        rec = 0.0
        # True change at 3.1 s; the UI reports it 0.2 s late (residual lag).
        tl = timeline_from([{"t": 10_000, "speakers": ["A"], "src": "t", "lagMs": 0},
                            {"t": 13_100 + 200, "speakers": ["B"], "src": "t", "lagMs": 0}])
        cuts = tr.ui_split_offsets(tl, rec, 10 * SR, x)
        self.assertEqual(len(cuts), 1)
        self.assertTrue(3.0 * SR <= cuts[0] <= 3.2 * SR, cuts)
        # A 0.5 s flicker of B is not a turn change.
        tl = timeline_from([{"t": 10_000, "speakers": ["A"], "src": "t", "lagMs": 0},
                            {"t": 12_000, "speakers": ["B"], "src": "t", "lagMs": 0},
                            {"t": 12_500, "speakers": ["A"], "src": "t", "lagMs": 0}])
        self.assertEqual(tr.ui_split_offsets(tl, rec, 10 * SR, x), [])
        # Pieces shorter than 1.2 s are never cut off.
        tl = timeline_from([{"t": 10_000, "speakers": ["A"], "src": "t", "lagMs": 0},
                            {"t": 15_500, "speakers": ["B"], "src": "t", "lagMs": 0}])
        self.assertEqual(tr.ui_split_offsets(tl, rec, 10 * SR, x), [])

    def test_handover_turn_starts_when_the_new_speaker_lights_up(self):
        # Real case (mock meeting, track signal): A's track stays loud ~0.4 s after
        # B starts, so the set goes {A} -> {A,B} -> {B}. B owns the turn from 13.1 s.
        rec = 0.0
        tl = timeline_from([{"t": 10_000, "speakers": ["A"], "src": "track", "lagMs": 0},
                            {"t": 13_100, "speakers": ["A", "B"], "src": "track", "lagMs": 0},
                            {"t": 13_550, "speakers": ["B"], "src": "track", "lagMs": 0}])
        runs = tr.ui_runs(tl, rec, 10.0, 16.0)
        self.assertEqual([r[0] for r in runs], ["A", "B"])
        self.assertAlmostEqual(runs[0][2], 13.1, places=3)
        # An interjection inside a continuing turn: {A} -> {A,B} -> {A}; B gets a
        # run of its own, which merge_short_runs folds back when it is short.
        tl = timeline_from([{"t": 10_000, "speakers": ["A"], "src": "track", "lagMs": 0},
                            {"t": 12_000, "speakers": ["A", "B"], "src": "track", "lagMs": 0},
                            {"t": 12_400, "speakers": ["A"], "src": "track", "lagMs": 0}])
        self.assertEqual([r[0] for r in tr.merge_short_runs(tr.ui_runs(tl, rec, 10.0, 16.0), 1.2)], ["A"])

    def test_ui_split_finds_the_pause_before_a_late_change(self):
        # B starts at 3.2 s after a 0.2 s pause; a soft onset makes the signal 0.45 s late.
        rng = np.random.default_rng(1)
        x = np.concatenate([rng.normal(0, 0.2, 3 * SR), np.zeros(int(0.2 * SR)), rng.normal(0, 0.2, 3 * SR)])
        x = x.astype(np.float32)
        tl = timeline_from([{"t": 10_000, "speakers": ["A"], "src": "t", "lagMs": 0},
                            {"t": 13_200 + 450, "speakers": ["B"], "src": "t", "lagMs": 0}])
        cuts = tr.ui_split_offsets(tl, 0.0, 10 * SR, x)
        self.assertEqual(len(cuts), 1)
        self.assertTrue(3.0 * SR <= cuts[0] <= 3.2 * SR, cuts)

    def test_speaker_lag_setting_shifts_stamped_events(self):
        events = [{"t": 5_000, "speakers": ["A"], "src": "store", "lagMs": 700},
                  {"t": 9_000, "speakers": ["B"], "src": "track", "lagMs": 100}]
        default = timeline_from(events, default_lag=700)
        self.assertEqual(default.times, [4_300.0, 8_900.0])
        later = timeline_from(events, default_lag=1_200)  # Zoom lags 0.5 s more here
        self.assertEqual(later.times, [3_800.0, 8_400.0])
        earlier = timeline_from(events, default_lag=0)
        self.assertEqual(earlier.times, [5_000.0, 9_000.0])

    def test_merge_short_runs(self):
        runs = [["A", 0, 5], ["B", 5, 5.5], ["A", 5.5, 8], ["C", 8, 8.3], ["B", 8.3, 12]]
        # B (0.5 s) folds into A; C (0.3 s) into its longer neighbour B.
        self.assertEqual(tr.merge_short_runs(runs, 1.2), [["A", 0, 8], ["B", 8, 12]])

    def test_hard_cut(self):
        rng = np.random.default_rng(1)
        x = rng.normal(0, 0.1, 47 * SR).astype(np.float32)
        x[int(15 * SR):int(15.3 * SR)] = 0  # the quiet spot to cut at
        pieces = tr.hard_cut(100, x)
        self.assertTrue(all(len(p) <= tr.HARD_MAX_PIECE_S * SR for _, p in pieces))
        self.assertEqual(sum(len(p) for _, p in pieces), len(x))
        self.assertTrue(15 * SR <= pieces[1][0] - 100 <= 15.3 * SR)
        self.assertEqual(pieces[0][0], 100)

    def test_agglomerative(self):
        rng = np.random.default_rng(2)
        centers = rng.normal(size=(3, 64))
        X = np.concatenate([c + rng.normal(0, 0.3, (20, 64)) for c in centers])
        X = X[rng.permutation(len(X))]
        X /= np.linalg.norm(X, axis=1, keepdims=True)
        labels = tr.agglomerative(X.astype(np.float32), 0.6)
        self.assertEqual(len(set(labels)), 3)
        self.assertEqual(labels[0], 0)
        self.assertEqual(len(set(tr.agglomerative(X.astype(np.float32), 0.999))), len(X))
        self.assertEqual(list(tr.agglomerative(X[:1], 0.6)), [0])

    def test_clustering_scales(self):
        rng = np.random.default_rng(3)
        centers = rng.normal(size=(8, 192))
        X = np.concatenate([c + rng.normal(0, 0.6, (400, 192)) for c in centers]).astype(np.float32)
        X /= np.linalg.norm(X, axis=1, keepdims=True)
        started = time.monotonic()
        labels = tr.cluster_embeddings(X, np.ones(len(X)), 0.6)
        took = time.monotonic() - started
        print(f"\n  clustering 3200 x 192: {took:.1f}s, {len(set(labels))} clusters", file=sys.stderr)
        self.assertEqual(len(set(labels)), 8)
        self.assertLess(took, 60)

    def test_decide_speakers(self):
        segs = [{"start": i * 3.0, "end": i * 3.0 + 2.5} for i in range(7)]
        covs = [{"Анна": 1.0}, {"Анна": 0.4}, {}, {"Олег": 0.9}, {}, {"Олег": 0.5, "Анна": 0.5}, {}]
        own = [0, 0, 0, 1, 2, None, 3]
        out = tr.decide_speakers(segs, covs, own, "ui+acoustic")
        self.assertEqual(out[0], ("ui:Анна", "Анна", "ui"))
        self.assertEqual(out[1], ("ui:Анна", "Анна", "mixed"))  # weak UI, cluster 0 is Анна
        self.assertEqual(out[2], ("ui:Анна", "Анна", "mixed"))
        self.assertEqual(out[3], ("ui:Олег", "Олег", "ui"))
        self.assertEqual(out[4], ("spk:1", "Спикер 1", "acoustic"))  # cluster 2 has no UI votes
        self.assertEqual(out[5], ("spk:1", "Спикер 1", "acoustic"))  # no embedding: inherits cluster 2
        self.assertEqual(out[6], ("spk:2", "Спикер 2", "acoustic"))
        # Impure cluster: per-segment UI wins.
        covs = [{"A": 1.0}, {"B": 1.0}, {"A": 0.5}]
        out = tr.decide_speakers(segs[:3], covs, [0, 0, 0], "ui+acoustic")
        self.assertEqual([o[0] for o in out], ["ui:A", "ui:B", "ui:A"])
        self.assertEqual(out[2][2], "ui")
        # Modes.
        self.assertEqual(tr.decide_speakers(segs[:2], [{"A": 0.3}, {}], [None, None], "ui"),
                         [("ui:A", "A", "ui"), ("unknown", "Неизвестный", "none")])
        self.assertEqual([o[0] for o in tr.decide_speakers(segs[:3], [{"A": 1}] * 3, [5, 2, None], "acoustic")],
                         ["spk:1", "spk:2", "spk:2"])

    def test_render(self):
        a = {"speakerKey": "ui:A", "speaker": "A*", "source": "ui"}
        s1 = {"speakerKey": "spk:1", "speaker": "Спикер 1", "source": "acoustic"}
        segs = [
            dict(a, id=0, start=1.0, end=3.0, text="Привет."),
            dict(a, id=1, start=4.0, end=5.0, text="Как дела?"),
            dict(s1, id=2, start=5.5, end=7.0, text="Хорошо."),
            dict(s1, id=3, start=3725.0, end=3726.0, text="Пока."),
        ]
        t = {"audioSec": 3730.0, "segments": segs, "speakers": tr.speaker_summary(segs)}
        self.assertEqual(t["speakers"][0]["label"], "A*")
        txt = tr.render_text(t)
        self.assertEqual(txt.splitlines(), ["[00:00:01] A*: Привет. Как дела?", "[00:00:05] Спикер 1: Хорошо.",
                                            "[01:02:05] Спикер 1: Пока."])
        md = tr.render_markdown(t)
        self.assertTrue(md.startswith("# Расшифровка встречи\n"))
        self.assertIn("- Длительность: 01:02:10", md)
        self.assertIn("- Спикеры: A\\*, Спикер 1", md)
        self.assertIn("**A\\*** · 00:00:01\nПривет. Как дела?\n", md)

    def test_jsonl_tolerance_and_truncate(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "segments.jsonl")
            good = {"id": 0, "start": 0.5, "end": 1.5, "speakerKey": "unknown", "speaker": "?", "source": "none",
                    "text": "а"}
            with open(path, "w", encoding="utf-8") as f:
                f.write(json.dumps(good) + "\n")
                f.write("not json\n\n")
                f.write(json.dumps(dict(good, text="дубль")) + "\n")
                f.write(json.dumps(dict(good, id=1, text="б")) + "\n")
                f.write(json.dumps(dict(good, id=2)) + "\n")
                f.write('{"id": 3, "start": 1')
            self.assertEqual([s["text"] for s in tr.load_segments(path, 10)], ["а", "б", "а"])
            self.assertEqual(tr.truncate_jsonl(path, 2), 2)
            self.assertEqual([s["id"] for s in read_jsonl(path)], [0, 1])

    def test_embedding_roundtrip_and_wav(self):
        v = tr.unit(np.arange(1, 193, dtype=np.float32))
        back = tr.decode_embedding(tr.encode_embedding(v))
        self.assertTrue(np.allclose(v, back))
        self.assertIsNone(tr.unit(np.array([np.nan, 1.0])))
        self.assertIsNone(tr.decode_embedding("!!!"))
        x = (np.arange(-32768, 32768, 7, dtype=np.int64) / 32768.0).astype(np.float32)
        wav = tr.wav_bytes(x)
        self.assertEqual(wav[:4], b"RIFF")
        pcm = np.frombuffer(wav[44:], dtype="<i2")
        self.assertTrue(np.array_equal(pcm, np.arange(-32768, 32768, 7)))
        body, ctype = tr.multipart({"response_format": "json"}, "file", "s.wav", b"DATA", "audio/wav")
        boundary = ctype.split("boundary=")[1]
        self.assertTrue(body.endswith(f"--{boundary}--\r\n".encode()))
        self.assertIn(b'name="file"; filename="s.wav"\r\nContent-Type: audio/wav\r\n\r\nDATA\r\n', body)

    def test_energy_vad_on_dialog(self):
        gt = ensure_fixtures()
        x = fx.read_wav(os.path.join(FIXTURES, "dialog.wav"))
        vad = tr.EnergyVad(1000)
        segs = []
        n = len(x) // tr.VAD_WINDOW * tr.VAD_WINDOW
        for off in range(0, n, tr.CHUNK_SAMPLES):
            segs += vad.accept(x[off:min(n, off + tr.CHUNK_SAMPLES)])
        segs += vad.flush()
        spans = [((s - 1000) / SR, (s - 1000 + len(y)) / SR) for s, y in segs]
        speech = sum(g["end"] - g["start"] for g in gt)
        covered = sum(max(0.0, min(b, g["end"]) - max(a, g["start"])) for a, b in spans for g in gt)
        self.assertGreaterEqual(len(spans), 7)
        self.assertGreater(covered / speech, 0.9)


class StubAsr:
    """A GigaAM stand-in. handler(kind, n) -> (code, body) for the n-th POST;
    kind is "probe" (AsrClient's second of silence) or "piece"."""

    def __init__(self, handler):
        self.calls = []
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                kind = "probe" if b'filename="probe.wav"' in body else "piece"
                stub.calls.append(kind)
                self._send(*handler(kind, len(stub.calls)))

            def do_GET(self):
                self._send(200, b'{"ready": true, "model": "stub"}')

            def _send(self, code, data):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


OK = (200, '{"text": "проверка связи"}'.encode())


class AsrClientTests(unittest.TestCase):
    """AsrClient against stub servers, with short backoffs (no GigaAM needed)."""

    def setUp(self):
        self.saved = {k: getattr(tr, k) for k in ("BACKOFF_MIN_S", "BACKOFF_MAX_S", "POLL_S", "log")}
        tr.BACKOFF_MIN_S, tr.BACKOFF_MAX_S, tr.POLL_S = 0.05, 0.2, 0.02
        self.logs = []
        tr.log = self.logs.append
        self.tmp = tempfile.mkdtemp(prefix="asr-")
        self.discovery = os.path.join(self.tmp, "gigaam.json")
        self.stubs = []

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(tr, k, v)
        for s in self.stubs:
            s.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stub(self, handler):
        s = StubAsr(handler)
        self.stubs.append(s)
        return s

    def discover(self, url):
        fx.write_json(self.discovery, {"url": url})

    def client(self, primary):
        self.statuses = []
        stop = threading.Event()
        c = tr.AsrClient(primary, self.discovery, stop, self.statuses.append)
        posts = []
        post = c._post
        c._post = lambda url, body, ctype: (posts.append(url), post(url, body, ctype))[1]
        return c, stop, posts

    def test_endpoint_fallback_and_cache_are_per_server(self):
        import io
        requests = []

        class Opener:
            def open(_, request, timeout):
                requests.append(request.full_url)
                if request.full_url == "http://first.test/transcribe":
                    raise urllib.error.HTTPError(request.full_url, 404, "Not found", {}, io.BytesIO(b"missing"))
                return io.BytesIO(b'{"text":"  recognized   speech  "}')

        c, _, _ = self.client("http://first.test")
        c._opener = Opener()
        for url in ["http://first.test", "http://first.test", "http://second.test", "http://first.test"]:
            self.assertEqual(c._post(url, b"audio", "audio/wav"), "recognized speech")
        self.assertEqual(requests, ["http://first.test/transcribe", "http://first.test/v1/audio/transcriptions",
                                   "http://first.test/v1/audio/transcriptions", "http://second.test/transcribe",
                                   "http://first.test/v1/audio/transcriptions"])

    def transcribe(self, c, stop, seconds, after=None):
        """Run c.transcribe on a second of noise; `after()` runs mid-way. Returns
        (result, finished) once it returns or `seconds` pass (then it is stopped)."""
        out = {}

        def run():
            try:
                out["result"] = c.transcribe(np.full(SR, 0.1, dtype=np.float32))
            except tr.Stopped:
                pass

        t = threading.Thread(target=run)
        t.start()
        try:
            if after:
                t.join(timeout=seconds / 2)
                after()
            t.join(timeout=seconds)
            finished = not t.is_alive()
        finally:
            stop.set()
            t.join(timeout=10)
        return out.get("result"), finished

    def test_failover_alternates_with_backoff(self):
        # Both URLs refuse connections: no busy loop, both keep being tried.
        dead1, dead2 = f"http://127.0.0.1:{free_port()}", f"http://127.0.0.1:{free_port()}"
        self.discover(dead2)
        c, stop, posts = self.client(dead1)
        c.url = dead2
        _, finished = self.transcribe(c, stop, 1.0)
        self.assertFalse(finished)
        self.assertLess(len(posts), 15, posts)
        self.assertEqual(set(posts), {dead1, dead2})
        self.assertLess(len(self.logs), 15, self.logs)
        # gigaam.json points to a dead URL, the primary works: the primary is reached.
        live = self.stub(lambda kind, n: OK)
        c, stop, posts = self.client(live.url)
        c.url = dead2
        result, finished = self.transcribe(c, stop, 5.0)
        self.assertTrue(finished)
        self.assertEqual(result, "проверка связи")
        self.assertEqual(posts, [dead2, live.url])

    def test_new_gigaam_json_wakes_the_wait(self):
        tr.BACKOFF_MIN_S = 60.0
        dead = f"http://127.0.0.1:{free_port()}"
        self.discover(dead)
        live = self.stub(lambda kind, n: OK)
        c, stop, posts = self.client(None)
        started = time.monotonic()
        result, finished = self.transcribe(c, stop, 3.0, after=lambda: self.discover(live.url))
        self.assertTrue(finished)
        self.assertEqual(result, "проверка связи")
        self.assertLess(time.monotonic() - started, 5.0)
        self.assertEqual(posts, [dead, live.url])
        self.assertTrue(any("gigaam.json now points to" in line for line in self.logs))

    def test_server_errors_wait_piece_errors_skip(self):
        mode = {"code": 401}

        def handler(kind, n):
            return OK if mode["code"] == 200 else (mode["code"], b'{"detail": "no"}')

        # The server rejects everything (auth, wrong API): wait, never drop audio.
        s = self.stub(handler)
        c, stop, _ = self.client(s.url)

        def fix():
            mode["waited"] = list(self.statuses)
            mode["code"] = 200

        result, finished = self.transcribe(c, stop, 1.6, after=fix)
        self.assertTrue(any(st and "HTTP 401" in st for st in mode["waited"]), mode["waited"])
        self.assertEqual((result, finished), ("проверка связи", True))
        self.assertIn("probe", s.calls)
        # Broken for every request incl. the probe (500): waits too.
        mode["code"] = 500
        c, stop, _ = self.client(s.url)
        result, finished = self.transcribe(c, stop, 1.6, after=lambda: mode.update(code=200))
        self.assertEqual((result, finished), ("проверка связи", True))

        # Only this piece fails, the server transcribes silence: the piece is skipped.
        s = self.stub(lambda kind, n: OK if kind == "probe" else (400, b'{"detail": "bad audio"}'))
        c, stop, _ = self.client(s.url)
        result, finished = self.transcribe(c, stop, 3.0)
        self.assertEqual((result, finished), (None, True))
        self.assertEqual(s.calls, ["piece", "probe"])
        self.assertTrue(any("HTTP 400" in line and "skipped" in line for line in self.logs), self.logs)
        # A piece that always gets a 500: retried a few times, then skipped.
        s = self.stub(lambda kind, n: OK if kind == "probe" else (500, b"Internal Server Error"))
        c, stop, _ = self.client(s.url)
        result, finished = self.transcribe(c, stop, 5.0)
        self.assertEqual((result, finished), (None, True))
        self.assertEqual(s.calls.count("piece"), tr.PIECE_5XX_TRIES)
        self.assertEqual(s.calls[-1], "probe")
        # 503 (starting): retried without probing, nothing lost.
        s = self.stub(lambda kind, n: OK if n > 3 else (503, b'{"detail": "not ready"}'))
        c, stop, _ = self.client(s.url)
        result, finished = self.transcribe(c, stop, 5.0)
        self.assertEqual((result, finished), ("проверка связи", True))
        self.assertEqual(s.calls, ["piece"] * 4)


# ----------------------------------------------------------------------------- end-to-end (GigaAM)


@unittest.skipUnless(GIGAAM, "GigaAM server not reachable (set GIGAAM_URL or start `bb gigaam`)")
class TranscriberTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gt = ensure_fixtures()
        os.makedirs(RUNS, exist_ok=True)

    def setUp(self):
        self.host = tempfile.mkdtemp(prefix=self._testMethodName + "-", dir=RUNS)
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()
        if os.environ.get("MEETINGS_TEST_KEEP") != "1":
            shutil.rmtree(self.host, ignore_errors=True)

    # ---- helpers

    def meeting(self, **kw):
        mid = fx.new_meeting_id()
        d = os.path.join(self.host, "meetings", mid)
        fx.make_meeting_dir(d, FIXTURES, meeting_id=mid, **kw)
        return d

    def cmd(self, d, mode, gigaam=True, models=MODELS, extra=()):
        c = [sys.executable, "-I", TRANSCRIBER, "--meeting-dir", d, "--mode", mode, "--models-dir", models,
             "--threads", "4"]
        if gigaam:
            c += ["--gigaam-url", GIGAAM]
        return c + list(extra)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith("MEETINGS_")}
        env.update(extra)
        return env

    def start(self, d, mode, env=None, argv=None, **kw):
        log = open(os.path.join(d, "transcriber.log"), "ab")
        p = subprocess.Popen(argv or self.cmd(d, mode, **kw), stdout=log, stderr=subprocess.STDOUT,
                             env=env or self.env())
        log.close()
        self.procs.append(p)
        return p

    def run_to_end(self, d, mode="offline", timeout=180, **kw):
        started = time.monotonic()
        p = self.start(d, mode, **kw)
        code = p.wait(timeout=timeout)
        return code, time.monotonic() - started

    def log_text(self, d):
        with open(os.path.join(d, "transcriber.log"), encoding="utf-8", errors="replace") as f:
            return f.read()

    def transcript(self, d):
        st = read_json(os.path.join(d, "transcriber.json"))
        self.assertIsNotNone(st, "transcriber.json missing")
        self.assertEqual(st["phase"], "done", f"{st}\n{self.log_text(d)[-3000:]}")
        t = read_json(os.path.join(d, "transcript.json"))
        self.assertIsNotNone(t)
        self.check_transcript_shape(t)
        return t

    def check_transcript_shape(self, t):
        self.assertEqual(set(t), {"version", "meetingId", "audioSec", "createdAt", "asr", "diarization",
                                  "speakers", "segments"})
        self.assertRegex(t["meetingId"], r"^mtg_[a-z0-9]{6,32}$")
        self.assertEqual(t["asr"]["engine"], "gigaam")
        ids = [s["id"] for s in t["segments"]]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(len(ids), len(set(ids)))
        for s in t["segments"]:
            self.assertEqual(set(s), {"id", "start", "end", "speakerKey", "speaker", "source", "text"})
            self.assertLessEqual(s["start"], s["end"])
            self.assertIn(s["source"], ("ui", "acoustic", "mixed", "none"))
            self.assertTrue(s["text"])
        talk = [sp["talkSec"] for sp in t["speakers"]]
        self.assertEqual(talk, sorted(talk, reverse=True))
        self.assertEqual(sum(sp["segments"] for sp in t["speakers"]), len(t["segments"]))

    def report(self, name, t, best_mapping=False, rtf=None):
        acc, cov = speaker_accuracy(self.gt, t["segments"], best_mapping)
        rec = word_recall(self.gt, t["segments"])
        extra = f", RTF {rtf:.3f}" if rtf is not None else ""
        print(f"\n  {name}: speaker accuracy {acc:.3f} (coverage {cov:.3f}), word recall {rec:.3f}, "
              f"{len(t['segments'])} segments, speakers {[sp['label'] for sp in t['speakers']]}{extra}",
              file=sys.stderr)
        return acc, cov, rec

    def wait_for(self, pred, timeout, what):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            v = pred()
            if v:
                return v
            time.sleep(0.1)
        self.fail(f"timed out waiting for {what}")

    def dummy_bot(self, d):
        """A process whose cmdline mentions the meeting dir, standing in for bot-runner."""
        p = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(600)", "--meeting-dir", d])
        self.procs.append(p)
        return p

    def set_bot_phase(self, d, phase, pid=None):
        path = os.path.join(d, "state.json")
        st = read_json(path)
        st.update(phase=phase, updatedAt=int(time.time() * 1000))
        if pid is not None:
            st["pid"] = pid
        if phase in ("ended", "failed"):
            st.update(endedAt=int(time.time() * 1000), endReason="meeting_ended")
        fx.write_json(path, st)

    # ---- 1-3: offline accuracy

    def test_1_offline_perfect_ui(self):
        d = self.meeting(audio="ogg", lag_field=True)
        code, took = self.run_to_end(d)
        self.assertEqual(code, 0)
        t = self.transcript(d)
        audio = t["audioSec"]
        acc, cov, rec = self.report("offline, perfect UI", t, rtf=took / audio)
        self.assertGreaterEqual(acc, 0.95)
        self.assertGreaterEqual(cov, 0.9)
        self.assertGreaterEqual(rec, 0.7)
        self.assertEqual(t["diarization"], "ui+acoustic")
        self.assertEqual({sp["key"] for sp in t["speakers"]}, {f"ui:{g['speaker']}" for g in self.gt})
        self.assertIn("decoded audio.ogg -> audio.decoded.pcm", self.log_text(d))
        self.assertFalse(os.path.exists(os.path.join(d, "audio.decoded.pcm")), "the decoded copy must be deleted")
        self.assertFalse(os.path.exists(os.path.join(d, "audio.pcm")))
        self.assertTrue(os.path.exists(os.path.join(d, "embeddings.jsonl")))
        with open(os.path.join(d, "transcript.md"), encoding="utf-8") as f:
            md = f.read()
        self.assertTrue(md.startswith("# Расшифровка встречи"))
        self.assertIn("**Анна Смирнова** · 00:00:06", md)
        with open(os.path.join(d, "transcript.txt"), encoding="utf-8") as f:
            self.assertRegex(f.readline(), r"^\[00:00:0\d\] Олег Петров: Добрый день")

    def test_2_lag_and_jitter(self):
        d = self.meeting(lag_ms=800, jitter_ms=200, lag_field=True, seed=5)
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0)
        acc, _, rec = self.report("lag 800 ms + jitter 200 ms (lagMs)", self.transcript(d))
        self.assertGreaterEqual(acc, 0.9)
        self.assertGreaterEqual(rec, 0.7)
        # Tile-like sticky indicator (never empty), 1.2 s lag from config.speakerLagMs (no lagMs).
        d = self.meeting(lag_ms=1200, jitter_ms=300, style="sticky", seed=7, transcriber={"speakerLagMs": 1200})
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0)
        acc, _, _ = self.report("sticky tile, lag 1200 ms from config, jitter 300 ms", self.transcript(d))
        self.assertGreaterEqual(acc, 0.9)
        # Per-person track events with 20 % of the changes lost: acoustics fill the holes.
        d = self.meeting(lag_ms=100, jitter_ms=100, lag_field=True, dropout=0.2, seed=11)
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0)
        acc, _, _ = self.report("track events, 20 % dropped", self.transcript(d))
        self.assertGreaterEqual(acc, 0.9)

    def test_3_acoustic_only(self):
        d = self.meeting(lag_field=True, transcriber={"diarization": "acoustic"})
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0)
        t = self.transcript(d)
        acc, _, _ = self.report("acoustic only", t, best_mapping=True)
        self.assertEqual(t["diarization"], "acoustic")
        self.assertEqual(sorted(sp["key"] for sp in t["speakers"]), ["spk:1", "spk:2", "spk:3"])
        self.assertEqual(t["segments"][0]["speaker"], "Спикер 1")
        self.assertTrue(all(s["source"] == "acoustic" for s in t["segments"]))
        self.assertGreaterEqual(acc, 0.9)
        # Without any UI events in ui+acoustic mode the clusters become "Спикер N" too.
        d = self.meeting(events=False)
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0)
        t = self.transcript(d)
        acc, _, _ = self.report("ui+acoustic without speakers.jsonl", t, best_mapping=True)
        self.assertEqual(len(t["speakers"]), 3)
        self.assertGreaterEqual(acc, 0.9)

    # ---- 4: live

    def test_4_live_growing_audio(self):
        mid = fx.new_meeting_id()
        d = os.path.join(self.host, "meetings", mid)
        os.makedirs(d)
        pcm = fx.to_s16(fx.read_wav(os.path.join(FIXTURES, "dialog.wav")))
        bot = self.dummy_bot(d)
        fx.write_json(os.path.join(d, "config.json"), fx.bot_config(mid))
        fx.write_json(os.path.join(d, "state.json"), fx.bot_state(mid, phase="joining", pid=bot.pid))
        speed, lag = 4.0, 100
        info = {}

        def writer():
            time.sleep(1.5)
            rec_start = int(time.time() * 1000)
            st = fx.bot_state(mid, phase="in_meeting", pid=bot.pid, rec_start_ms=rec_start)
            fx.write_json(os.path.join(d, "state.json"), st)
            events = fx.speaker_events(self.gt, rec_start_ms=rec_start, lag_ms=lag, lag_field=True)
            chunk, ei, last_state = SR // 10 * 2, 0, 0.0
            with open(os.path.join(d, "audio.pcm"), "ab") as f, \
                    open(os.path.join(d, "speakers.jsonl"), "a", encoding="utf-8") as sf:
                for off in range(0, len(pcm), chunk):
                    f.write(pcm[off:off + chunk])
                    f.flush()
                    audio_t = (off + chunk) / 2 / SR
                    while ei < len(events) and (events[ei]["t"] - lag - rec_start) / 1000 <= audio_t:
                        sf.write(json.dumps(events[ei], ensure_ascii=False) + "\n")
                        sf.flush()
                        ei += 1
                    if audio_t - last_state >= 1.0:
                        last_state = audio_t
                        st["audio"] = {"seconds": audio_t, "bytes": off + chunk}
                        fx.write_json(os.path.join(d, "state.json"), st)
                    time.sleep(0.1 / speed)
                for ev in events[ei:]:
                    sf.write(json.dumps(ev, ensure_ascii=False) + "\n")
            info["writer_done"] = time.monotonic()
            time.sleep(0.5)
            self.set_bot_phase(d, "ended")
            bot.kill()

        started = time.monotonic()
        p = self.start(d, "live")
        w = threading.Thread(target=writer, daemon=True)
        w.start()
        phases, counts_during_writing = set(), []
        while p.poll() is None and time.monotonic() - started < 180:
            st = read_json(os.path.join(d, "transcriber.json"))
            if st:
                phases.add(st["phase"])
            if "writer_done" not in info:
                counts_during_writing.append(len(read_jsonl(os.path.join(d, "segments.jsonl"))))
            time.sleep(0.2)
        code = p.wait(timeout=5)
        w.join(timeout=5)
        took = time.monotonic() - started
        self.assertEqual(code, 0, self.log_text(d)[-3000:])
        t = self.transcript(d)
        acc, _, rec = self.report("live, 4x real time", t)
        print(f"  live: phases seen {sorted(phases)}, segments while recording {max(counts_during_writing)}, "
              f"finished {took - (info['writer_done'] - started):.1f}s after the recording", file=sys.stderr)
        self.assertIn("waiting_audio", phases)
        self.assertIn("live", phases)
        self.assertGreaterEqual(max(counts_during_writing), 6, "segments.jsonl must grow during the recording")
        self.assertGreaterEqual(acc, 0.95)
        self.assertGreaterEqual(rec, 0.7)
        live = read_jsonl(os.path.join(d, "segments.jsonl"))
        self.assertEqual([s["id"] for s in live], [s["id"] for s in t["segments"]])
        live_acc, _ = speaker_accuracy(self.gt, live)
        self.assertGreaterEqual(live_acc, 0.85, "live (provisional) speakers")
        self.assertFalse(os.path.exists(os.path.join(d, "audio.pcm")))

    # ---- 5: resume

    def test_5_resume_after_sigterm(self):
        d = self.meeting(lag_field=True, transcriber={"keepRawAudio": True})
        bot = self.dummy_bot(d)
        self.set_bot_phase(d, "in_meeting", pid=bot.pid)
        p = self.start(d, "live")
        seg_path = os.path.join(d, "segments.jsonl")
        self.wait_for(lambda: len(read_jsonl(seg_path)) >= 4, 60, "4 live segments")
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(timeout=30), 0)
        st = read_json(os.path.join(d, "transcriber.json"))
        self.assertNotEqual(st["phase"], "done")
        self.assertIn("interrupted", st["detail"])
        first_run = read_jsonl(seg_path)
        cp = st["checkpoint"]
        self.assertGreaterEqual(cp["nextId"], 4)
        self.assertGreaterEqual(len(first_run), cp["nextId"])
        print(f"\n  resume: stopped after {len(first_run)} segments, checkpoint {cp}", file=sys.stderr)
        # Simulate a crash mid-write: a segment past the checkpoint and a torn line.
        with open(seg_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": cp["nextId"], "start": 99.0, "end": 99.5, "speakerKey": "unknown",
                                "speaker": "Неизвестный", "source": "none", "text": "дубликат"}) + "\n")
            f.write('{"id": 999, "start": 1')
        bot.kill()
        bot.wait()
        self.set_bot_phase(d, "in_meeting")  # not terminal, but the pid is dead
        code, _ = self.run_to_end(d, "live")
        self.assertEqual(code, 0, self.log_text(d)[-3000:])
        t = self.transcript(d)
        acc, cov, rec = self.report("resumed after SIGTERM", t)
        segs = t["segments"]
        self.assertEqual([s["id"] for s in segs], list(range(len(segs))))
        self.assertNotIn("дубликат", " ".join(s["text"] for s in segs))
        for a, b in zip(segs, segs[1:]):
            self.assertGreaterEqual(b["start"], a["end"] - 0.01, f"overlap/duplicate: {a} {b}")
        for s in first_run[:cp["nextId"]]:
            self.assertEqual(s["text"], segs[s["id"]]["text"])
        for g in self.gt:  # no gaps: every utterance is covered
            covered = sum(max(0.0, min(s["end"], g["end"]) - max(s["start"], g["start"])) for s in segs)
            self.assertGreater(covered / (g["end"] - g["start"]), 0.8, g)
        self.assertGreaterEqual(acc, 0.95)
        self.assertGreaterEqual(rec, 0.7)
        self.assertTrue(os.path.exists(os.path.join(d, "audio.pcm")), "keepRawAudio keeps audio.pcm")

    def test_5b_offline_keeps_raw_audio(self):
        # keepRawAudio: re-transcription reads the kept lossless audio.pcm and leaves it alone.
        d = self.meeting(audio="both", lag_field=True, transcriber={"keepRawAudio": True})
        pcm_path = os.path.join(d, "audio.pcm")
        with open(pcm_path, "rb") as f:
            raw = f.read()
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0, self.log_text(d)[-3000:])
        t = self.transcript(d)
        _, _, rec = self.report("offline from the kept audio.pcm", t)
        self.assertGreaterEqual(rec, 0.7)
        self.assertIn("transcribing the recorded audio.pcm", self.log_text(d))
        with open(pcm_path, "rb") as f:
            self.assertTrue(f.read() == raw, "the kept audio.pcm must stay as recorded")
        self.assertFalse(os.path.exists(os.path.join(d, "audio.decoded.pcm")))
        # audio.pcm shorter than the bot recorded: audio.ogg is decoded beside it, audio.pcm untouched.
        d = self.meeting(audio="both", lag_field=True, transcriber={"keepRawAudio": True})
        pcm_path = os.path.join(d, "audio.pcm")
        with open(pcm_path, "r+b") as f:
            f.truncate(len(raw) // 2)
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0, self.log_text(d)[-3000:])
        t = self.transcript(d)
        self.assertIn("decoded audio.ogg -> audio.decoded.pcm", self.log_text(d))
        self.assertGreater(t["audioSec"], 0.9 * len(raw) / 2 / SR)
        self.assertEqual(os.path.getsize(pcm_path), len(raw) // 2)
        self.assertFalse(os.path.exists(os.path.join(d, "audio.decoded.pcm")))

    # ---- 6: GigaAM outages

    def test_6_gigaam_recovers_via_gigaam_json(self):
        d = self.meeting(lag_field=True)
        dead = f"http://127.0.0.1:{free_port()}"
        discovery = os.path.join(self.host, "gigaam.json")
        fx.write_json(discovery, {"url": dead})
        p = self.start(d, "offline", gigaam=False)
        state_path = os.path.join(d, "transcriber.json")
        st = self.wait_for(lambda: (s := read_json(state_path)) and s["phase"] == "waiting_asr" and s, 30,
                           "phase waiting_asr")
        self.assertIn("GigaAM", st["detail"])
        time.sleep(2.0)
        self.assertIsNone(p.poll())
        fx.write_json(discovery, {"url": GIGAAM})
        self.assertEqual(p.wait(timeout=120), 0)
        t = self.transcript(d)
        _, _, rec = self.report("GigaAM fixed via gigaam.json", t)
        self.assertGreaterEqual(rec, 0.7)
        self.assertIn("gigaam.json now points to", self.log_text(d))

    def test_6b_cli_url_fails_over_and_http_errors(self):
        # Dead --gigaam-url: falls over to gigaam.json at once.
        d = self.meeting(lag_field=True)
        fx.write_json(os.path.join(self.host, "gigaam.json"), {"url": GIGAAM})
        dead = f"http://127.0.0.1:{free_port()}"
        code, _ = self.run_to_end(d, gigaam=False, extra=["--gigaam-url", dead])
        self.assertEqual(code, 0)
        self.assertGreaterEqual(len(self.transcript(d)["segments"]), 10)
        self.assertIn("switching to", self.log_text(d))

        # 503 twice (retried, nothing lost), then one 400 (that piece is skipped).
        calls = {"n": 0, "forwarded": []}

        class Proxy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                calls["n"] += 1
                if calls["n"] <= 2:
                    return self._send(503, b'{"detail": "not ready"}')
                if calls["n"] == 4:  # calls 1-3: the first piece; 4: the second
                    return self._send(400, b'{"detail": "bad audio"}')
                # This fixture tests retryable/piece-specific HTTP failures,
                # independently of the live server's legacy route support.
                # Current managed GigaAM exposes only the canonical endpoint.
                upstream_path = "/v1/audio/transcriptions" if self.path == "/transcribe" else self.path
                calls["forwarded"].append(upstream_path)
                req = urllib.request.Request(GIGAAM + upstream_path, data=body, method="POST",
                                             headers={"Content-Type": self.headers["Content-Type"]})
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                try:
                    with opener.open(req, timeout=60) as r:
                        self._send(r.status, r.read())
                except urllib.error.HTTPError as error:
                    # Forward status/body instead of terminating the socket:
                    # an EOF would test network retries, hiding the HTTP error.
                    with error:
                        self._send(error.code, error.read())

            def do_GET(self):
                self._send(200, b'{"ready": true, "model": "stub"}')

            def _send(self, code, data):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            d = self.meeting(lag_field=True)
            os.remove(os.path.join(self.host, "gigaam.json"))
            code, _ = self.run_to_end(d, gigaam=False, extra=["--gigaam-url", f"http://127.0.0.1:{server.server_port}"])
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(code, 0)
        t = self.transcript(d)
        self.assertEqual(t["asr"]["model"], "stub")
        texts = [s["text"] for s in t["segments"]]
        self.assertTrue(texts[0].startswith("Добрый день"), "the 503'd piece was retried, not dropped")
        self.assertFalse(any("Здравствуйте" in x for x in texts), "the 400'd piece is skipped")
        self.assertIn("HTTP 400", self.log_text(d))
        self.assertEqual(len(texts), 11)
        self.assertEqual(set(calls["forwarded"]), {"/v1/audio/transcriptions"})

    # ---- 7-8: degraded modes

    def test_7_ui_mode_and_missing_speaker_model(self):
        d = self.meeting(lag_field=True, transcriber={"diarization": "ui"})
        code, _ = self.run_to_end(d)
        self.assertEqual(code, 0)
        t = self.transcript(d)
        acc, _, _ = self.report("diarization ui", t)
        self.assertEqual(t["diarization"], "ui")
        self.assertTrue(all(s["source"] == "ui" for s in t["segments"]))
        self.assertFalse(os.path.exists(os.path.join(d, "embeddings.jsonl")))
        self.assertNotIn("speaker embeddings:", self.log_text(d))
        self.assertGreaterEqual(acc, 0.95)

        models = os.path.join(self.host, "models-vad-only")
        os.makedirs(models)
        os.symlink(os.path.join(MODELS, tr.VAD_MODEL_FILE), os.path.join(models, tr.VAD_MODEL_FILE))
        d = self.meeting(lag_field=True)
        code, _ = self.run_to_end(d, models=models)
        self.assertEqual(code, 0)
        t = self.transcript(d)
        acc, _, rec = self.report("no speaker model", t)
        self.assertEqual(t["diarization"], "ui")
        self.assertIn("speaker model", self.log_text(d))
        self.assertIn("VAD: silero", self.log_text(d))
        self.assertGreaterEqual(acc, 0.95)
        self.assertGreaterEqual(rec, 0.7)

    def test_8_no_sherpa_fallback(self):
        d = self.meeting(lag_field=True)
        code, _ = self.run_to_end(d, env=self.env(MEETINGS_DISABLE_SHERPA="1"))
        self.assertEqual(code, 0)
        t = self.transcript(d)
        acc, _, rec = self.report("MEETINGS_DISABLE_SHERPA=1", t)
        self.assertIn("VAD: energy", self.log_text(d))
        self.assertEqual(t["diarization"], "ui")
        self.assertGreaterEqual(acc, 0.9)
        self.assertGreaterEqual(rec, 0.7)

        # A real import failure: a broken sherpa_onnx module shadows the installed one.
        fake = os.path.join(self.host, "fake-site")
        os.makedirs(fake)
        with open(os.path.join(fake, "sherpa_onnx.py"), "w") as f:
            f.write("raise ImportError('simulated: libonnxruntime.so missing')\n")
        d = self.meeting(lag_field=True)
        boot = ("import runpy, sys; sys.path.insert(0, sys.argv[1]); sys.argv = sys.argv[2:]; "
                "runpy.run_path(sys.argv[0], run_name='__main__')")
        argv = [sys.executable, "-I", "-c", boot, fake] + self.cmd(d, "offline")[2:]
        code, _ = self.run_to_end(d, argv=argv)
        self.assertEqual(code, 0)
        t = self.transcript(d)
        acc, _, _ = self.report("sherpa_onnx import failure", t)
        self.assertIn("simulated: libonnxruntime.so missing", self.log_text(d))
        self.assertIn("VAD: energy", self.log_text(d))
        self.assertGreaterEqual(acc, 0.9)

    def test_9_failures_are_reported(self):
        d = os.path.join(self.host, "meetings", fx.new_meeting_id())
        os.makedirs(d)
        code, _ = self.run_to_end(d, "offline")
        self.assertEqual(code, 1)
        st = read_json(os.path.join(d, "transcriber.json"))
        self.assertEqual(st["phase"], "failed")
        self.assertIn("no audio", st["error"])
        # Live mode, the bot failed (or was stopped) before recording anything: no hang, and
        # no transcript (an empty final one would make the server report the meeting as done)
        # and no transcriber.json, as if live transcription had not run.
        for pcm in ("missing", "empty"):
            d = self.meeting(lag_field=True)
            if pcm == "missing":
                os.remove(os.path.join(d, "audio.pcm"))
            else:
                open(os.path.join(d, "audio.pcm"), "wb").close()
            st = read_json(os.path.join(d, "state.json"))
            fx.write_json(os.path.join(d, "state.json"), dict(st, audio={"seconds": 0, "bytes": 0}))
            self.set_bot_phase(d, "failed")
            code, _ = self.run_to_end(d, "live", timeout=30)
            self.assertEqual(code, 0, self.log_text(d)[-3000:])
            self.assertIn("nothing was recorded", self.log_text(d))
            for name in ("transcript.json", "transcript.md", "transcript.txt", "transcriber.json"):
                self.assertFalse(os.path.exists(os.path.join(d, name)), f"{pcm} audio.pcm: {name}")
        # The bot recorded audio but audio.pcm is gone: finalize what there is (nothing here).
        d = self.meeting(lag_field=True)
        os.remove(os.path.join(d, "audio.pcm"))
        self.set_bot_phase(d, "failed")
        code, _ = self.run_to_end(d, "live", timeout=30)
        self.assertEqual(code, 0)
        self.assertEqual(self.transcript(d)["segments"], [])


# ----------------------------------------------------------------------------- scale (opt-in)


@unittest.skipUnless(os.environ.get("MEETINGS_TEST_LONG") == "1", "set MEETINGS_TEST_LONG=1")
class ScaleTest(unittest.TestCase):
    """3 hours of audio through the live path with an instant stub ASR: memory stays bounded."""

    def test_three_hours_live(self):
        ensure_fixtures()
        host = tempfile.mkdtemp(prefix="scale-", dir=RUNS)
        try:
            self._run(host)
        finally:
            if os.environ.get("MEETINGS_TEST_KEEP") != "1":
                shutil.rmtree(host, ignore_errors=True)

    def _run(self, host):
        class Stub(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                data = json.dumps({"text": "проверка связи"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        mid = fx.new_meeting_id()
        d = os.path.join(host, "meetings", mid)
        fx.make_meeting_dir(d, FIXTURES, meeting_id=mid, lag_field=True)
        gt = fx.load_gt(FIXTURES)
        with open(os.path.join(d, "audio.pcm"), "rb") as f:
            one = f.read()
        reps = int(3 * 3600 * SR * 2 / len(one)) + 1
        rec = read_json(os.path.join(d, "state.json"))["recordingStartedAt"]
        dur = len(one) / 2 / SR
        with open(os.path.join(d, "audio.pcm"), "wb") as f:
            for _ in range(reps):
                f.write(one)
        with open(os.path.join(d, "speakers.jsonl"), "w", encoding="utf-8") as f:
            for r in range(reps):
                for ev in fx.speaker_events(gt, rec_start_ms=rec + r * dur * 1000, lag_ms=0, lag_field=True):
                    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        argv = [sys.executable, "-I", TRANSCRIBER, "--meeting-dir", d, "--mode", "live", "--models-dir", MODELS,
                "--gigaam-url", f"http://127.0.0.1:{server.server_port}", "--threads", "4"]
        started = time.monotonic()
        with open(os.path.join(d, "transcriber.log"), "wb") as log:
            p = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT)
        peak = 0
        while p.poll() is None:
            try:
                with open(f"/proc/{p.pid}/status") as f:
                    for line in f:
                        if line.startswith("VmHWM:"):
                            peak = max(peak, int(line.split()[1]))
            except OSError:
                pass
            time.sleep(1)
        server.shutdown()
        server.server_close()
        took = time.monotonic() - started
        t = read_json(os.path.join(d, "transcript.json"))
        print(f"\n  3h live: {took:.0f}s wall, peak RSS {peak / 1024:.0f} MB, {len(t['segments'])} segments, "
              f"speakers {[(sp['label'], sp['talkSec']) for sp in t['speakers']]}", file=sys.stderr)
        self.assertEqual(p.returncode, 0)
        self.assertLess(peak / 1024, 600)
        self.assertEqual(len(t["speakers"]), 3)


class VoiceRecognitionTests(unittest.TestCase):
    """Known voices (host-data/voices.json) name the clusters of a new meeting."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="voices-")
        rng = np.random.default_rng(11)
        self.anna, self.boris, self.vera = (tr.unit(rng.normal(size=32)) for _ in range(3))
        self.rng = rng

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def near(self, voice, noise):
        return tr.unit(voice + noise * self.rng.normal(size=32))

    def test_load_voices_reads_names_and_skips_broken_entries(self):
        path = os.path.join(self.tmp, "voices.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "voices": [
                {"name": "Анна", "embedding": tr.encode_embedding(self.anna), "seconds": 40},
                {"name": "", "embedding": tr.encode_embedding(self.boris)},
                {"name": "Сломан", "embedding": "not base64!"},
                "x",
            ]}, f)
        voices = tr.load_voices(path)
        self.assertEqual([name for name, _, _ in voices], ["Анна"])
        self.assertAlmostEqual(float(voices[0][1] @ self.anna), 1.0, places=5)
        self.assertEqual(tr.load_voices(os.path.join(self.tmp, "missing.json")), [])

    def test_match_voices_names_the_clusters_it_knows(self):
        centroids = {0: (self.near(self.anna, 0.1), 60.0), 1: (self.near(self.vera, 0.1), 45.0), 2: (self.near(self.boris, 0.1), 30.0)}
        voices = [("Анна", self.anna), ("Борис", self.boris)]
        self.assertEqual(tr.match_voices(centroids, voices), {0: "Анна", 2: "Борис"})

    def test_match_voices_refuses_weak_ambiguous_and_short_matches(self):
        # Below the threshold: a different person.
        self.assertEqual(tr.match_voices({0: (self.vera, 60.0)}, [("Анна", self.anna)]), {})
        # Two known voices equally close: no guess.
        between = tr.unit(self.anna + self.boris)
        self.assertEqual(tr.match_voices({0: (between, 60.0)}, [("Анна", self.anna), ("Борис", self.boris)]), {})
        # Too little speech to trust the cluster.
        self.assertEqual(tr.match_voices({0: (self.anna, 9.0)}, [("Анна", self.anna)]), {})

    def test_load_voices_reads_the_roster_a_voice_was_learned_with(self):
        path = os.path.join(self.tmp, "voices.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "voices": [{"name": "Анна", "embedding": tr.encode_embedding(self.anna), "roster": ["a@x.io", "b@x.io", 7]}]}, f)
        self.assertEqual(tr.load_voices(path)[0][2], frozenset({"a@x.io", "b@x.io"}))

    def test_voice_expected_needs_half_of_the_meetings_roster(self):
        team = ["a@x.io", "b@x.io", "c@x.io", "d@x.io"]
        self.assertTrue(tr.voice_expected({"a@x.io", "b@x.io", "z@x.io"}, team))
        self.assertFalse(tr.voice_expected({"a@x.io", "z@x.io"}, team))
        self.assertFalse(tr.voice_expected({"a@x.io"}, []))
        self.assertFalse(tr.voice_expected(set(), team))

    def test_match_voices_eases_the_match_for_a_voice_the_calendar_expects(self):
        # 0.62 similar: not enough for a stranger, enough for someone from this meeting's roster.
        other = tr.unit(self.rng.normal(size=32))
        other = tr.unit(other - (other @ self.anna) * self.anna)
        centroid = tr.unit(0.62 * self.anna + (1 - 0.62 ** 2) ** 0.5 * other)
        self.assertAlmostEqual(float(centroid @ self.anna), 0.62, places=4)
        team = ["a@x.io", "b@x.io", "c@x.io"]
        stranger = [("Анна", self.anna, frozenset({"q@y.io"}))]
        teammate = [("Анна", self.anna, frozenset({"a@x.io", "b@x.io"}))]
        self.assertEqual(tr.match_voices({0: (centroid, 60.0)}, stranger, team), {})
        self.assertEqual(tr.match_voices({0: (centroid, 60.0)}, teammate, team), {0: "Анна"})
        self.assertEqual(tr.match_voices({0: (centroid, 60.0)}, teammate, []), {})
        # Even an expected voice is refused below its own threshold.
        weak = tr.unit(0.57 * self.anna + (1 - 0.57 ** 2) ** 0.5 * other)
        self.assertEqual(tr.match_voices({0: (weak, 60.0)}, teammate, team), {})

    def test_match_voices_gives_a_voice_to_one_cluster_only(self):
        centroids = {0: (self.near(self.anna, 0.25), 60.0), 1: (self.near(self.anna, 0.05), 60.0)}
        self.assertEqual(tr.match_voices(centroids, [("Анна", self.anna)]), {1: "Анна"})

    def test_cluster_centroids_weigh_pieces_by_duration(self):
        X = np.stack([self.anna, self.boris, self.boris]).astype(np.float32)
        centroids = tr.cluster_centroids(X, [30.0, 5.0, 7.0], [0, 1, 1])
        self.assertEqual(sorted(centroids), [0, 1])
        self.assertEqual(centroids[0][1], 30.0)
        self.assertEqual(centroids[1][1], 12.0)
        self.assertAlmostEqual(float(centroids[1][0] @ self.boris), 1.0, places=5)

    def test_decide_speakers_uses_voice_names_but_not_over_the_owner(self):
        segments = [{"start": 0.0, "end": 4.0}, {"start": 4.0, "end": 8.0}, {"start": 8.0, "end": 12.0}]
        coverages = [{"Я": 1.0}, {}, {}]
        out = tr.decide_speakers(segments, coverages, [0, 1, 2], "ui+acoustic", voice_names={0: "Анна", 1: "Борис"})
        self.assertEqual(out, [("ui:Я", "Я", "ui"), ("voice:Борис", "Борис", "voice"), ("spk:1", "Спикер 1", "acoustic")])
        acoustic = tr.decide_speakers(segments, [{}, {}, {}], [0, 1, 2], "acoustic", voice_names={1: "Борис"})
        self.assertEqual([label for _, label, _ in acoustic], ["Спикер 1", "Борис", "Спикер 2"])


class LocalRecordingTests(unittest.TestCase):
    """Local recording (DESIGN §15): engine selection, mic→owner attribution, serialized Whisper calls."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="local-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _synthetic_local_meeting(self):
        """Owner sine at 1-3 s and 7-9 s, remote sine at 4-6 s; audio.pcm = the mix.
        A 1 s leading silence lets the energy VAD estimate its floor on silence."""
        d = os.path.join(self.tmp, "mtg_local0002")
        os.makedirs(d)
        sr = tr.SAMPLE_RATE
        total = 9.0
        n = int(total * sr)
        t = np.arange(n) / sr
        owner = np.zeros(n, dtype=np.float32)
        remote = np.zeros(n, dtype=np.float32)
        for a, b in ((1.0, 3.0), (7.0, 9.0)):
            seg = np.arange(int(a * sr), int(b * sr))
            owner[seg] = (0.5 * np.sin(2 * np.pi * 440 * t[seg])).astype(np.float32)
        for a, b in ((4.0, 6.0),):
            seg = np.arange(int(a * sr), int(b * sr))
            remote[seg] = (0.5 * np.sin(2 * np.pi * 440 * t[seg])).astype(np.float32)
        mix = np.clip(owner + remote, -1.0, 1.0)
        for name, x in (("mic.pcm", owner), ("system.pcm", remote), ("audio.pcm", mix)):
            with open(os.path.join(d, name), "wb") as f:
                f.write((x * 32767.0).astype(np.int16).tobytes())
        cfg = {
            "version": 1, "meetingId": "mtg_local0002", "platform": "local",
            "sourceApp": "zoom", "sourceLabel": "Zoom", "url": "local://zoom", "ownerName": "Я", "createdAt": 0,
            "transcriber": {"gigaamUrl": None, "diarization": "ui+acoustic", "speakerLagMs": 700,
                            "keepRawAudio": True, "threads": 0, "engine": "whisper", "language": "ru",
                            "glossary": "", "ownerName": "Я"},
        }
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        with open(os.path.join(d, "state.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "meetingId": "mtg_local0002", "pid": 123, "phase": "ended",
                       "recordingStartedAt": 0, "audio": {"seconds": total, "bytes": n * 2}}, f)
        return d


    def _local_args(self, d, mode):
        return types.SimpleNamespace(meeting_dir=d, mode=mode, models_dir="", gigaam_url=None, host_data="", threads=None)

    def test_offline_local_attribution_owner_remote_owner(self):
        d = self._synthetic_local_meeting()

        def impl(audio, language, initial_prompt):
            return "слово"

        self.assertEqual(tr.Transcriber(self._local_args(d, "offline"), whisper_impl=impl).run(), 0)
        transcript = read_json(os.path.join(d, "transcript.json"))
        self.assertIsNotNone(transcript)
        self.assertEqual(transcript["asr"]["engine"], "whisper")
        labels = [s["speaker"] for s in transcript["segments"]]
        self.assertGreaterEqual(len(labels), 3, labels)
        self.assertEqual(labels[0], "Я")
        self.assertNotEqual(labels[1], "Я")
        self.assertEqual(labels[2], "Я")

    def test_offline_local_with_loudspeakers_keeps_the_remote_side_out_of_the_owner(self):
        """The microphone hears the remote side as loud as the owner (loudspeakers). The two-stream
        pass gives the remote side to the system stream only and the owner two pieces, not three."""
        d = self._synthetic_local_meeting()
        sr = tr.SAMPLE_RATE
        rng = np.random.default_rng(5)
        n = 30 * sr
        remote = np.zeros(n, dtype=np.float32)
        remote[10 * sr:20 * sr] = (0.3 * rng.normal(size=10 * sr)).astype(np.float32)
        owner = np.zeros(n, dtype=np.float32)
        t = np.arange(3 * sr) / sr
        for a in (3, 24):
            owner[a * sr:(a + 3) * sr] = (0.3 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
        mic = owner.copy()
        mic[1600:] += 0.8 * remote[:n - 1600]
        for name, x in (("mic.pcm", mic), ("system.pcm", remote), ("audio.pcm", np.clip(mic + remote, -1, 1))):
            with open(os.path.join(d, name), "wb") as f:
                f.write((np.clip(x, -1, 1) * 32767.0).astype(np.int16).tobytes())

        def impl(audio, language, initial_prompt):
            return "слово"

        self.assertEqual(tr.Transcriber(self._local_args(d, "offline"), whisper_impl=impl).run(), 0)
        segments = read_json(os.path.join(d, "transcript.json"))["segments"]
        mine = [(round(s["start"]), round(s["end"])) for s in segments if s["speaker"] == "Я"]
        self.assertEqual(mine, [(3, 6), (24, 27)])
        others = [s for s in segments if s["speaker"] != "Я"]
        self.assertGreaterEqual(len(others), 1)
        self.assertTrue(all(9.5 <= s["start"] and s["end"] <= 20.5 for s in others), others)
        self.assertFalse(os.path.exists(os.path.join(d, "owner.pcm")))

    def test_asr_prompt_joins_the_glossary_with_calendar_hints(self):
        self.assertEqual(tr.asr_prompt("Kubernetes, деплой", ["Анна Смирнова", "Планёрка Matcher", "Анна Смирнова", " "]),
                         "Kubernetes, деплой, Анна Смирнова, Планёрка Matcher")
        self.assertEqual(tr.asr_prompt("", []), "")
        self.assertEqual(len(tr.asr_prompt("я" * 900, ["Анна"])), 600)

    def test_offline_local_uses_calendar_hints_and_the_final_model(self):
        """The final pass prompts Whisper with the glossary plus the hints written after the
        calendar answered, and runs the model configured for the final transcript."""
        d = self._synthetic_local_meeting()
        cfg = read_json(os.path.join(d, "config.json"))
        cfg["transcriber"].update(glossary="Kubernetes", hints=["Анна Смирнова"], whisperModel="/models/turbo", whisperFinalModel="/models/large")
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        prompts = []

        def impl(audio, language, initial_prompt):
            prompts.append(initial_prompt)
            return "слово"

        t = tr.Transcriber(self._local_args(d, "offline"), whisper_impl=impl)
        self.assertEqual(t.run(), 0)
        self.assertEqual(set(prompts), {"Kubernetes, Анна Смирнова"})
        self.assertEqual(read_json(os.path.join(d, "transcript.json"))["asr"]["model"], "/models/large")

    def test_source_split_offsets_owner_then_remote(self):
        """One continuous stretch: the owner in 0-2 s, the remote side in 2-4 s -> one cut at 2 s."""
        sr = tr.SAMPLE_RATE
        t = np.arange(4 * sr) / sr
        tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        mic = tone.copy()
        mic[2 * sr:] = 0.0
        system = 0.4 * tone
        system[:2 * sr] = 0.0
        self.assertEqual(tr.source_split_offsets(mic, system), [32000])
        # A single source throughout, and a 0.3 s interjection, are not split.
        self.assertEqual(tr.source_split_offsets(tone, np.zeros_like(tone)), [])
        blip = np.zeros_like(tone)
        blip[int(1.0 * sr):int(1.3 * sr)] = 0.9
        self.assertEqual(tr.source_split_offsets(0.2 * tone, blip), [])

    def test_offline_local_back_to_back_speakers_are_split(self):
        """The owner in 1-3 s and the remote side in 3-5 s with no pause: two segments, owner then remote."""
        d = self._synthetic_local_meeting()
        sr = tr.SAMPLE_RATE
        n = 6 * sr
        t = np.arange(n) / sr
        tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        owner = np.zeros(n, dtype=np.float32)
        remote = np.zeros(n, dtype=np.float32)
        owner[1 * sr:3 * sr] = tone[1 * sr:3 * sr]
        remote[3 * sr:5 * sr] = 0.8 * tone[3 * sr:5 * sr]
        for name, x in (("mic.pcm", owner), ("system.pcm", remote), ("audio.pcm", np.clip(owner + remote, -1.0, 1.0))):
            with open(os.path.join(d, name), "wb") as f:
                f.write((x * 32767.0).astype(np.int16).tobytes())

        def impl(audio, language, initial_prompt):
            return "слово"

        self.assertEqual(tr.Transcriber(self._local_args(d, "offline"), whisper_impl=impl).run(), 0)
        segments = read_json(os.path.join(d, "transcript.json"))["segments"]
        self.assertEqual(len(segments), 2, segments)
        self.assertEqual(segments[0]["speaker"], "Я")
        self.assertNotEqual(segments[1]["speaker"], "Я")
        self.assertAlmostEqual(segments[0]["end"], 3.0, delta=0.15)
        self.assertAlmostEqual(segments[1]["start"], 3.0, delta=0.15)

    def test_local_final_mode_keeps_owner_attribution(self):
        """The bot-oriented "acoustic" setting must not drop the microphone-based owner label."""
        self.assertEqual(tr.local_final_mode("acoustic"), "ui+acoustic")
        self.assertEqual(tr.local_final_mode("ui+acoustic"), "ui+acoustic")
        self.assertEqual(tr.local_final_mode("ui"), "ui")
        segments = [{"start": 0.0, "end": 4.0}, {"start": 4.0, "end": 8.0}, {"start": 8.0, "end": 12.0}]
        coverages = [{"Я": 1.0}, {}, {"Я": 1.0}]
        labels = [label for _, label, _ in tr.decide_speakers(segments, coverages, [0, 1, 0], tr.local_final_mode("acoustic"))]
        self.assertEqual(labels, ["Я", "Спикер 1", "Я"])

    def test_owner_coverage_follows_the_voice_not_single_loud_pieces(self):
        """Sound from the speakers reaches the microphone, so a few pieces of a remote
        voice look like the owner's. A voice is the owner's only when most of it came
        through the microphone; every piece then follows its voice."""
        #            owner's voice (cluster 0)      remote voice (cluster 1)        no embedding
        mic_loud = [True, True, False,              True, False, False, False,      True, False]
        clusters = [0, 0, 0,                        1, 1, 1, 1,                     None, None]
        durations = [5.0, 5.0, 4.0,                 3.0, 6.0, 6.0, 6.0,             1.0, 1.0]
        self.assertEqual(
            tr.owner_coverage(mic_loud, clusters, durations),
            [True, True, True,                      False, False, False, False,     True, False],
        )
        # Exactly half through the microphone is not enough to call a voice the owner's.
        self.assertEqual(tr.owner_coverage([True, False], [0, 0], [5.0, 5.0]), [False, False])
        self.assertEqual(tr.owner_coverage([True, False], [0, 0], [5.1, 5.0]), [True, True])

    def test_local_final_speakers_do_not_merge_remote_voices_into_the_owner(self):
        segments = [{"start": float(i), "end": float(i + 1)} for i in range(6)]
        mic_loud = [True, True, True, False, False, False]
        clusters = [0, 0, 1, 1, 1, 1]
        owner = tr.owner_coverage(mic_loud, clusters, [5.0, 5.0, 3.0, 6.0, 6.0, 6.0])
        coverages = [{"Я": 1.0} if flag else {} for flag in owner]
        labels = [label for _, label, _ in tr.decide_speakers(segments, coverages, clusters, "ui+acoustic")]
        self.assertEqual(labels, ["Я", "Я", "Спикер 1", "Спикер 1", "Спикер 1", "Спикер 1"])

    def test_cluster_anchored_groups_short_pieces_with_long_ones(self):
        """Three voices; long pieces are clean, short pieces are noisy. Clustering every piece at the
        default threshold scatters the short ones; anchoring on the long ones gives three speakers."""
        rng = np.random.default_rng(7)
        dim = 32
        voices = [tr.unit(rng.normal(size=dim)) for _ in range(3)]
        rows, durations, truth = [], [], []
        for k, voice in enumerate(voices):
            for _ in range(5):
                rows.append(tr.unit(voice + 0.05 * rng.normal(size=dim)))
                durations.append(6.0)
                truth.append(k)
            for _ in range(6):
                rows.append(tr.unit(voice + 0.22 * rng.normal(size=dim)))
                durations.append(1.5)
                truth.append(k)
        X = np.stack(rows).astype(np.float32)
        self.assertGreater(int(tr.agglomerative(X, tr.DEFAULT_CLUSTER_THRESHOLD).max()) + 1, 3)
        labels = tr.cluster_anchored(X, durations)
        self.assertEqual([int(v) for v in labels], truth)

    def test_cluster_anchored_leaves_a_piece_unlike_every_voice_without_one(self):
        """Review round 6: a short participant must not be folded into another person's voice,
        nor into the owner."""
        X = np.array([[1, 0], [1, 0], [0, 1]], dtype=np.float32)
        labels = tr.cluster_anchored(X, [6.0, 6.0, 4.0])
        self.assertEqual([int(v) for v in labels], [0, 0, -1])
        self.assertEqual(tr.owner_coverage([True, True, False], [0, 0, -1], [6.0, 6.0, 4.0]), [True, True, False])
        self.assertEqual(sorted(tr.cluster_centroids(X, [6.0, 6.0, 4.0], labels)), [0])

    def test_decide_speakers_keeps_a_stranger_unknown_and_marks_inherited_voice_names(self):
        segments = [{"start": 0.0, "end": 4.0}, {"start": 4.0, "end": 5.0}, {"start": 5.0, "end": 6.0}]
        decided = tr.decide_speakers(segments, [{}, {}, {}], [0, -1, None], "ui+acoustic", {0: "Анна"})
        self.assertEqual(decided, [("voice:Анна", "Анна", "voice"), ("unknown", "Неизвестный", "none"), ("unknown", "Неизвестный", "none")])
        # A piece too short for an embedding follows the voice before it, but is not itself a voice match.
        decided = tr.decide_speakers(segments[:2], [{}, {}], [0, None], "ui+acoustic", {0: "Анна"})
        self.assertEqual(decided, [("voice:Анна", "Анна", "voice"), ("voice:Анна", "Анна", "mixed")])

    def _echo_case(self, echo=0.6, lag=1600, seconds=30):
        """System: speech-like noise bursts. Microphone: the owner's tone at 12-15 s plus the
        system audio delayed by lag and scaled by echo."""
        sr = tr.SAMPLE_RATE
        rng = np.random.default_rng(3)
        n = seconds * sr
        system = np.zeros(n, dtype=np.float32)
        for a, b in ((2, 10), (16, 28)):
            system[a * sr:b * sr] = (0.2 * rng.normal(size=(b - a) * sr)).astype(np.float32)
        owner = np.zeros(n, dtype=np.float32)
        t = np.arange(3 * sr) / sr
        owner[12 * sr:15 * sr] = (0.2 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
        mic = owner.copy()
        mic[lag:] += echo * system[:n - lag]
        return mic, system, owner

    def test_estimate_echo_lag_finds_the_delay_and_no_echo(self):
        mic, system, owner = self._echo_case(lag=1600)
        self.assertEqual(tr.estimate_echo_lag(mic, system), 1600)
        self.assertIsNone(tr.estimate_echo_lag(owner, system))

    def test_cancel_echo_removes_the_remote_side_and_keeps_the_owner(self):
        sr = tr.SAMPLE_RATE
        mic, system, owner = self._echo_case()
        residual = tr.cancel_echo(mic, system, 1600)
        db = lambda x: 10 * np.log10(float(np.mean(x * x)) + 1e-12)  # noqa: E731
        echo_only = slice(18 * sr, 27 * sr)
        self.assertLess(db(residual[echo_only]), db(mic[echo_only]) - 10)
        mine = slice(12 * sr, 15 * sr)
        self.assertLess(abs(db(residual[mine]) - db(owner[mine])), 1.0)

    def test_owner_stream_mutes_the_echo_and_passes_a_clean_microphone_through(self):
        sr = tr.SAMPLE_RATE
        mic, system, owner = self._echo_case()
        mine, lag = tr.owner_stream(mic, system)
        self.assertEqual(lag, 1600)
        self.assertEqual(float(np.abs(mine[18 * sr:27 * sr]).max()), 0.0)
        self.assertGreater(float(np.mean(mine[12 * sr + 8192:15 * sr - 8192] ** 2)), 0.015)  # the tone's 0.02, mostly
        clean, lag = tr.owner_stream(owner, system)
        self.assertIsNone(lag)
        self.assertTrue(np.array_equal(clean, owner))

    def test_echo_duplicates_drops_a_microphone_piece_that_repeats_the_remote_side(self):
        segments = [
            {"id": 0, "start": 10.0, "end": 14.0, "stream": "system", "text": "давайте посмотрим на график продаж"},
            {"id": 1, "start": 10.2, "end": 14.1, "stream": "mic", "text": "Давайте посмотрим на график"},
            {"id": 2, "start": 11.0, "end": 13.0, "stream": "mic", "text": "подожди, у меня вопрос"},
            {"id": 3, "start": 40.0, "end": 42.0, "stream": "mic", "text": "давайте посмотрим на график продаж"},
        ]
        self.assertEqual(tr.echo_duplicates(segments), {1})

    def test_cluster_anchored_needs_long_pieces(self):
        X = np.stack([tr.unit(np.eye(4)[i % 4]) for i in range(6)]).astype(np.float32)
        self.assertIsNone(tr.cluster_anchored(X, [1.5] * 6))
        self.assertIsNone(tr.cluster_anchored(X, [4.0, 1.0, 1.0, 1.0, 1.0, 1.0]))

    @unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
    def test_offline_local_keeps_the_owner_from_the_compressed_streams(self):
        """After the raw streams were removed, a retranscription restores them from mic.ogg and system.ogg."""
        d = self._synthetic_local_meeting()
        for name in ("mic", "system"):
            pcm = os.path.join(d, name + ".pcm")
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", pcm,
                            "-c:a", "libopus", "-b:a", "32k", os.path.join(d, name + ".ogg")], check=True)
            os.remove(pcm)

        def impl(audio, language, initial_prompt):
            return "слово"

        self.assertEqual(tr.Transcriber(self._local_args(d, "offline"), whisper_impl=impl).run(), 0)
        labels = [s["speaker"] for s in read_json(os.path.join(d, "transcript.json"))["segments"]]
        self.assertEqual([label == "Я" for label in labels], [True, False, True])

    def test_offline_local_twice_identical(self):
        d = self._synthetic_local_meeting()

        def impl(audio, language, initial_prompt):
            return "слово"

        args = self._local_args(d, "offline")
        self.assertEqual(tr.Transcriber(args, whisper_impl=impl).run(), 0)
        first = read_json(os.path.join(d, "transcript.json"))
        self.assertEqual(tr.Transcriber(args, whisper_impl=impl).run(), 0)
        second = read_json(os.path.join(d, "transcript.json"))
        # Everything but the createdAt timestamp is identical (no accumulated speakers.jsonl lines).
        first.pop("createdAt", None)
        second.pop("createdAt", None)
        self.assertEqual(first, second)


    def test_keep_raw_audio_off_removes_streams(self):
        d = self._synthetic_local_meeting()
        cfg = read_json(os.path.join(d, "config.json"))
        cfg["transcriber"]["keepRawAudio"] = False
        with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
            json.dump(cfg, f)

        def impl(audio, language, initial_prompt):
            return "слово"

        self.assertEqual(tr.Transcriber(self._local_args(d, "offline"), whisper_impl=impl).run(), 0)
        self.assertIsNotNone(read_json(os.path.join(d, "transcript.json")))
        self.assertFalse(os.path.exists(os.path.join(d, "mic.pcm")))
        self.assertFalse(os.path.exists(os.path.join(d, "system.pcm")))
        self.assertFalse(os.path.exists(os.path.join(d, "audio.pcm")))

    def test_live_local_runner_finishes(self):
        d = self._synthetic_local_meeting()
        with open(os.path.join(d, "state.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "meetingId": "mtg_local0002", "pid": 123, "phase": "ended",
                       "recordingStartedAt": 0}, f)

        def impl(audio, language, initial_prompt):
            return "слово"

        self.assertEqual(tr.Transcriber(self._local_args(d, "live"), whisper_impl=impl).run(), 0)
        transcript = read_json(os.path.join(d, "transcript.json"))
        self.assertIsNotNone(transcript)
        self.assertEqual(transcript["asr"]["engine"], "whisper")


    def test_whisper_calls_serialized(self):
        state = {"active": 0, "max": 0}
        lock = threading.Lock()

        def impl(audio, language, initial_prompt):
            with lock:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            time.sleep(0.05)
            with lock:
                state["active"] -= 1
            return "текст"

        stop = threading.Event()
        asr = tr.WhisperAsr("ru", "", stop, lambda *_: None, transcribe_impl=impl)
        results = []

        def call():
            results.append(asr.transcribe(np.zeros(1600, dtype=np.float32)))

        threads = [threading.Thread(target=call) for _ in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(state["max"], 1)
        self.assertEqual(results, ["текст", "текст", "текст", "текст"])


if __name__ == "__main__":
    unittest.main()


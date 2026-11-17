// Remembering a speaker's voice when the owner names them (src/host/voices.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEmbedding, encodeEmbedding, forgetVoice, learnVoice, listVoices, mergeVoice, speakerCentroid } from "../src/host/voices.js";
import { hostPaths } from "../src/host/paths.js";

const vec = (...values: number[]) => Float32Array.from(values);
const rounded = (v: Float32Array) => Array.from(v, (x) => Math.round(x * 1000) / 1000);

describe("embeddings", () => {
  it("round-trips through base64 as a unit vector", () => {
    expect(rounded(decodeEmbedding(encodeEmbedding(vec(3, 4)))!)).toEqual([0.6, 0.8]);
  });

  it("rejects text that is not an embedding", () => {
    expect(decodeEmbedding("")).toBeNull();
    expect(decodeEmbedding("abc")).toBeNull();
    expect(decodeEmbedding(encodeEmbedding(vec(0, 0)))).toBeNull();
  });
});

describe("speakerCentroid", () => {
  const segments = [
    { id: 0, start: 0, end: 30, speakerKey: "spk:1" },
    { id: 1, start: 30, end: 40, speakerKey: "spk:2" },
    { id: 2, start: 40, end: 50, speakerKey: "spk:1" },
    { id: 3, start: 50, end: 55, speakerKey: "spk:1" },
  ];
  const embeddings = new Map([
    [0, vec(1, 0)],
    [1, vec(0, 1)],
    [2, vec(0, 1)],
  ]);

  it("averages the speaker's pieces by duration and counts only pieces that have an embedding", () => {
    const centroid = speakerCentroid(segments, embeddings, "spk:1")!;
    expect(centroid.seconds).toBe(40);
    // 30 s of (1, 0) and 10 s of (0, 1): (30, 10) normalized.
    expect(rounded(centroid.vector)).toEqual([0.949, 0.316]);
  });

  it("is null for a speaker with no embedded pieces", () => {
    expect(speakerCentroid(segments, embeddings, "spk:9")).toBeNull();
    expect(speakerCentroid(segments, new Map(), "spk:1")).toBeNull();
  });
});

describe("mergeVoice", () => {
  it("starts a voice from its first sample", () => {
    expect(mergeVoice(null, "Анна", { vector: vec(1, 0), seconds: 40 }, 1000)).toEqual({
      name: "Анна", embedding: encodeEmbedding(vec(1, 0)), seconds: 40, meetings: 1, updatedAt: 1000, roster: [],
    });
  });

  it("averages a new sample in by the amount of speech", () => {
    const first = mergeVoice(null, "Анна", { vector: vec(1, 0), seconds: 30 }, 1000);
    const merged = mergeVoice(first, "Анна", { vector: vec(0, 1), seconds: 10 }, 2000);
    expect(rounded(decodeEmbedding(merged.embedding)!)).toEqual([0.949, 0.316]);
    expect({ seconds: merged.seconds, meetings: merged.meetings, updatedAt: merged.updatedAt }).toEqual({ seconds: 40, meetings: 2, updatedAt: 2000 });
  });
});

describe("mergeVoice roster", () => {
  it("remembers who was invited to the meetings a voice was learned in", () => {
    const first = mergeVoice(null, "Анна", { vector: vec(1, 0), seconds: 30 }, 1000, ["a@x.io", "b@x.io"]);
    expect(first.roster).toEqual(["a@x.io", "b@x.io"]);
    expect(mergeVoice(first, "Анна", { vector: vec(1, 0), seconds: 10 }, 2000, ["b@x.io", "c@x.io"]).roster).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
  });
});

describe("learnVoice, listVoices, forgetVoice", () => {
  let root: string;
  const meetingId = "mtg_voices000001";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "voices-"));
    const dir = path.join(hostPaths(root).meetings, meetingId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "transcript.json"), JSON.stringify({
      segments: [
        { id: 0, start: 0, end: 12, speakerKey: "spk:1", speaker: "Спикер 1", source: "acoustic", text: "раз" },
        { id: 1, start: 12, end: 16, speakerKey: "spk:2", speaker: "Спикер 2", source: "acoustic", text: "два" },
      ],
    }));
    await fs.writeFile(path.join(dir, "embeddings.jsonl"), [
      JSON.stringify({ id: 0, emb: encodeEmbedding(vec(1, 0)) }),
      JSON.stringify({ id: 1, emb: encodeEmbedding(vec(0, 1)) }),
      "{broken",
    ].join("\n"));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("remembers a named speaker and lists them without the embedding", async () => {
    expect(await learnVoice(hostPaths(root), { meetingId, speakerKey: "spk:1", name: "Анна", roster: ["a@x.io"] }, 5000)).toEqual({ learned: true, reason: null, seconds: 12 });
    expect(JSON.parse(await fs.readFile(path.join(root, "voices.json"), "utf8")).voices[0].roster).toEqual(["a@x.io"]);
    expect(await listVoices(hostPaths(root))).toEqual([{ name: "Анна", seconds: 12, meetings: 1, updatedAt: 5000 }]);
  });

  it("does not learn from less than ten seconds of speech, an unknown speaker or a meeting without embeddings", async () => {
    const paths = hostPaths(root);
    expect(await learnVoice(paths, { meetingId, speakerKey: "spk:2", name: "Борис" }, 1)).toEqual({ learned: false, reason: "too_short", seconds: 4 });
    expect(await learnVoice(paths, { meetingId, speakerKey: "spk:7", name: "Вера" }, 1)).toEqual({ learned: false, reason: "no_voice", seconds: 0 });
    await fs.rm(path.join(paths.meetings, meetingId, "embeddings.jsonl"));
    expect(await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 1)).toEqual({ learned: false, reason: "no_voice", seconds: 0 });
    expect(await listVoices(paths)).toEqual([]);
  });

  it("forgets a voice by name", async () => {
    const paths = hostPaths(root);
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 5000);
    expect(await forgetVoice(paths, "Борис")).toBe(false);
    expect(await forgetVoice(paths, "Анна")).toBe(true);
    expect(await listVoices(paths)).toEqual([]);
  });
});

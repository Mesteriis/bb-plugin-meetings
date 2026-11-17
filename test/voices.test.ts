// Remembering a speaker's voice when the owner names them (src/host/voices.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeEmbedding, encodeEmbedding, forgetVoice, learnVoice, listVoices, mergeVoice, retractVoice, speakerCentroid, suggestVoices } from "../src/host/voices.js";
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
    expect(mergeVoice(null, "Анна", { meeting: "m1", vector: vec(1, 0), seconds: 40 }, 1000)).toEqual({
      name: "Анна", embedding: encodeEmbedding(vec(1, 0)), seconds: 40, meetings: 1, updatedAt: 1000, roster: [],
      samples: [{ meeting: "m1", embedding: encodeEmbedding(vec(1, 0)), seconds: 40, at: 1000, roster: [] }],
    });
  });

  it("averages a new sample in by the amount of speech", () => {
    const first = mergeVoice(null, "Анна", { meeting: "m1", vector: vec(1, 0), seconds: 30 }, 1000);
    const merged = mergeVoice(first, "Анна", { meeting: "m2", vector: vec(0, 1), seconds: 10 }, 2000);
    expect(rounded(decodeEmbedding(merged.embedding)!)).toEqual([0.949, 0.316]);
    expect({ seconds: merged.seconds, meetings: merged.meetings, updatedAt: merged.updatedAt }).toEqual({ seconds: 40, meetings: 2, updatedAt: 2000 });
  });

  it("replaces the sample of a meeting it already learned from instead of counting it twice", () => {
    const first = mergeVoice(null, "Анна", { meeting: "m1", vector: vec(1, 0), seconds: 30 }, 1000);
    const again = mergeVoice(first, "Анна", { meeting: "m1", vector: vec(0, 1), seconds: 20 }, 2000);
    expect(rounded(decodeEmbedding(again.embedding)!)).toEqual([0, 1]);
    expect({ seconds: again.seconds, meetings: again.meetings }).toEqual({ seconds: 20, meetings: 1 });
  });
});

describe("mergeVoice roster", () => {
  it("remembers who was invited to the meetings a voice was learned in", () => {
    const first = mergeVoice(null, "Анна", { meeting: "m1", vector: vec(1, 0), seconds: 30 }, 1000, ["a@x.io", "b@x.io"]);
    expect(first.roster).toEqual(["a@x.io", "b@x.io"]);
    expect(mergeVoice(first, "Анна", { meeting: "m2", vector: vec(1, 0), seconds: 10 }, 2000, ["b@x.io", "c@x.io"]).roster).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
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

  it("keeps every voice when several speakers are named at once", async () => {
    const paths = hostPaths(root);
    const dir = path.join(paths.meetings, meetingId);
    await fs.writeFile(path.join(dir, "transcript.json"), JSON.stringify({
      segments: [
        { id: 0, start: 0, end: 12, speakerKey: "spk:1" },
        { id: 1, start: 12, end: 30, speakerKey: "spk:2" },
      ],
    }));
    await Promise.all([
      learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 1),
      learnVoice(paths, { meetingId, speakerKey: "spk:2", name: "Борис" }, 2),
    ]);
    expect((await listVoices(paths)).map((voice) => voice.name).sort()).toEqual(["Анна", "Борис"]);
    // A forget and a learn that overlap both take effect.
    await Promise.all([forgetVoice(paths, "Анна"), learnVoice(paths, { meetingId, speakerKey: "spk:2", name: "Борис" }, 3)]);
    expect((await listVoices(paths)).map((voice) => voice.name)).toEqual(["Борис"]);
  });

  it("counts a repeated rename once and moves the sample when the name is corrected", async () => {
    const paths = hostPaths(root);
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 1);
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 2);
    expect(await listVoices(paths)).toEqual([{ name: "Анна", seconds: 12, meetings: 1, updatedAt: 2 }]);
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Борис" }, 3);
    expect(await listVoices(paths)).toEqual([{ name: "Борис", seconds: 12, meetings: 1, updatedAt: 3 }]);
  });

  it("takes a speaker's sample back when the name is removed, keeping what other meetings taught", async () => {
    const paths = hostPaths(root);
    await fs.writeFile(path.join(root, "voices.json"), JSON.stringify({
      version: 1,
      voices: [{ name: "Анна", embedding: encodeEmbedding(vec(1, 0)), seconds: 50, meetings: 1, updatedAt: 1 }],
    }));
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 2);
    expect(await listVoices(paths)).toEqual([{ name: "Анна", seconds: 62, meetings: 2, updatedAt: 2 }]);
    expect(await retractVoice(paths, { meetingId, speakerKey: "spk:1" }, 3)).toBe(true);
    expect(await listVoices(paths)).toEqual([{ name: "Анна", seconds: 50, meetings: 1, updatedAt: 3 }]);
    expect(await retractVoice(paths, { meetingId, speakerKey: "spk:1" }, 4)).toBe(false);
  });

  it("does not learn a voice from the unknown speaker, which mixes several people", async () => {
    const paths = hostPaths(root);
    await fs.writeFile(path.join(paths.meetings, meetingId, "transcript.json"), JSON.stringify({ segments: [{ id: 0, start: 0, end: 12, speakerKey: "unknown" }] }));
    expect(await learnVoice(paths, { meetingId, speakerKey: "unknown", name: "Анна" }, 1)).toEqual({ learned: false, reason: "no_voice", seconds: 0 });
    expect(await listVoices(paths)).toEqual([]);
  });

  it("lets a forget that follows a learn of the same voice win, however slow the learn is", async () => {
    const paths = hostPaths(root);
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 1);
    const learning = learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 2);
    expect(await forgetVoice(paths, "Анна")).toBe(true);
    await learning;
    expect(await listVoices(paths)).toEqual([]);
  });

  it("takes the meeting's invitees back together with its sample", async () => {
    const paths = hostPaths(root);
    const other = "mtg_voices000002";
    const dir = path.join(paths.meetings, other);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "transcript.json"), JSON.stringify({ segments: [{ id: 0, start: 0, end: 20, speakerKey: "spk:1" }] }));
    await fs.writeFile(path.join(dir, "embeddings.jsonl"), JSON.stringify({ id: 0, emb: encodeEmbedding(vec(0, 1)) }));
    const rosters = async () =>
      Object.fromEntries(JSON.parse(await fs.readFile(path.join(root, "voices.json"), "utf8")).voices.map((v: { name: string; roster: string[] }) => [v.name, v.roster]));
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна", roster: ["a1@x.io"] }, 1);
    await learnVoice(paths, { meetingId: other, speakerKey: "spk:1", name: "Анна", roster: ["b1@x.io", "b2@x.io"] }, 2);
    expect(await rosters()).toEqual({ Анна: ["a1@x.io", "b1@x.io", "b2@x.io"] });
    // The second meeting's speaker was Борис all along.
    await learnVoice(paths, { meetingId: other, speakerKey: "spk:1", name: "Борис", roster: ["b1@x.io", "b2@x.io"] }, 3);
    expect(await rosters()).toEqual({ Анна: ["a1@x.io"], Борис: ["b1@x.io", "b2@x.io"] });
    expect(await listVoices(paths)).toEqual([
      { name: "Анна", seconds: 12, meetings: 1, updatedAt: 3 },
      { name: "Борис", seconds: 20, meetings: 1, updatedAt: 3 },
    ]);
  });

  it("suggests a known voice for a speaker it resembles but did not clearly match", async () => {
    const paths = hostPaths(root);
    // Анна's voice is 0.6 similar to spk:1 (vector (1, 0)); Вера's is nothing like it.
    await fs.writeFile(path.join(root, "voices.json"), JSON.stringify({
      version: 1,
      voices: [
        { name: "Анна", embedding: encodeEmbedding(vec(0.6, 0.8)), seconds: 50, meetings: 1, updatedAt: 1 },
        { name: "Вера", embedding: encodeEmbedding(vec(-1, 0)), seconds: 50, meetings: 1, updatedAt: 1 },
      ],
    }));
    expect(await suggestVoices(paths, { meetingId, speakerKeys: ["spk:1", "spk:2", "spk:9"], taken: [] })).toEqual([
      { speakerKey: "spk:1", name: "Анна", similarity: 0.6 },
    ]);
    // Not a name that someone in this meeting already has.
    expect(await suggestVoices(paths, { meetingId, speakerKeys: ["spk:1"], taken: ["Анна"] })).toEqual([]);
  });

  it("forgets a voice by name", async () => {
    const paths = hostPaths(root);
    await learnVoice(paths, { meetingId, speakerKey: "spk:1", name: "Анна" }, 5000);
    expect(await forgetVoice(paths, "Борис")).toBe(false);
    expect(await forgetVoice(paths, "Анна")).toBe(true);
    expect(await listVoices(paths)).toEqual([]);
  });
});

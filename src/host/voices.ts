// Known voices (docs/dev/DESIGN.md §16): when the owner gives a speaker a
// name, the host keeps that speaker's voice so the transcriber can name them
// in later meetings (runtime/transcriber/transcriber.py match_voices). A voice
// is the duration-weighted mean of the speaker's piece embeddings, stored in
// <hostData>/voices.json. Voiceprints never leave the recording machine.
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.js";
import { MEETING_FILES as F, meetingDir, type HostPaths } from "./paths.js";

/** A speaker needs at least this much embedded speech to be remembered. */
export const VOICE_MIN_LEARN_S = 10;
/** Speech beyond this no longer makes an old voice heavier against a new sample. */
const VOICE_WEIGHT_CAP_S = 600;

export interface Voice {
  readonly name: string;
  /** Unit embedding, little-endian float32, base64 (the transcriber's format). */
  readonly embedding: string;
  /** Seconds of speech the voice was averaged from. */
  readonly seconds: number;
  /** Meetings it was learned from. */
  readonly meetings: number;
  readonly updatedAt: number;
}

export type VoiceSummary = Omit<Voice, "embedding">;

export interface Centroid {
  readonly vector: Float32Array;
  readonly seconds: number;
}

function unit(vector: Float32Array): Float32Array | null {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  return vector.map((value) => value / norm);
}

export function encodeEmbedding(vector: Float32Array): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
}

/** The unit vector of a stored embedding, or null when the text is not one. */
export function decodeEmbedding(text: unknown): Float32Array | null {
  if (typeof text !== "string" || text === "") return null;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0 || bytes.toString("base64") !== text) return null;
  const vector = new Float32Array(bytes.length / 4);
  for (let index = 0; index < vector.length; index += 1) vector[index] = bytes.readFloatLE(index * 4);
  return unit(vector);
}

export interface SpeakerPiece {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly speakerKey: string;
}

/** The speaker's voice in one meeting: their embedded pieces averaged by duration. */
export function speakerCentroid(segments: readonly SpeakerPiece[], embeddings: ReadonlyMap<number, Float32Array>, speakerKey: string): Centroid | null {
  let sum: Float32Array | null = null;
  let seconds = 0;
  for (const segment of segments) {
    const embedding = segment.speakerKey === speakerKey ? embeddings.get(segment.id) : undefined;
    const duration = segment.end - segment.start;
    if (embedding === undefined || !(duration > 0)) continue;
    sum ??= new Float32Array(embedding.length);
    if (sum.length !== embedding.length) continue;
    for (let index = 0; index < sum.length; index += 1) sum[index]! += embedding[index]! * duration;
    seconds += duration;
  }
  const vector = sum === null ? null : unit(sum);
  return vector === null ? null : { vector, seconds };
}

/** A voice with a new sample averaged in by the amount of speech behind each. */
export function mergeVoice(existing: Voice | null, name: string, sample: Centroid, now: number): Voice {
  const old = existing === null ? null : decodeEmbedding(existing.embedding);
  if (existing === null || old === null || old.length !== sample.vector.length) {
    return { name, embedding: encodeEmbedding(sample.vector), seconds: sample.seconds, meetings: 1, updatedAt: now };
  }
  const weight = Math.min(existing.seconds, VOICE_WEIGHT_CAP_S);
  const mixed = unit(old.map((value, index) => value * weight + sample.vector[index]! * sample.seconds)) ?? sample.vector;
  return { name, embedding: encodeEmbedding(mixed), seconds: existing.seconds + sample.seconds, meetings: existing.meetings + 1, updatedAt: now };
}

function voicesFile(paths: HostPaths): string {
  return path.join(paths.root, "voices.json");
}

async function readVoices(paths: HostPaths): Promise<Voice[]> {
  const data = (await readJson(voicesFile(paths))) as { voices?: unknown } | null;
  const voices: Voice[] = [];
  for (const entry of Array.isArray(data?.voices) ? data.voices : []) {
    const { name, embedding, seconds, meetings, updatedAt } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "" || decodeEmbedding(embedding) === null) continue;
    voices.push({
      name: name.trim(),
      embedding: embedding as string,
      seconds: typeof seconds === "number" ? seconds : 0,
      meetings: typeof meetings === "number" ? meetings : 1,
      updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
    });
  }
  return voices;
}

async function readEmbeddings(file: string): Promise<Map<number, Float32Array>> {
  const embeddings = new Map<number, Float32Array>();
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; emb?: unknown };
      const vector = decodeEmbedding(row.emb);
      if (typeof row.id === "number" && vector !== null) embeddings.set(row.id, vector);
    } catch {
      // A partial last line of an append-only file.
    }
  }
  return embeddings;
}

export interface LearnVoiceInput {
  readonly meetingId: string;
  readonly speakerKey: string;
  readonly name: string;
}

export interface LearnVoiceResult {
  readonly learned: boolean;
  /** Why not: the speaker has no embedded speech in this meeting, or too little. */
  readonly reason: "no_voice" | "too_short" | null;
  /** Seconds of the speaker's embedded speech in this meeting. */
  readonly seconds: number;
}

/** Remember the voice of a speaker the owner has just named. */
export async function learnVoice(paths: HostPaths, input: LearnVoiceInput, now: number): Promise<LearnVoiceResult> {
  const dir = meetingDir(paths, input.meetingId);
  const transcript = (await readJson(path.join(dir, F.transcript))) as { segments?: unknown } | null;
  const segments = (Array.isArray(transcript?.segments) ? transcript.segments : []).filter(
    (segment): segment is SpeakerPiece =>
      typeof segment === "object" &&
      segment !== null &&
      typeof (segment as SpeakerPiece).id === "number" &&
      typeof (segment as SpeakerPiece).start === "number" &&
      typeof (segment as SpeakerPiece).end === "number" &&
      typeof (segment as SpeakerPiece).speakerKey === "string",
  );
  const sample = speakerCentroid(segments, await readEmbeddings(path.join(dir, F.embeddings)), input.speakerKey);
  if (sample === null) return { learned: false, reason: "no_voice", seconds: 0 };
  if (sample.seconds < VOICE_MIN_LEARN_S) return { learned: false, reason: "too_short", seconds: sample.seconds };
  const name = input.name.trim();
  const voices = await readVoices(paths);
  const index = voices.findIndex((voice) => voice.name === name);
  const merged = mergeVoice(index === -1 ? null : voices[index]!, name, sample, now);
  if (index === -1) voices.push(merged);
  else voices[index] = merged;
  await writeJsonAtomic(voicesFile(paths), { version: 1, voices });
  return { learned: true, reason: null, seconds: sample.seconds };
}

export async function listVoices(paths: HostPaths): Promise<VoiceSummary[]> {
  return (await readVoices(paths)).map(({ name, seconds, meetings, updatedAt }) => ({ name, seconds, meetings, updatedAt }));
}

/** Delete a voice; false when there is none with this name. */
export async function forgetVoice(paths: HostPaths, name: string): Promise<boolean> {
  const voices = await readVoices(paths);
  const kept = voices.filter((voice) => voice.name !== name.trim());
  if (kept.length === voices.length) return false;
  await writeJsonAtomic(voicesFile(paths), { version: 1, voices: kept });
  return true;
}

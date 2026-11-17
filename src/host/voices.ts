// Known voices (docs/dev/DESIGN.md §16): when the owner gives a speaker a
// name, the host keeps that speaker's voice so the transcriber can name them
// in later meetings (runtime/transcriber/transcriber.py match_voices). A voice
// is the duration-weighted mean of the speaker's piece embeddings, stored in
// <hostData>/voices.json. Voiceprints never leave the recording machine.
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, serialized, writeJsonAtomic } from "./fsutil.js";
import { MEETING_FILES as F, meetingDir, type HostPaths } from "./paths.js";

/** A speaker needs at least this much embedded speech to be remembered. */
export const VOICE_MIN_LEARN_S = 10;
/** Speech beyond this no longer makes one meeting's sample heavier against the others. */
const VOICE_WEIGHT_CAP_S = 600;
/** A voice keeps the samples of its latest meetings, this many at most. */
const VOICE_SAMPLES_MAX = 50;
/** Two centroids of one meeting this similar are the same speaker of it. */
const SAME_SPEAKER_SIMILARITY = 0.9;

/** What one meeting taught about a voice; kept so it can be replaced or taken back. */
export interface VoiceSample {
  /** The meeting it came from; null for a voice learned before samples were kept. */
  readonly meeting: string | null;
  readonly embedding: string;
  readonly seconds: number;
  readonly at: number;
}

export interface Voice {
  readonly name: string;
  /** Unit embedding, little-endian float32, base64 (the transcriber's format). */
  readonly embedding: string;
  /** Seconds of speech the voice was averaged from. */
  readonly seconds: number;
  /** Meetings it was learned from. */
  readonly meetings: number;
  readonly updatedAt: number;
  /** Calendar invitees (roster keys) of the meetings the voice was learned in: where to expect it. */
  readonly roster: readonly string[];
  /** One per meeting; `embedding`, `seconds` and `meetings` are derived from them. */
  readonly samples: readonly VoiceSample[];
}

export type VoiceSummary = Omit<Voice, "embedding" | "roster" | "samples">;

/** A voice keeps at most this many roster keys. */
const VOICE_ROSTER_MAX = 300;

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

/** A voice from its samples, averaged by the speech behind each; null without usable samples. */
function composeVoice(name: string, samples: readonly VoiceSample[], roster: readonly string[], now: number): Voice | null {
  let sum: Float32Array | null = null;
  let seconds = 0;
  const used: VoiceSample[] = [];
  for (const sample of samples) {
    const vector = decodeEmbedding(sample.embedding);
    if (vector === null || (sum !== null && sum.length !== vector.length)) continue;
    sum ??= new Float32Array(vector.length);
    const weight = Math.min(sample.seconds, VOICE_WEIGHT_CAP_S);
    for (let index = 0; index < sum.length; index += 1) sum[index]! += vector[index]! * weight;
    seconds += sample.seconds;
    used.push(sample);
  }
  const embedding = sum === null ? null : unit(sum);
  if (embedding === null) return null;
  return { name, embedding: encodeEmbedding(embedding), seconds, meetings: used.length, updatedAt: now, roster: [...roster], samples: used };
}

export interface MeetingSample extends Centroid {
  readonly meeting: string;
}

/**
 * A voice with a meeting's sample in it. A meeting counts once: naming the same
 * speaker again, or naming them after a new transcription, replaces its sample.
 */
export function mergeVoice(existing: Voice | null, name: string, sample: MeetingSample, now: number, roster: readonly string[] = []): Voice {
  const seen = [...new Set([...(existing?.roster ?? []), ...roster])].slice(0, VOICE_ROSTER_MAX);
  const added: VoiceSample = { meeting: sample.meeting, embedding: encodeEmbedding(sample.vector), seconds: sample.seconds, at: now };
  const kept = (existing?.samples ?? []).filter(
    (old) => old.meeting !== sample.meeting && decodeEmbedding(old.embedding)?.length === sample.vector.length,
  );
  const voice = composeVoice(name, [...kept, added].slice(-VOICE_SAMPLES_MAX), seen, now);
  if (voice === null) throw new Error("a voice sample must be a non-zero vector");
  return voice;
}

function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  return dot;
}

/**
 * The voice without what this speaker of this meeting taught it: the same voice
 * when it holds no such sample, null when nothing else is left. The speaker is
 * recognised by the centroid, not the key: keys are renumbered by a new transcription.
 */
function withoutSpeaker(voice: Voice, sample: MeetingSample, now: number): Voice | null {
  const kept = voice.samples.filter((old) => {
    const vector = old.meeting === sample.meeting ? decodeEmbedding(old.embedding) : null;
    return vector === null || similarity(vector, sample.vector) < SAME_SPEAKER_SIMILARITY;
  });
  return kept.length === voice.samples.length ? voice : composeVoice(voice.name, kept, voice.roster, now);
}

function voicesFile(paths: HostPaths): string {
  return path.join(paths.root, "voices.json");
}

async function readVoices(paths: HostPaths): Promise<Voice[]> {
  const data = (await readJson(voicesFile(paths))) as { voices?: unknown } | null;
  const voices: Voice[] = [];
  for (const entry of Array.isArray(data?.voices) ? data.voices : []) {
    const { name, embedding, seconds, meetings, updatedAt, roster, samples } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "" || decodeEmbedding(embedding) === null) continue;
    const at = typeof updatedAt === "number" ? updatedAt : 0;
    const total = typeof seconds === "number" ? seconds : 0;
    const kept: VoiceSample[] = [];
    for (const sample of Array.isArray(samples) ? samples : []) {
      const { meeting, embedding: vector, seconds: length, at: when } = (sample ?? {}) as Record<string, unknown>;
      if (decodeEmbedding(vector) === null || typeof length !== "number") continue;
      kept.push({ meeting: typeof meeting === "string" ? meeting : null, embedding: vector as string, seconds: length, at: typeof when === "number" ? when : at });
    }
    voices.push({
      name: name.trim(),
      embedding: embedding as string,
      seconds: total,
      meetings: typeof meetings === "number" ? meetings : 1,
      updatedAt: at,
      roster: Array.isArray(roster) ? roster.filter((key): key is string => typeof key === "string") : [],
      // A voice from before samples were kept: all it knows is one sample of no particular meeting.
      samples: kept.length > 0 ? kept : [{ meeting: null, embedding: embedding as string, seconds: total, at }],
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
  /** Calendar invitees of the meeting (roster keys). */
  readonly roster?: readonly string[];
}

export interface LearnVoiceResult {
  readonly learned: boolean;
  /** Why not: the speaker has no embedded speech in this meeting, or too little. */
  readonly reason: "no_voice" | "too_short" | null;
  /** Seconds of the speaker's embedded speech in this meeting. */
  readonly seconds: number;
}

/** The voice of one speaker of a finished meeting, from its transcript and embeddings. */
async function meetingSpeaker(paths: HostPaths, meetingId: string, speakerKey: string): Promise<Centroid | null> {
  const dir = meetingDir(paths, meetingId);
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
  return speakerCentroid(segments, await readEmbeddings(path.join(dir, F.embeddings)), speakerKey);
}

/** One change of voices.json at a time: a rename, a correction and a forget may arrive together. */
function changeVoices<T>(paths: HostPaths, change: (voices: Voice[]) => { voices: Voice[]; result: T } | { result: T }): Promise<T> {
  return serialized(voicesFile(paths), async () => {
    const outcome = change(await readVoices(paths));
    if ("voices" in outcome) await writeJsonAtomic(voicesFile(paths), { version: 1, voices: outcome.voices });
    return outcome.result;
  });
}

/** Every voice without this speaker's sample; voices left with nothing are dropped. */
function retracted(voices: readonly Voice[], sample: MeetingSample, now: number, except?: string): { voices: Voice[]; changed: boolean } {
  let changed = false;
  const kept: Voice[] = [];
  for (const voice of voices) {
    const next = voice.name === except ? voice : withoutSpeaker(voice, sample, now);
    changed ||= next !== voice;
    if (next !== null) kept.push(next);
  }
  return { voices: kept, changed };
}

/**
 * Remember the voice of a speaker the owner has just named. The same speaker
 * under another name (a corrected mistake) loses this meeting's sample there.
 */
export async function learnVoice(paths: HostPaths, input: LearnVoiceInput, now: number): Promise<LearnVoiceResult> {
  const centroid = await meetingSpeaker(paths, input.meetingId, input.speakerKey);
  if (centroid === null) return { learned: false, reason: "no_voice", seconds: 0 };
  if (centroid.seconds < VOICE_MIN_LEARN_S) return { learned: false, reason: "too_short", seconds: centroid.seconds };
  const name = input.name.trim();
  const sample: MeetingSample = { ...centroid, meeting: input.meetingId };
  return changeVoices(paths, (stored) => {
    const voices = retracted(stored, sample, now, name).voices;
    const index = voices.findIndex((voice) => voice.name === name);
    const merged = mergeVoice(index === -1 ? null : voices[index]!, name, sample, now, input.roster ?? []);
    if (index === -1) voices.push(merged);
    else voices[index] = merged;
    return { voices, result: { learned: true, reason: null, seconds: centroid.seconds } };
  });
}

/** The owner removed a speaker's name: take back what that speaker taught. False when nothing was held. */
export async function retractVoice(paths: HostPaths, input: { readonly meetingId: string; readonly speakerKey: string }, now: number): Promise<boolean> {
  const centroid = await meetingSpeaker(paths, input.meetingId, input.speakerKey);
  if (centroid === null) return false;
  return changeVoices(paths, (stored) => {
    const { voices, changed } = retracted(stored, { ...centroid, meeting: input.meetingId }, now);
    return changed ? { voices, result: true } : { result: false };
  });
}

export async function listVoices(paths: HostPaths): Promise<VoiceSummary[]> {
  return (await readVoices(paths)).map(({ name, seconds, meetings, updatedAt }) => ({ name, seconds, meetings, updatedAt }));
}

/** Delete a voice; false when there is none with this name. */
export function forgetVoice(paths: HostPaths, name: string): Promise<boolean> {
  return changeVoices(paths, (voices) => {
    const kept = voices.filter((voice) => voice.name !== name.trim());
    return kept.length === voices.length ? { result: false } : { voices: kept, result: true };
  });
}

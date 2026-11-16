// Local recording on macOS Apple silicon (docs/dev/DESIGN.md §15): sample
// Core Audio for meeting apps holding the microphone, run the detection state
// machine, and start/stop the detached capture helper. No bot joins the call.
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeSnapshot } from "../shared/contract.js";
import type { BotState } from "../shared/runtime-files.js";
import { run } from "./exec.js";
import { errorMessage, statOrNull, writeJsonAtomic } from "./fsutil.js";
import { seedRecording, stepDetection, createDetectionState, type DetectionState } from "./local-detection.js";
import { activeSources, localSourceBundles, type AudioClientProcess } from "./local-sources.js";
import { childEnv, snapshot } from "./meetings.js";
import { MEETING_FILES as F, meetingDir, type HostPaths } from "./paths.js";
import { isMacArm64 } from "./platform.js";
import { readPids, spawnDetached, updatePids } from "./processes.js";

export interface LocalPollOptions {
  readonly startThresholdMs: number;
  readonly graceMs: number;
  /** Enabled appKeys; empty = all supported sources. */
  readonly apps: readonly string[] | null;
  readonly recording: readonly string[];
}

export interface LocalPollResult {
  readonly supported: boolean;
  readonly detected: { appKey: string; label: string }[];
  readonly started: { appKey: string; label: string }[];
  readonly ended: { appKey: string; label: string }[];
  readonly error: string | null;
}

let detectionState: DetectionState | null = null;

/** Test hook: forget the running detection state (a host worker restart does the same). */
export function resetLocalDetection(): void {
  detectionState = null;
}

function filterApps(apps: readonly { appKey: string; label: string }[], enabled: ReadonlySet<string> | null): { appKey: string; label: string }[] {
  if (enabled === null) return apps.slice();
  return apps.filter((app) => enabled.has(app.appKey));
}

export async function localPoll(paths: HostPaths, options: LocalPollOptions): Promise<LocalPollResult> {
  const empty: LocalPollResult = { supported: false, detected: [], started: [], ended: [], error: null };
  if (!isMacArm64()) return { ...empty, error: "локальная запись поддерживается только на macOS (Apple silicon)" };
  if ((await statOrNull(paths.capture)) === null) {
    return { ...empty, supported: true, error: "хелпер захвата не скомпилирован (bb meetings setup)" };
  }
  const result = await run(paths.capture, ["detect"], { timeoutMs: 10_000 }).catch(() => null);
  if (result === null || result.code !== 0) {
    return { ...empty, supported: true, error: "capture detect завершился с ошибкой" };
  }
  let processes: AudioClientProcess[];
  try {
    processes = JSON.parse(result.stdout) as AudioClientProcess[];
  } catch {
    return { ...empty, supported: true, error: "capture detect вернул не JSON" };
  }
  const enabled = options.apps === null ? null : new Set(options.apps);
  const sources = filterApps(activeSources(processes), enabled);
  detectionState = seedRecording(detectionState ?? createDetectionState(), options.recording);
  const { state, events } = stepDetection(detectionState, sources, Date.now(), {
    startThresholdMs: options.startThresholdMs,
    graceMs: options.graceMs,
  });
  detectionState = state;
  return {
    supported: true,
    detected: sources,
    started: events.filter((event) => event.type === "started").map((event) => ({ appKey: event.appKey, label: event.label })),
    ended: events.filter((event) => event.type === "ended").map((event) => ({ appKey: event.appKey, label: event.label })),
    error: null,
  };
}

export interface LocalStartInput {
  readonly meetingId: string;
  readonly appKey: string;
  readonly label: string;
  readonly ownerName: string;
  readonly engine: "whisper" | "gigaam";
  readonly language: string;
  readonly glossary: string;
  /** Transcriber config shared with bot meetings. */
  readonly transcriber: {
    readonly gigaamUrl: string | null;
    readonly diarization: "ui+acoustic" | "ui" | "acoustic";
    readonly speakerLagMs: number;
    readonly keepRawAudio: boolean;
    readonly threads: number;
  };
}

function initialState(meetingId: string, pid: number): BotState {
  const now = Date.now();
  return {
    version: 1,
    meetingId,
    pid,
    phase: "in_meeting",
    detail: "Recording locally",
    startedAt: now,
    joinedAt: now,
    recordingStartedAt: now,
    endedAt: null,
    endReason: null,
    error: null,
    participants: { count: null, names: [] },
    activeSpeakers: [],
    audio: { seconds: 0, bytes: 0 },
    updatedAt: now,
  };
}

/**
 * Create the meeting directory, write config.json (the local shape the
 * transcriber reads), the initial state.json and pids.json, and spawn the
 * detached capture helper. The helper updates state.json and finalizes on
 * SIGTERM; the host reconciles the rest the same way it does for bots.
 */
export async function startLocalMeeting(paths: HostPaths, input: LocalStartInput): Promise<RuntimeSnapshot> {
  if (!isMacArm64()) throw new Error("Локальная запись поддерживается только на macOS (Apple silicon)");
  if ((await statOrNull(paths.capture)) === null) throw new Error("Хелпер захвата не установлен: запустите bb meetings setup");
  const dir = meetingDir(paths, input.meetingId);
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const config = {
    version: 1,
    meetingId: input.meetingId,
    platform: "local",
    sourceApp: input.appKey,
    sourceLabel: input.label,
    sourceBundles: localSourceBundles(input.appKey),
    url: "local://" + input.appKey,
    ownerName: input.ownerName,
    createdAt: now,
    transcriber: {
      gigaamUrl: input.transcriber.gigaamUrl,
      diarization: input.transcriber.diarization,
      speakerLagMs: input.transcriber.speakerLagMs,
      keepRawAudio: input.transcriber.keepRawAudio,
      threads: input.transcriber.threads,
      engine: input.engine,
      language: input.language,
      glossary: input.glossary,
      ownerName: input.ownerName,
      whisperModel: paths.whisperModel,
    },
  };
  await writeJsonAtomic(path.join(dir, F.config), config);
  const bundles = localSourceBundles(input.appKey);
  const args = ["record", "--meeting-dir", dir];
  if (bundles.length > 0) args.push("--bundle-ids", bundles.join(","));
  // Write the initial state BEFORE spawning so the helper's own fast-failure
  // state (e.g. a denied microphone) is never overwritten by the host.
  await writeJsonAtomic(path.join(dir, F.state), initialState(input.meetingId, 0));
  const pid = await spawnDetached({
    command: paths.capture,
    args,
    cwd: dir,
    logFile: path.join(dir, F.botLog),
    env: childEnv(paths),
  });
  await writeJsonAtomic(path.join(dir, F.pids), { bot: { pid, startedAt: now } });
  return snapshot(paths, input.meetingId);
}

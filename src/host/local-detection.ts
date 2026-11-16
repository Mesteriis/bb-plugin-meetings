// The local-recording detection state machine (docs/dev/DESIGN.md §15):
// a meeting starts when a listed app holds the microphone continuously for a
// start threshold and ends when it has released it for a grace period. Pure:
// time is injected, no I/O, no platform calls — the host feeds it the result
// of the capture helper's `detect` and reads back events.
import type { LocalSource } from "./local-sources.js";

export interface LocalDetectionConfig {
  /** Hold the microphone this long before a recording starts. */
  readonly startThresholdMs: number;
  /** Released the microphone this long before a recording ends. */
  readonly graceMs: number;
}

export const DEFAULT_START_THRESHOLD_MS = 5_000;
export const DEFAULT_GRACE_MS = 60_000;

export type DetectionEvent =
  | { readonly type: "started"; readonly appKey: string; readonly label: string }
  | { readonly type: "ended"; readonly appKey: string; readonly label: string };

interface AppState {
  /** A recording for this source is running (started and not yet ended). */
  recording: boolean;
  /** The source currently holds the microphone. */
  holding: boolean;
  /** Epoch ms when the current uninterrupted hold began; null when not holding. */
  holdSinceMs: number | null;
  /** Epoch ms when the source was last seen without the microphone (while recording); null when holding. */
  releasedSinceMs: number | null;
}

export interface DetectionState {
  readonly byApp: Map<string, AppState>;
}

export function createDetectionState(): DetectionState {
  return { byApp: new Map() };
}

/** Mark appKeys as already recording (server restart seed). A recording app that is
 * absent starts its grace clock on the next sample; one that is held stays recording. */
export function seedRecording(state: DetectionState, appKeys: readonly string[]): DetectionState {
  const out: DetectionState = { byApp: new Map(state.byApp) };
  for (const appKey of appKeys) {
    const existing = out.byApp.get(appKey);
    if (existing !== undefined && existing.recording) continue;
    out.byApp.set(appKey, { recording: true, holding: false, holdSinceMs: null, releasedSinceMs: null });
  }
  return out;
}

function appState(state: DetectionState, appKey: string): AppState {
  let entry = state.byApp.get(appKey);
  if (entry === undefined) {
    entry = { recording: false, holding: false, holdSinceMs: null, releasedSinceMs: null };
    state.byApp.set(appKey, entry);
  }
  return entry;
}

/**
 * Advance the machine with one sample (the set of sources holding the
 * microphone right now). Returns the new state and the events to act on:
 * `started` for a source that crossed the start threshold, `ended` for one
 * that crossed the grace period. A source already recording never emits
 * `started` again while its input keeps arriving (flapping input below the
 * threshold resets the hold timer; a source that is recording and briefly
 * loses the microphone is still within its grace period).
 */
export function stepDetection(
  previous: DetectionState,
  active: readonly LocalSource[],
  nowMs: number,
  config: LocalDetectionConfig,
): { readonly state: DetectionState; readonly events: readonly DetectionEvent[] } {
  const state: DetectionState = { byApp: new Map(previous.byApp) };
  const activeKeys = new Set(active.map((source) => source.appKey));
  const labels = new Map(active.map((source) => [source.appKey, source.label] as const));
  const events: DetectionEvent[] = [];

  // Sources that are not in this sample must release the microphone.
  for (const [appKey] of state.byApp) {
    if (activeKeys.has(appKey)) continue;
    const entry = appState(state, appKey);
    if (!entry.recording) {
      entry.holding = false;
      entry.holdSinceMs = null;
      entry.releasedSinceMs = null;
      continue;
    }
    if (entry.releasedSinceMs === null) entry.releasedSinceMs = nowMs;
    if (nowMs - entry.releasedSinceMs >= config.graceMs) {
      entry.recording = false;
      entry.holding = false;
      entry.holdSinceMs = null;
      entry.releasedSinceMs = null;
      events.push({ type: "ended", appKey, label: labels.get(appKey) ?? appKey });
    }
  }

  for (const source of active) {
    const { appKey, label } = source;
    const entry = appState(state, appKey);
    if (entry.recording) {
      entry.holding = true;
      entry.releasedSinceMs = null;
      continue;
    }
    entry.holding = true;
    if (entry.holdSinceMs === null) entry.holdSinceMs = nowMs;
    if (nowMs - entry.holdSinceMs >= config.startThresholdMs) {
      entry.recording = true;
      entry.holdSinceMs = null;
      events.push({ type: "started", appKey, label });
    }
  }

  return { state, events };
}

/** The sources that currently have a running recording. */
export function recordingSources(state: DetectionState): LocalSource[] {
  const out: LocalSource[] = [];
  for (const [appKey, entry] of state.byApp) {
    if (entry.recording) out.push({ appKey, label: appKey });
  }
  return out;
}

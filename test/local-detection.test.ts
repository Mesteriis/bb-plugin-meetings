// Detection state machine for local recording (DESIGN §15). Pure, clock-injected.
import { describe, expect, it } from "vitest";
import {
  createDetectionState,
  recordingSources,
  stepDetection,
  DEFAULT_GRACE_MS,
  DEFAULT_START_THRESHOLD_MS,
  type DetectionEvent,
} from "../src/host/local-detection.js";

const cfg = { startThresholdMs: 5_000, graceMs: 60_000 };
const zoom = { appKey: "zoom", label: "Zoom" };
const teams = { appKey: "teams", label: "Microsoft Teams" };

interface Step {
  readonly now: number;
  readonly active: ReadonlyArray<{ appKey: string; label: string }>;
}

function run(steps: readonly Step[], config = cfg): { state: ReturnType<typeof createDetectionState>; events: DetectionEvent[] } {
  let state = createDetectionState();
  const events: DetectionEvent[] = [];
  for (const step of steps) {
    let next: readonly DetectionEvent[];
    ({ state, events: next } = stepDetection(state, step.active, step.now, config));
    events.push(...next);
  }
  return { state, events };
}

describe("stepDetection", () => {
  it("starts a recording after the source holds the microphone for the start threshold", () => {
    const { state, events } = run([
      { now: 0, active: [zoom] },
      { now: 4_999, active: [zoom] },
      { now: 5_000, active: [zoom] },
    ]);
    expect(events).toEqual([{ type: "started", appKey: "zoom", label: "Zoom" }]);
    expect(recordingSources(state)).toEqual([{ appKey: "zoom", label: "zoom" }]);
  });

  it("resets the hold timer when the input flaps below the threshold", () => {
    // input on at 0, off at 3 s, on again at 4 s: the hold restarts at 4 s,
    // so nothing starts before 9 s.
    const { state, events } = run([
      { now: 0, active: [zoom] },
      { now: 3_000, active: [] },
      { now: 4_000, active: [zoom] },
      { now: 7_000, active: [zoom] },
      { now: 9_000, active: [zoom] },
    ]);
    expect(events).toEqual([{ type: "started", appKey: "zoom", label: "Zoom" }]);
    expect(recordingSources(state)).toEqual([{ appKey: "zoom", label: "zoom" }]);
  });

  it("keeps recording through a brief release and ends after the grace period", () => {
    const { state, events } = run([
      { now: 0, active: [zoom] },
      { now: 5_000, active: [zoom] },
      { now: 10_000, active: [] },
      { now: 69_999, active: [] },
      { now: 70_000, active: [] },
    ]);
    expect(events).toEqual([
      { type: "started", appKey: "zoom", label: "Zoom" },
      { type: "ended", appKey: "zoom", label: "zoom" },
    ]);
    expect(recordingSources(state)).toEqual([]);
  });

  it("tracks two overlapping apps independently", () => {
    const { state, events } = run([
      { now: 0, active: [zoom] },
      { now: 5_000, active: [zoom, teams] },
      { now: 10_000, active: [zoom, teams] },
      // Zoom releases the microphone at 70 s; Teams keeps holding it.
      { now: 70_000, active: [teams] },
      { now: 130_000, active: [teams] },
    ]);
    expect(events).toEqual([
      { type: "started", appKey: "zoom", label: "Zoom" },
      { type: "started", appKey: "teams", label: "Microsoft Teams" },
      { type: "ended", appKey: "zoom", label: "zoom" },
    ]);
    expect(recordingSources(state)).toEqual([{ appKey: "teams", label: "teams" }]);
  });

  it("never emits started twice for a source that is already recording", () => {
    const { state, events } = run([
      { now: 0, active: [zoom] },
      { now: 5_000, active: [zoom] },
      { now: 60_000, active: [zoom] },
      { now: 120_000, active: [zoom] },
    ]);
    expect(events.filter((e) => e.type === "started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "ended")).toHaveLength(0);
    expect(recordingSources(state)).toEqual([{ appKey: "zoom", label: "zoom" }]);
  });

  it("uses the configured defaults for the thresholds", () => {
    expect(DEFAULT_START_THRESHOLD_MS).toBe(5_000);
    expect(DEFAULT_GRACE_MS).toBe(60_000);
  });
});

// The host's detection step over a `capture detect` sample (src/host/local-recording.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { resetLocalDetection, stepLocalPoll, type LocalPollOptions } from "../src/host/local-recording.js";
import type { AudioClientProcess } from "../src/host/local-sources.js";

const options: LocalPollOptions = { startThresholdMs: 5_000, graceMs: 60_000, apps: null, recording: [] };
const zoomInCall: AudioClientProcess[] = [
  { pid: 410, bundleId: "us.zoom.xos", input: true, output: true },
  { pid: 411, bundleId: "us.zoom.caphost", input: false, output: false },
];
const idle: AudioClientProcess[] = [{ pid: 410, bundleId: "us.zoom.xos", input: false, output: false }];
const zoom = { appKey: "zoom", label: "Zoom" };

describe("stepLocalPoll", () => {
  beforeEach(() => resetLocalDetection());

  it("starts a recording once the app has held the microphone for the threshold", () => {
    expect(stepLocalPoll(zoomInCall, options, 0)).toEqual({ supported: true, detected: [zoom], started: [], ended: [], error: null });
    expect(stepLocalPoll(zoomInCall, options, 4_000).started).toEqual([]);
    expect(stepLocalPoll(zoomInCall, options, 5_000).started).toEqual([zoom]);
    expect(stepLocalPoll(zoomInCall, options, 6_000).started).toEqual([]);
  });

  it("ignores an app that is not enabled, and every app when the list is explicitly empty", () => {
    for (const apps of [["browser"], []]) {
      resetLocalDetection();
      expect(stepLocalPoll(zoomInCall, { ...options, apps }, 0).detected).toEqual([]);
      expect(stepLocalPoll(zoomInCall, { ...options, apps }, 5_000).started).toEqual([]);
    }
  });

  it("classifies Telegram Desktop as Telegram", () => {
    const telegram: AudioClientProcess[] = [{ pid: 7, bundleId: "com.tdesktop.Telegram", input: true, output: false }];
    expect(stepLocalPoll(telegram, options, 0).detected).toEqual([{ appKey: "telegram", label: "Telegram" }]);
  });

  it("after a host restart ends a recording the server still holds once the app has been gone for the grace period", () => {
    const recording = { ...options, recording: ["zoom"] };
    expect(stepLocalPoll(idle, recording, 0).ended).toEqual([]);
    expect(stepLocalPoll(idle, recording, 59_000).ended).toEqual([]);
    expect(stepLocalPoll(idle, recording, 60_000).ended).toEqual([zoom]);
  });

  it("after a host restart does not start again a recording the server still holds", () => {
    const recording = { ...options, recording: ["zoom"] };
    expect(stepLocalPoll(zoomInCall, recording, 0).started).toEqual([]);
    expect(stepLocalPoll(zoomInCall, recording, 5_000).started).toEqual([]);
    expect(stepLocalPoll(zoomInCall, recording, 30_000)).toMatchObject({ started: [], ended: [] });
  });
});

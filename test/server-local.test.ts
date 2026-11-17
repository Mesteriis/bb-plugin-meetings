// Local recording auto-start (DESIGN §15): the scheduler polls detection on a
// macOS primary host and starts/stops one local meeting per source app.
import { describe, expect, it, vi } from "vitest";
import { createDetectionState } from "../src/host/local-detection.js";
import { envReport, hostCalls, load, until } from "./server-fixtures.js";

const T0 = Date.UTC(2026, 9, 13, 7, 0, 0);

function macSettings() {
  return {
    localRecordingEnabled: true,
    localAutoRecord: true,
    localStartThresholdSec: 5,
    localGraceSec: 60,
    localOwnerName: "Я",
    localCalendarTitles: true,
    voiceRecognition: true,
    localEngine: "whisper",
    localLanguage: "ru",
    localGlossary: "",
    localApps: "",
  };
}

async function loadMac() {
  const loaded = await load({ settings: macSettings(), now: () => T0 });
  loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
  return loaded;
}

function started(appKey: string, label: string) {
  return { appKey, label };
}

describe("local recording auto-record", () => {
  it("detection on a ~1 s cadence starts exactly one recording by 6 s for a 5 s hold", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { fake, service } = await load({ settings: macSettings() });
    fake.env = envReport({ platform: "darwin", arch: "arm64" });
    fake.detectionDriven = true;
    fake.detectionHeld.add("zoom");
    for (let t = 1; t <= 6; t += 1) {
      vi.setSystemTime(start + t * 1000);
      await service.pollLocalDetection();
    }
    const local = service.list("all", 50, null).meetings.filter((m) => m.source === "local");
    expect(local).toHaveLength(1);
    vi.useRealTimers();
  });

  it("restart with a live row and the app gone stops the recording after the grace period", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { fake, service } = await load({ settings: macSettings() });
    fake.env = envReport({ platform: "darwin", arch: "arm64" });
    fake.detectionDriven = true;
    fake.detectionHeld.add("zoom");
    for (let t = 1; t <= 6; t += 1) { vi.setSystemTime(start + t * 1000); await service.pollLocalDetection(); }
    const meeting = service.list("all", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    expect(meeting.status).toBe("recording");
    fake.detectionState = createDetectionState();
    fake.detectionHeld.clear();
    for (let t = 7; t <= 68; t += 1) { vi.setSystemTime(start + t * 1000); await service.pollLocalDetection(); }
    const after = service.list("all", 50, null).meetings.find((m) => m.id === meeting.id)!;
    expect(["recording", "joining", "starting", "waiting_room", "waiting_for_host"]).not.toContain(after.status);
    vi.useRealTimers();
  });

  it("restart with a live row and the app still holding starts no second recording", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { fake, service } = await load({ settings: macSettings() });
    fake.env = envReport({ platform: "darwin", arch: "arm64" });
    fake.detectionDriven = true;
    fake.detectionHeld.add("zoom");
    for (let t = 1; t <= 6; t += 1) { vi.setSystemTime(start + t * 1000); await service.pollLocalDetection(); }
    expect(service.list("all", 50, null).meetings.filter((m) => m.source === "local")).toHaveLength(1);
    fake.detectionState = createDetectionState();
    for (let t = 7; t <= 12; t += 1) { vi.setSystemTime(start + t * 1000); await service.pollLocalDetection(); }
    const after = service.list("all", 50, null).meetings.filter((m) => m.source === "local");
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("recording");
    expect(fake.localStartCalls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("two 2 s holds 15 s apart start no recording", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { fake, service } = await load({ settings: macSettings() });
    fake.env = envReport({ platform: "darwin", arch: "arm64" });
    fake.detectionDriven = true;
    fake.detectionHeld.add("zoom");
    for (let t = 1; t <= 17; t += 1) {
      vi.setSystemTime(start + t * 1000);
      if (t === 2) fake.detectionHeld.delete("zoom");
      if (t === 15) fake.detectionHeld.add("zoom");
      await service.pollLocalDetection();
    }
    const local = service.list("all", 50, null).meetings.filter((m) => m.source === "local");
    expect(local).toHaveLength(0);
    vi.useRealTimers();
  });

  it("creates exactly one local meeting and starts recording on a detected app", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.pollLocalDetection();
    const local = service.list("active", 50, null).meetings.filter((m) => m.source === "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.platform).toBe("local");
    expect(local[0]!.url).toBe("local://zoom");
    expect(local[0]!.status).toBe("recording");
    expect(fake.localStartCalls[0]).toMatchObject({ meetingId: local[0]!.id, appKey: "zoom" });
  });

  it("stops the recording when the meeting ends", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.pollLocalDetection();
    const before = service.list("active", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    expect(before.status).toBe("recording");
    fake.localPollResult = { supported: true, detected: [], started: [], ended: [started("zoom", "Zoom")], error: null };
    await service.pollLocalDetection();
    const after = service.list("all", 50, null).meetings.find((m) => m.id === before.id)!;
    expect(["recording", "joining", "starting", "waiting_room", "waiting_for_host"]).not.toContain(after.status);
  });

  it("a repeated started event for an ongoing local meeting starts no second recording", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.pollLocalDetection();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.pollLocalDetection();
    const local = service.list("all", 50, null).meetings.filter((m) => m.source === "local");
    expect(local).toHaveLength(1);
    expect(fake.localStartCalls).toHaveLength(1);
  });

  it("never polls when local recording is disabled", async () => {
    const { harness, fake, service } = await load({ settings: { ...macSettings(), localRecordingEnabled: false }, now: () => T0 });
    fake.env = envReport({ platform: "darwin", arch: "arm64" });
    await service.pollLocalDetection();
    expect(hostCalls(harness, "local.poll")).toHaveLength(0);
  });

  it("never polls on a non-macOS host", async () => {
    const { harness, fake, service } = await load({ settings: macSettings(), now: () => T0 });
    fake.env = envReport({ platform: "linux", arch: "x64" });
    await service.pollLocalDetection();
    expect(hostCalls(harness, "local.poll")).toHaveLength(0);
  });

  it("records from the microphone chosen in settings, or the meeting app's when none is chosen", async () => {
    for (const [setting, expected] of [["USB Video Bar", "USB Video Bar"], ["", ""]] as const) {
      const loaded = await load({ settings: { ...macSettings(), localMicrophone: setting }, now: () => T0 });
      loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
      loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
      await loaded.service.pollLocalDetection();
      expect(loaded.fake.localStartCalls[0]).toMatchObject({ inputDevice: expected });
    }
  });

  it("starts a live transcriber for a local recording on the next reconcile, unless live transcription is off", async () => {
    for (const [live, expected] of [[true, [{ mode: "live" }]], [false, []]] as const) {
      const loaded = await load({ settings: { ...macSettings(), liveTranscription: live }, now: () => T0 });
      loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
      loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
      await loaded.service.pollLocalDetection();
      loaded.fake.localPollResult = { supported: true, detected: [], started: [], ended: [], error: null };
      await loaded.service.tick();
      expect(loaded.fake.ensureCalls.map((call) => ({ mode: call.mode }))).toEqual(expected);
    }
  });

  it("remembers the voice of a speaker the owner names, unless voice recognition is off or the name is cleared", async () => {
    const cases = [
      { setting: true, name: "Анна", expected: [{ speakerKey: "spk:1", name: "Анна" }] },
      { setting: true, name: "", expected: [] },
      { setting: false, name: "Анна", expected: [] },
    ] as const;
    for (const { setting, name, expected } of cases) {
      const loaded = await load({ settings: { ...macSettings(), voiceRecognition: setting }, now: () => T0 });
      loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
      loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
      await loaded.service.pollLocalDetection();
      const id = loaded.service.list("all", 50, null).meetings[0]!.id;
      // The transcript's speakers, as a finished recording has them.
      (loaded.service as unknown as { repo: { updateMeeting(id: string, patch: object): unknown } }).repo.updateMeeting(id, {
        speakers: [{ key: "spk:1", label: "Спикер 1", source: "acoustic", talkSec: 40, segments: 9 }],
      });
      loaded.service.renameSpeaker(id, "spk:1", name);
      await loaded.service.voicesSettled();
      expect(loaded.fake.voiceLearnCalls).toEqual(expected.map((call) => ({ meetingId: id, ...call })));
    }
  });

  it("passes the voice recognition setting to the transcriber and lists and forgets voices", async () => {
    const loaded = await load({ settings: { ...macSettings(), voiceRecognition: false }, now: () => T0 });
    expect(loaded.service.transcriberConfig({ ...macSettings(), voiceRecognition: false, diarization: "ui+acoustic", speakerLagMs: 700, keepRawAudio: false } as never, null)).toEqual({
      gigaamUrl: null, diarization: "ui+acoustic", speakerLagMs: 700, keepRawAudio: false, threads: 0, recognizeVoices: false,
    });
    loaded.fake.voices = [{ name: "Анна", seconds: 42, meetings: 1, updatedAt: 5 }];
    expect(await loaded.service.listVoices()).toEqual([{ name: "Анна", seconds: 42, meetings: 1, updatedAt: 5 }]);
    expect(await loaded.service.forgetVoice("Анна")).toEqual([]);
  });

  it("builds the speaker naming request from the meeting, its speakers and the calendar's invitees", async () => {
    const loaded = await load({ settings: macSettings(), now: () => T0 });
    loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
    loaded.fake.calendarLookup = { access: "granted", title: "Созвон с заказчиком", attendees: ["Анна Смирнова"] };
    loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await loaded.service.pollLocalDetection();
    await loaded.service.localTitlesSettled();
    const id = loaded.service.list("all", 50, null).meetings[0]!.id;
    expect(() => loaded.service.namingPrompt(id)).toThrow(/Дождитесь окончательного транскрипта/);
    (loaded.service as unknown as { repo: { updateMeeting(id: string, patch: object): unknown } }).repo.updateMeeting(id, {
      transcriptFinal: true,
      speakers: [
        { key: "spk:1", label: "Спикер 1", source: "acoustic", talkSec: 90, segments: 9 },
        { key: "ui:Я", label: "Я", source: "ui", talkSec: 30, segments: 4 },
      ],
    });
    const prompt = loaded.service.namingPrompt(id);
    expect(prompt).toContain(`«Созвон с заказчиком» (id: ${id})`);
    expect(prompt).toContain("- spk:1 — «Спикер 1», 1 мин 30 с, 75 % речи");
    expect(prompt).toContain("Уже названы, не переименовывай: «Я» (ui:Я).");
    expect(prompt).toContain("Приглашённые по календарю (кто-то мог не прийти, мог прийти кто-то ещё): Анна Смирнова.");
  });

  it("names a local recording after the calendar event it belongs to", async () => {
    const loaded = await load({ settings: macSettings(), now: () => T0 });
    loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
    loaded.fake.calendarLookup = { access: "granted", title: "Созвон с заказчиком", attendees: ["Анна"] };
    loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await loaded.service.pollLocalDetection();
    await loaded.service.localTitlesSettled();
    expect(hostCalls(loaded.harness, "local.calendarEvent").map((call) => call.input)).toEqual([{ appKey: "zoom", at: T0 }]);
    expect(loaded.service.list("all", 50, null).meetings.map((m) => m.title)).toEqual(["Созвон с заказчиком"]);
  });

  it("keeps the default title when no event fits, access is refused, the lookup fails or the setting is off", async () => {
    const cases = [
      { lookup: { access: "granted", title: null, attendees: [] }, setting: true, calls: 1 },
      { lookup: { access: "denied", title: null, attendees: [] }, setting: true, calls: 1 },
      { lookup: "throw", setting: true, calls: 1 },
      { lookup: { access: "granted", title: "Созвон с заказчиком", attendees: [] }, setting: false, calls: 0 },
    ] as const;
    for (const { lookup, setting, calls } of cases) {
      const loaded = await load({ settings: { ...macSettings(), localCalendarTitles: setting }, now: () => T0 });
      loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
      loaded.fake.calendarLookup = lookup;
      loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
      await loaded.service.pollLocalDetection();
      await loaded.service.localTitlesSettled();
      expect(hostCalls(loaded.harness, "local.calendarEvent")).toHaveLength(calls);
      expect(loaded.service.list("all", 50, null).meetings.map((m) => m.title)).toEqual(["Zoom — локальная запись"]);
    }
  });

  it("keeps the local speech settings through start and retranscribe", async () => {
    const loaded = await load({ settings: { ...macSettings(), localGlossary: "термин", localOwnerName: "Я", localLanguage: "ru" }, now: () => T0 });
    loaded.fake.env = envReport({ platform: "darwin", arch: "arm64" });
    loaded.fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await loaded.service.pollLocalDetection();
    expect(loaded.fake.localStartCalls[0]).toMatchObject({ engine: "whisper", glossary: "термин", ownerName: "Я" });
    const meeting = loaded.service.list("all", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    loaded.fake.localPollResult = { supported: true, detected: [], started: [], ended: [started("zoom", "Zoom")], error: null };
    await loaded.service.pollLocalDetection();
    await loaded.service.retranscribe(meeting.id);
    expect(loaded.fake.ensureCalls.at(-1)).toMatchObject({ meetingId: meeting.id, mode: "offline" });
    expect(loaded.fake.ensureTranscriberArgs.at(-1)).toMatchObject({ engine: "whisper", glossary: "термин", ownerName: "Я" });
  });

  it("a local recording has audio and meeting.readFile serves audio.ogg bytes", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.pollLocalDetection();
    const meeting = service.list("all", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    expect(meeting.hasAudio).toBe(true);
    // GET /audio?id=… streams audio.ogg through meeting.readFile.
    const read = fake.handle("meeting.readFile", { meetingId: meeting.id, file: "audio.ogg", offset: 0, length: 4096 }) as { base64: string | null };
    expect(read.base64).not.toBeNull();
  });

  it("Stop issued while local.start is in flight ends with a terminal row", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handle = fake.handle.bind(fake);
    fake.handle = (method, input) => (method === "local.start" ? gate.then(() => handle(method, input)) : handle(method, input));
    const poll = service.pollLocalDetection();
    await until(() => service.list("all", 50, null).meetings.some((m) => m.source === "local"));
    const id = service.list("all", 50, null).meetings.find((m) => m.source === "local")!.id;
    const stop = service.stop(id);
    release();
    await poll;
    const after = await stop;
    expect(["recording", "joining", "starting", "waiting_room", "waiting_for_host"]).not.toContain(after.status);
  });


describe("detection timer", () => {
  function run(settings: Record<string, string | number | boolean>, envPlatform: string, envArch: string) {
    return load({ settings }).then((loaded) => {
      loaded.fake.env = envReport({ platform: envPlatform as never, arch: envArch });
      return loaded;
    });
  }

  async function drive(service: Awaited<ReturnType<typeof load>>["service"], signal: AbortSignal, ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("feature off keeps tick at the idle cadence and never polls detection", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { harness, fake, service } = await run({ ...macSettings(), localRecordingEnabled: false }, "darwin", "arm64");
    const tick = vi.spyOn(service, "tick");
    const controller = new AbortController();
    const sched = service.runScheduler(controller.signal);
    const det = service.runLocalDetection(controller.signal);
    await drive(service, controller.signal, 30_000);
    expect(hostCalls(harness, "local.poll")).toHaveLength(0);
    expect(tick.mock.calls.length).toBeLessThan(5);
    controller.abort();
    await Promise.all([sched, det]);
    vi.useRealTimers();
  });

  it("Linux host never polls detection", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { harness, service } = await run(macSettings(), "linux", "x64");
    const controller = new AbortController();
    const sched = service.runScheduler(controller.signal);
    const det = service.runLocalDetection(controller.signal);
    await drive(service, controller.signal, 30_000);
    expect(hostCalls(harness, "local.poll")).toHaveLength(0);
    controller.abort();
    await Promise.all([sched, det]);
    vi.useRealTimers();
  });

  it("feature on polls detection about every 1s while tick keeps its 15s cadence", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { harness, service } = await run(macSettings(), "darwin", "arm64");
    const tick = vi.spyOn(service, "tick");
    const controller = new AbortController();
    const sched = service.runScheduler(controller.signal);
    const det = service.runLocalDetection(controller.signal);
    await drive(service, controller.signal, 30_000);
    const polls = hostCalls(harness, "local.poll").length;
    expect(polls).toBeGreaterThanOrEqual(25);
    expect(polls).toBeLessThanOrEqual(35);
    expect(tick.mock.calls.length).toBeLessThan(5);
    controller.abort();
    await Promise.all([sched, det]);
    vi.useRealTimers();
  });

  it("a throwing tick does not stop detection", async () => {
    vi.useFakeTimers();
    const start = Date.UTC(2026, 9, 13, 7, 0, 0);
    vi.setSystemTime(start);
    const { harness, service } = await run(macSettings(), "darwin", "arm64");
    vi.spyOn(service, "tick").mockRejectedValue(new Error("boom"));
    const controller = new AbortController();
    const sched = service.runScheduler(controller.signal);
    const det = service.runLocalDetection(controller.signal);
    await drive(service, controller.signal, 30_000);
    expect(hostCalls(harness, "local.poll").length).toBeGreaterThan(0);
    controller.abort();
    await Promise.all([sched, det]);
    vi.useRealTimers();
  });
});


  it("a host poll error does not stop a running recording", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.pollLocalDetection();
    const meeting = service.list("active", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    fake.localPollError = "capture detect failed";
    await service.pollLocalDetection();
    const after = service.list("all", 50, null).meetings.find((m) => m.id === meeting.id)!;
    expect(after.status).toBe("recording");
  });
});

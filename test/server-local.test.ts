// Local recording auto-start (DESIGN §15): the scheduler polls detection on a
// macOS primary host and starts/stops one local meeting per source app.
import { describe, expect, it } from "vitest";
import { envReport, hostCalls, load } from "./server-fixtures.js";

const T0 = Date.UTC(2026, 9, 13, 7, 0, 0);

function macSettings() {
  return {
    localRecordingEnabled: true,
    localAutoRecord: true,
    localStartThresholdSec: 5,
    localGraceSec: 60,
    localOwnerName: "Я",
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
  it("creates exactly one local meeting and starts recording on a detected app", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.tick();
    const local = service.list("active", 50, null).meetings.filter((m) => m.source === "local");
    expect(local).toHaveLength(1);
    expect(local[0]!.platform).toBe("local");
    expect(local[0]!.url).toBe("local://zoom");
    expect(local[0]!.status).toBe("recording");
    expect(fake.localStartCalls).toEqual([{ meetingId: local[0]!.id, appKey: "zoom" }]);
  });

  it("stops the recording when the meeting ends", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.tick();
    const before = service.list("active", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    expect(before.status).toBe("recording");
    fake.localPollResult = { supported: true, detected: [], started: [], ended: [started("zoom", "Zoom")], error: null };
    await service.tick();
    const after = service.list("all", 50, null).meetings.find((m) => m.id === before.id)!;
    expect(["recording", "joining", "starting", "waiting_room", "waiting_for_host"]).not.toContain(after.status);
  });

  it("a repeated started event for an ongoing local meeting starts no second recording", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.tick();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.tick();
    const local = service.list("all", 50, null).meetings.filter((m) => m.source === "local");
    expect(local).toHaveLength(1);
    expect(fake.localStartCalls).toHaveLength(1);
  });

  it("never polls when local recording is disabled", async () => {
    const { harness, fake, service } = await load({ settings: { ...macSettings(), localRecordingEnabled: false }, now: () => T0 });
    fake.env = envReport({ platform: "darwin", arch: "arm64" });
    await service.tick();
    expect(hostCalls(harness, "local.poll")).toHaveLength(0);
  });

  it("never polls on a non-macOS host", async () => {
    const { harness, fake, service } = await load({ settings: macSettings(), now: () => T0 });
    fake.env = envReport({ platform: "linux", arch: "x64" });
    await service.tick();
    expect(hostCalls(harness, "local.poll")).toHaveLength(0);
  });

  it("serves the local recording's audio through the detail page route", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.tick();
    const meeting = service.list("all", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    expect(meeting.hasAudio).toBe(true);
    // GET /audio?id=… streams audio.ogg through meeting.readFile.
    const read = fake.handle("meeting.readFile", { meetingId: meeting.id, file: "audio.ogg", offset: 0, length: 4096 }) as { base64: string | null };
    expect(read.base64).not.toBeNull();
  });

  it("a host poll error does not stop a running recording", async () => {
    const { fake, service } = await loadMac();
    fake.localPollResult = { supported: true, detected: [], started: [started("zoom", "Zoom")], ended: [], error: null };
    await service.tick();
    const meeting = service.list("active", 50, null).meetings.filter((m) => m.source === "local")[0]!;
    fake.localPollError = "capture detect failed";
    await service.tick();
    const after = service.list("all", 50, null).meetings.find((m) => m.id === meeting.id)!;
    expect(after.status).toBe("recording");
  });
});

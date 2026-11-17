// config.json's transcriber block has two writers (src/host/meetings.ts): the
// server's settings and the calendar roster. Neither may undo the other.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalModelPatch, mergeConfigTranscriber, setTranscriberRoster, stopEscalationMs } from "../src/host/meetings.js";
import { hostPaths } from "../src/host/paths.js";

describe("stopEscalationMs", () => {
  it("gives a local recording fifteen minutes to compress its streams, a bot 45 seconds to leave", () => {
    expect(stopEscalationMs("local")).toBe(900_000);
    expect(stopEscalationMs("zoom")).toBe(45_000);
    expect(stopEscalationMs(undefined)).toBe(45_000);
  });
});

describe("mergeConfigTranscriber", () => {
  let root: string;
  let dir: string;
  const meetingId = "mtg_config000001";
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "config-merge-"));
    dir = path.join(hostPaths(root).meetings, meetingId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ meetingId, transcriber: { ownerName: "Я" } }));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("keeps both the roster and the settings when they are written at the same time", async () => {
    await Promise.all([
      mergeConfigTranscriber(dir, { engine: "whisper" }),
      setTranscriberRoster(hostPaths(root), meetingId, ["a@x.io"]),
      mergeConfigTranscriber(dir, { language: "ru" }),
    ]);
    expect(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"))).toEqual({
      meetingId,
      transcriber: { ownerName: "Я", engine: "whisper", roster: ["a@x.io"], language: "ru" },
    });
  });

  it("writes the calendar hints next to the roster", async () => {
    await setTranscriberRoster(hostPaths(root), meetingId, ["a@x.io"], ["Дейли", "Анна"]);
    expect(JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")).transcriber).toEqual({ ownerName: "Я", roster: ["a@x.io"], hints: ["Дейли", "Анна"] });
  });

  it("points the transcriber at the exact model only when it was asked for and is downloaded", async () => {
    const paths = hostPaths(root);
    expect(await finalModelPatch(paths, "large-v3")).toEqual({ whisperFinalModel: "" });
    await fs.mkdir(paths.whisperFinalModel, { recursive: true });
    // A directory without the completion marker is an interrupted download.
    expect(await finalModelPatch(paths, "large-v3")).toEqual({ whisperFinalModel: "" });
    await fs.writeFile(path.join(paths.whisperFinalModel, ".complete"), "{}");
    expect(await finalModelPatch(paths, "large-v3")).toEqual({ whisperFinalModel: paths.whisperFinalModel });
    expect(await finalModelPatch(paths, undefined)).toEqual({ whisperFinalModel: "" });
  });

  it("reports a meeting without a config instead of creating one", async () => {
    await fs.rm(path.join(dir, "config.json"));
    expect(await setTranscriberRoster(hostPaths(root), meetingId, ["a@x.io"])).toBe(false);
  });
});

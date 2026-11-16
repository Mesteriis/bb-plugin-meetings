// Platform selection for bot vs local recording (DESIGN §1, §15).
import { describe, expect, it } from "vitest";
import { botPlatformProblem, isMacArm64, platformProblem, uvDownload, WHISPER_MODEL } from "../src/host/platform.js";

describe("uvDownload", () => {
  it("pins the uv 0.13.0 asset for darwin-arm64 with its release sha256", () => {
    expect(uvDownload("darwin", "arm64")).toEqual({
      target: "aarch64-apple-darwin",
      sha256: "a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6",
      url: "https://github.com/astral-sh/uv/releases/download/0.13.0/uv-aarch64-apple-darwin.tar.gz",
    });
  });

  it("keeps the Linux bot assets", () => {
    expect(uvDownload("linux", "x64")?.target).toBe("x86_64-unknown-linux-musl");
    expect(uvDownload("linux", "arm64")?.target).toBe("aarch64-unknown-linux-musl");
    expect(uvDownload("win32", "x64")).toBeNull();
  });
});

describe("platform selection", () => {
  it("supports local recording only on darwin-arm64, the bot only on Linux", () => {
    expect(isMacArm64("darwin", "arm64")).toBe(true);
    expect(isMacArm64("darwin", "x64")).toBe(false);
    expect(isMacArm64("linux", "arm64")).toBe(false);
    expect(platformProblem("darwin", "arm64")).toBeNull();
    expect(platformProblem("linux", "x64")).toBeNull();
    expect(botPlatformProblem("darwin", "arm64")).toContain("только на Linux");
    expect(botPlatformProblem("linux", "x64")).toBeNull();
  });
});

describe("WHISPER_MODEL", () => {
  it("pins the local Whisper model", () => {
    expect(WHISPER_MODEL.repo).toBe("mlx-community/whisper-large-v3-turbo");
    expect(WHISPER_MODEL.diskBytes).toBeGreaterThan(1_000_000_000);
  });
});

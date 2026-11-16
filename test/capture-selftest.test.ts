// Compiles the Swift capture helper and runs its self-test (the timeline mixer,
// the stream clock, the capture-issue rules, the microphone choice and its restart rules). macOS with swiftc only.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = path.join(import.meta.dirname, "..", "runtime", "capture", "main.swift");
const hasSwift = process.platform === "darwin" && spawnSync("swiftc", ["--version"]).status === 0;

describe.skipIf(!hasSwift)("capture helper", () => {
  it("compiles and passes its self-test", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-selftest-"));
    try {
      const binary = path.join(dir, "capture");
      execFileSync("swiftc", ["-module-cache-path", path.join(dir, "mc"), source, "-o", binary], { stdio: "pipe" });
      const result = spawnSync(binary, ["selftest"], { encoding: "utf8" });
      const lines = result.stdout.trim().split("\n");
      expect(lines.filter((line) => !line.endsWith(": ok"))).toEqual([]);
      expect(lines).toHaveLength(43);
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

// The embedded runtime must be the exact copy of runtime/** on disk (DESIGN §3):
// setup compiles and runs the embedded copies, not the working tree. Regenerate with npm run embed.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_FILES, RUNTIME_HASH } from "../src/generated/runtime-files.js";
import { collectRuntimeFiles, renderRuntimeFiles, runtimeDir } from "../scripts/embed-runtime.mjs";

describe("embedded runtime", () => {
  it("matches every runtime file on disk and the hash", () => {
    const disk = collectRuntimeFiles(runtimeDir);
    expect(RUNTIME_FILES).toEqual(disk);
    expect(renderRuntimeFiles(disk)).toContain("export const RUNTIME_HASH = " + JSON.stringify(RUNTIME_HASH) + ";");
  });
});

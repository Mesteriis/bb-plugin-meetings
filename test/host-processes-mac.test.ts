// macOS process inspection without /proc (src/host/processes-mac.ts):
// liveness, the command line, the working directory, and PID-reuse safety.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { listProcsMac, readProcMac } from "../src/host/processes-mac.js";

const mac = describe.runIf(process.platform === "darwin");

const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
});

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

mac("readProcMac", () => {
  it("reads a live process's pid, state, command line and working directory", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "meetings-proc-"));
    const child = spawn("sleep", ["30"], { cwd, detached: true, stdio: "ignore" });
    strays.push(child.pid!);
    const proc = await waitFor(() => readProcMac(child.pid!), (p) => p !== null);
    expect(proc).not.toBeNull();
    expect(proc!.pid).toBe(child.pid);
    expect(proc!.state).not.toBe("Z");
    expect(proc!.argv).toContain("sleep");
    expect(proc!.cwd).toBe(await fs.realpath(cwd));
  });

  it("returns null for a dead pid (a reused pid cannot be mistaken for ours)", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    strays.push(child.pid!);
    await waitFor(() => readProcMac(child.pid!), (p) => p !== null);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    process.kill(child.pid!, "SIGKILL");
    await exited;
    expect(await readProcMac(child.pid!)).toBeNull();
  });

  it("listProcsMac includes a spawned process and never the current process", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    strays.push(child.pid!);
    await waitFor(() => listProcsMac(), (procs) => procs.some((p) => p.pid === child.pid));
    const procs = await listProcsMac();
    expect(procs.map((p) => p.pid)).toContain(child.pid);
    expect(procs.map((p) => p.pid)).not.toContain(process.pid);
  });
});

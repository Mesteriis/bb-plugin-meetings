// macOS process inspection without /proc (docs/dev/DESIGN.md §15): ps for
// liveness, state, pgid, controlling terminal and the command line, lsof for
// the working directory. argv is the command line split on whitespace, which
// is enough to find the capture helper (capture record --meeting-dir <dir>)
// and to tear down everything that belongs to a meeting.
import { run } from "./exec.js";
import type { ProcInfo } from "./processes.js";

const PS_TIMEOUT_MS = 10_000;

export async function readProcMac(pid: number): Promise<ProcInfo | null> {
  const ps = await run("ps", ["-o", "pgid=", "-o", "state=", "-o", "tty=", "-o", "command=", "-p", String(pid)], {
    timeoutMs: PS_TIMEOUT_MS,
  }).catch(() => null);
  if (ps === null || ps.code !== 0) return null;
  const line = ps.stdout.trim();
  const match = /^(\d+)\s+(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
  if (match === null) return null;
  const pgid = match[1];
  const state = match[2];
  const tty = match[3];
  const command = match[4];
  const lsof = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: PS_TIMEOUT_MS }).catch(() => null);
  const cwdMatch = /^n(.*)$/m.exec(lsof?.stdout ?? "");
  return {
    pid,
    pgid: Number(pgid),
    state: (state ?? "?")[0] ?? "?",
    tty: tty === "??" || tty === "" ? 0 : 1,
    cwd: cwdMatch?.[1] ?? null,
    argv: command.split(/\s+/).filter((arg) => arg !== ""),
  };
}

export async function listProcsMac(): Promise<ProcInfo[]> {
  const [ps, lsof] = await Promise.all([
    run("ps", ["-axo", "pid=", "-o", "pgid=", "-o", "state=", "-o", "tty=", "-o", "command="], { timeoutMs: PS_TIMEOUT_MS }).catch(() => null),
    run("lsof", ["-d", "cwd", "-Fpn"], { timeoutMs: PS_TIMEOUT_MS }).catch(() => null),
  ]);
  if (ps === null || ps.code !== 0) return [];
  // lsof -d cwd -Fpn: p<pid>, then f<n>, then n<path>, repeated per process.
  const cwdByPid = new Map<number, string>();
  if (lsof !== null && lsof.code === 0) {
    let pid = 0;
    for (const line of lsof.stdout.split("\n")) {
      if (line.startsWith("p")) {
        pid = Number(line.slice(1));
      } else if (line.startsWith("n") && pid > 0) {
        cwdByPid.set(pid, line.slice(1));
        pid = 0;
      }
    }
  }
  const procs: ProcInfo[] = [];
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    procs.push({
      pid,
      pgid: Number(match[2]),
      state: (match[3] ?? "?")[0] ?? "?",
      tty: match[4] === "??" || match[4] === "" ? 0 : 1,
      cwd: cwdByPid.get(pid) ?? null,
      argv: match[5].split(/\s+/).filter((arg) => arg !== ""),
    });
  }
  return procs;
}

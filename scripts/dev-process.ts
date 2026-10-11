import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import type { Readable } from "node:stream";

/**
 * Small process helpers shared by the development launchers (scripts/dev.ts, scripts/dev-mock.ts). No dependencies, and
 * written for Windows first: a child must never outlive the launcher, whether it is stopped with Ctrl+C, by closing the
 * console window, or by a plain kill.
 */

/** Starts `node <args>` as a managed child whose output is piped (so the launcher can prefix it). On POSIX it leads its own process group. */
export function startNode(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(process.execPath, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}

/** Stops a child and everything it started (next dev starts workers). Synchronous, so it also works from an `exit` handler. */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM"); // the whole process group
  } catch {
    child.kill("SIGTERM");
  }
}

/** Prints a child's output line by line with a prefix, whatever way it is chunked. `onLine` sees every line (for "Ready" detection). */
export function pipeLines(stream: NodeJS.ReadableStream, prefix: string, out: NodeJS.WriteStream, onLine?: (line: string) => void): void {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) {
      out.write(`${prefix} ${line}\n`);
      onLine?.(line);
    }
  });
  stream.on("end", () => {
    if (rest) out.write(`${prefix} ${rest}\n`);
  });
}

/**
 * Calls `stop` on Ctrl+C, a plain kill and a closed console window (SIGHUP; SIGBREAK on Windows), and registers `cleanup` as the
 * last-resort synchronous `exit` handler, so no child is left running behind a closed window.
 */
export function onShutdown(stop: () => void, cleanup: () => void): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(signal, stop);
    } catch {
      /* a signal this platform does not have */
    }
  }
  process.on("exit", cleanup);
}

/** True when something accepts connections on this port on the loopback interface (IPv4 or IPv6). */
export async function portInUse(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      const done = (busy: boolean) => {
        socket.destroy();
        resolve(busy);
      };
      socket.setTimeout(500, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  const [v4, v6] = await Promise.all([tryHost("127.0.0.1"), tryHost("::1")]);
  return v4 || v6;
}

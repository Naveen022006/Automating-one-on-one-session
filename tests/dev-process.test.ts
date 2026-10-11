// scripts/dev-process.ts: the process helpers of the development launchers (npm run dev, dev:hmr, dev:mock). The point of the
// file: a stopped launcher must not leave `next dev` (or anything it started) running, on Windows as much as anywhere. No database.
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { killTree, pipeLines, portInUse, startNode } from "../scripts/dev-process";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

test("portInUse: true while something listens on the loopback port, false once it is closed", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  assert.equal(await portInUse(port), true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await portInUse(port), false);
});

test("killTree stops the child and the process it started (next dev starts a second process)", async () => {
  // The child starts a grandchild and prints its pid, like `next dev` and its server process.
  const child = startNode(
    ["-e", "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('grandchild ' + c.pid); setInterval(() => {}, 1000);"],
    { cwd: process.cwd(), env: process.env },
  );
  let grandchild = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const m = /grandchild (\d+)/.exec(chunk);
    if (m) grandchild = Number(m[1]);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.ok(await until(() => grandchild > 0), "the grandchild started");
  assert.ok(child.pid && alive(child.pid) && alive(grandchild));

  killTree(child);
  await exited;
  assert.ok(await until(() => !alive(grandchild)), "the grandchild is gone too");
  killTree(child); // a second call on a stopped child does nothing
});

test("pipeLines prefixes whole lines, whatever way the output is chunked, and reports each line", async () => {
  const input = new PassThrough();
  const written: string[] = [];
  const out = { write: (s: string) => void written.push(s) } as unknown as NodeJS.WriteStream;
  const seen: string[] = [];
  pipeLines(input, "[x]", out, (line) => seen.push(line));
  input.write("first li");
  input.write("ne\nsecond\r\nthi");
  input.end("rd");
  await new Promise((r) => input.once("end", r));
  assert.deepEqual(written, ["[x] first line\n", "[x] second\n", "[x] third\n"]);
  assert.deepEqual(seen, ["first line", "second"], "onLine sees complete lines as they arrive");
});

import "../support/home-sandbox.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { GATEWAY_PROTOCOL_VERSION, gatewayEndpoint, gatewayProof, readFrames, verifyProof, writeFrame, type ServerFrame } from "../../src/shared/gateway-protocol.ts";

async function until(predicate: () => boolean, description: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test("real pi processes elect one detached gateway, survive the first pi exit and stop after the last exit", { timeout: 30_000 }, async (t) => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}`;
  const received: any[] = [];
  const connections: WebSocket[] = [];
  upstream.on("connection", (socket) => {
    connections.push(socket);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      if (["aibot_subscribe", "aibot_send_msg", "ping"].includes(frame.cmd)) socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
    });
  });
  const workers: { child: ChildProcess; frames: any[]; stderr: string; exited: boolean }[] = [];
  const daemonPids = new Set<number>();
  const config = { botId: `process-test-${randomUUID()}`, secret: "offline-process-secret", enabled: true, welcome: "hello" };
  t.after(async () => {
    for (const worker of workers) if (!worker.exited) worker.child.kill();
    for (const pid of daemonPids) if (alive(pid)) { try { process.kill(pid); } catch { /* already exited */ } }
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  function pi(id: string) {
    const entry = fileURLToPath(new URL("../fixtures/pi-worker.mjs", import.meta.url));
    const child = spawn(process.execPath, [entry, url], { windowsHide: true, stdio: ["pipe", "ignore", "pipe", "ipc"] });
    const worker = { child, frames: [] as any[], stderr: "", exited: false };
    workers.push(worker);
    child.stderr!.on("data", (chunk) => { worker.stderr += chunk; });
    child.on("message", (frame: any) => { worker.frames.push(frame); if (frame.type === "daemon") daemonPids.add(frame.pid); });
    child.on("exit", () => { worker.exited = true; });
    child.stdin!.end(JSON.stringify({ config, source: { sessionId: `session-${id}`, provider: `provider-${id}`, modelName: `model-${id}`, directoryName: `project-${id}` } }));
    return worker;
  }
  // Start contenders together to exercise process-level election, not an in-memory singleton.
  const a = pi("A");
  const b = pi("B");
  const c = pi("C");
  await until(() => workers.every((worker) => worker.frames.some((frame) => frame.type === "state" && frame.state === "subscribed") || worker.exited), "all pi registrations");
  for (const worker of workers) assert.equal(worker.exited, false, worker.stderr);
  assert.equal(received.filter((frame) => frame.cmd === "aibot_subscribe").length, 1);
  assert.equal(connections.length, 1);
  assert.ok(daemonPids.size >= 1);
  const winner = connections[0];
  winner.send(JSON.stringify({ cmd: "aibot_msg_callback", headers: { req_id: "quote-B" }, body: {
    msgid: "quote-B", from: { userid: "user" }, chattype: "single", msgtype: "text", text: { content: "B task" },
    quote: { msgtype: "text", text: { content: "session: session-B" } },
  } }));
  await until(() => b.frames.some((frame) => frame.type === "inbound"), "quoted reply reaches B");
  assert.equal(a.frames.some((frame) => frame.type === "inbound"), false);
  assert.equal(c.frames.some((frame) => frame.type === "inbound"), false);
  // Kill the pi that bootstrapped the winning daemon when possible; no graceful unregister.
  const liveDaemon = [...daemonPids].find(alive)!;
  const starter = workers.find((worker) => worker.frames.some((frame) => frame.type === "daemon" && frame.pid === liveDaemon))!;
  assert.ok(starter);
  starter.child.kill();
  await until(() => starter.exited, "first pi exits");
  const survivors = workers.filter((worker) => worker !== starter);
  for (const [index, worker] of survivors.entries()) worker.child.send!({ type: "send", id: index, chatId: `user-${index}`, content: `survivor-result-${index}` });
  await until(() => survivors.every((worker) => worker.frames.some((frame) => frame.type === "sent")), "survivors can still send");
  assert.equal(connections.length, 1);
  for (const frame of received.filter((item) => item.cmd === "aibot_send_msg")) {
    const text = frame.body.markdown.content;
    const match = /project-([ABC]).*\n🏷️ provider-\1 · model-\1.*\n🆔 session: session-\1/.exec(text);
    assert.ok(match, "source fields must stay in the same pi session");
  }
  survivors[0].child.send!({ type: "quit" });
  await until(() => survivors[0].exited, "one remaining pi exits normally");
  assert.equal(winner.readyState, WebSocket.OPEN);
  survivors[1].child.kill();
  await until(() => survivors[1].exited, "last pi exits");
  await until(() => winner.readyState === WebSocket.CLOSED && [...daemonPids].every((pid) => !alive(pid)), "all detached gateways exit");
});

test("the packaged gateway boots under node_modules with runtime dependencies only", { timeout: 15_000 }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-package-test-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const packaged = join(sandbox, "node_modules", "pi-wecom-aibot");
  await mkdir(join(packaged, "node_modules"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await Promise.all(["package.json", ...manifest.files].map((file: string) => cp(join(root, file), join(packaged, file), { recursive: true })));
  await cp(dirname(fileURLToPath(import.meta.resolve("ws"))), join(packaged, "node_modules", "ws"), { recursive: true });
  const config = { botId: `packaged-test-${randomUUID()}`, secret: "private-bootstrap-secret", enabled: true, welcome: "hello" };
  const endpoint = gatewayEndpoint(config.botId);
  const child = spawn(process.execPath, [join(packaged, "src/gateway/main.mjs")], { cwd: sandbox, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let exited = false;
  let stderr = "";
  let socket: Socket | undefined;
  const finished = new Promise<void>((resolve) => child.once("exit", () => { exited = true; resolve(); }));
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdin!.end(JSON.stringify({ endpoint, credentials: { botId: config.botId, secret: config.secret } }));
  t.after(async () => {
    socket?.destroy();
    if (!exited) child.kill();
    await finished;
    assert.equal(dirname(sandbox), tmpdir());
    await rm(sandbox, { recursive: true, force: true });
  });
  let hello: Extract<ServerFrame, { type: "hello" }> | undefined;
  let nonce = "";
  const deadline = Date.now() + 8000;
  while (!hello) {
    assert.equal(exited, false, stderr);
    assert.ok(Date.now() < deadline, `packaged gateway startup timeout: ${stderr}`);
    const attempt = randomUUID();
    nonce = attempt;
    socket = createConnection(endpoint);
    socket.on("error", () => {});
    readFrames(socket, (frame: ServerFrame) => { if (frame.type === "hello" && nonce === attempt) hello = frame; });
    const current = socket;
    current.once("connect", () => writeFrame(current, { type: "hello", version: GATEWAY_PROTOCOL_VERSION, nonce: attempt }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!hello) socket.destroy();
  }
  assert.equal(verifyProof(hello.proof, gatewayProof(config.secret, "server", hello.nonce, nonce, endpoint)), true);
  // No registration is sent, so this test never opens the real WeCom connection.
});

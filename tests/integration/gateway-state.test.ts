import "../support/home-sandbox.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { GatewaySelectionStore } from "../../src/gateway/selection-store.ts";
import { WeComGateway, type GatewayPeer } from "../../src/gateway/runtime.ts";
import { gatewayEndpoint, type GatewayRegistration, type ServerFrame } from "../../src/shared/gateway-protocol.ts";
import { GatewayClient } from "../../src/extension/gateway-client.ts";
import { startGatewayServer } from "../../src/gateway/server.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";
import { randomUUID } from "node:crypto";

let sandbox: string;
let file: string;
let gateways: WeComGateway[];

function create() {
  const gateway = new WeComGateway({ botId: "test", secret: "secret", createWebSocket: (url) => new FakeWebSocket(url) }, undefined, new GatewaySelectionStore(file));
  gateways.push(gateway);
  return gateway;
}

function add(gateway: WeComGateway, id: string) {
  const frames: ServerFrame[] = [];
  const peer: GatewayPeer = { send(frame) { frames.push(frame); return true; }, close() {} };
  const registration: GatewayRegistration = {
    instanceId: `pi-${id}`, registrationId: `registration-${id}`,
    source: { sessionId: `session-${id}`, provider: id, modelName: id, directoryName: id },
    config: { botId: "test", welcome: "hello" },
  };
  gateway.register(registration, peer);
  const ws = FakeWebSocket.instances.at(-1)!;
  if (ws.readyState === 0) { ws.open(); ws.acknowledge(); }
  return { frames, ws, peer, registration };
}

function message(content: string) {
  const id = randomUUID();
  FakeWebSocket.instances.at(-1)!.receive({ cmd: "aibot_msg_callback", headers: { req_id: id }, body: {
    msgid: id, from: { userid: "user" }, chattype: "single", msgtype: "text", text: { content },
  } });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-state-test-"));
  file = join(sandbox, "bindings.json");
  gateways = [];
  FakeWebSocket.instances = [];
});
afterEach(async () => {
  for (const gateway of gateways) gateway.stop();
  assert.equal(dirname(sandbox), tmpdir());
  await rm(sandbox, { recursive: true, force: true });
});

test("gateway recovery does not redirect a prior choice to the first different pi that reconnects", async () => {
  const first = create();
  add(first, "A"); add(first, "B");
  message("/wecom use session-A");
  const saved = await readFile(file, "utf8");
  assert.match(saved, /session-A/);
  assert.doesNotMatch(saved, /secret|hello/);
  first.stop();
  const recovered = create();
  const b = add(recovered, "B");
  message("must wait for A or a new choice");
  assert.equal(b.frames.filter((frame) => frame.type === "task").length, 0);
  assert.match(b.ws.sent.at(-1).body.stream.content, /已离线/);
  const a = add(recovered, "A");
  message("/wecom use session-A");
  const delivered = a.frames.filter((frame) => frame.type === "task");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].task.message.text, "must wait for A or a new choice");
  assert.equal(b.frames.filter((frame) => frame.type === "task").length, 0);
});

test("corrupt bindings require explicit selection even with a singleton", async () => {
  await writeFile(file, "broken json");
  const gateway = create();
  const a = add(gateway, "A");
  message("first");
  assert.equal(a.frames.filter((frame) => frame.type === "task").length, 0);
  message("1");
  assert.equal(a.frames.filter((frame) => frame.type === "task").length, 1);
  assert.equal(new GatewaySelectionStore(file).load().requireChoice, false);
});

test("a failed binding write cannot start a task in an uncommitted target", async () => {
  // A file used as a parent reliably fails on both Windows and POSIX.
  await writeFile(file, "not a directory");
  const store = new GatewaySelectionStore(join(file, "impossible.json"));
  const gateway = new WeComGateway({ botId: "test", secret: "secret", createWebSocket: (url) => new FakeWebSocket(url) }, undefined, store);
  gateways.push(gateway);
  const a = add(gateway, "A");
  message("must not run");
  message("/wecom use session-A");
  assert.equal(a.frames.filter((frame) => frame.type === "task").length, 0);
  assert.match(a.ws.sent.at(-1).body.stream.content, /无法保存目标会话/);
});

test("normal last-pi shutdown clears persisted bindings for the next startup", async () => {
  const config = { botId: `state-ipc-${randomUUID()}`, secret: "secret", enabled: true, welcome: "hello" };
  const server = (await startGatewayServer({ endpoint: gatewayEndpoint(config.botId), credentials: config, routingStateFile: file, idleTimeoutMs: 20, createWebSocket(url) {
    const ws = new FakeWebSocket(url);
    ws.onSend = (frame) => ws.acknowledge(frame);
    queueMicrotask(() => ws.open());
    return ws;
  } }))!;
  const client = new GatewayClient({ config, source: { sessionId: "session", provider: "p", modelName: "m", directoryName: "d" }, launch() { throw new Error("unexpected launch"); } });
  try {
    client.start();
    const deadline = Date.now() + 4000;
    while (!client.isReady()) {
      assert.ok(Date.now() < deadline, "client ready timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    message("singleton task");
    assert.match(await readFile(file, "utf8"), /session/);
    client.stop();
    await server.closed;
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally {
    client.stop(); server.close(); await server.closed;
  }
});

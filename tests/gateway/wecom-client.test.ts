import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { WeComClient } from "../../src/gateway/wecom-client.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

let client: WeComClient;

beforeEach(() => {
  FakeWebSocket.instances = [];
  client = new WeComClient({ botId: "test-bot", secret: "test-secret", createWebSocket: (url) => new FakeWebSocket(url) });
});

afterEach(() => {
  client.stop("test cleanup");
});

function connect(): FakeWebSocket {
  client.start();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  ws.acknowledge();
  assert.equal(client.isReady(), true);
  return ws;
}

function deadline<T>(pending: Promise<T>): Promise<T | string> {
  return Promise.race([pending, new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 25))]);
}

test("stopping settles a push that is waiting for acknowledgement", async () => {
  connect();
  const pending = client.sendMsg("test-user", 1, { msgtype: "markdown" });
  const result = assert.rejects(deadline(pending), /stopped by user/);
  client.stop("stopped by user");
  await result;
});

test("socket closure immediately rejects outstanding commands", async () => {
  const ws = connect();
  const result = assert.rejects(deadline(client.sendMsg("test-user", 1, { msgtype: "markdown" })), /connection closed/);
  ws.close();
  await result;
});

test("close diagnostics include the close code, clean flag and connection lifetime without exposing secrets", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const logs: string[] = [];
  client = new WeComClient({ botId: "test-bot", secret: "test-secret", log: (line) => logs.push(line), createWebSocket: (url) => new FakeWebSocket(url) });
  const ws = connect();
  t.mock.timers.tick(12_345);
  ws.close(1006, "closed test-secret");
  assert.ok(logs.some((line) => /code=1006.*uptime=12345ms.*clean=false/.test(line)), logs.join("\n"));
  assert.equal(logs.some((line) => line.includes("test-secret")), false);
});

test("a push attempted before subscription is known unsent and does not start a connection", async () => {
  await assert.rejects(client.sendMsg("test-user", 1, {}), { outcome: "not_sent" });
  assert.equal(FakeWebSocket.instances.length, 0);
});

test("an acknowledgement timeout has an unknown outcome, not a retryable unsent one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  connect();
  const rejected = assert.rejects(client.sendMsg("test-user", 1, {}), { outcome: "unknown" });
  t.mock.timers.tick(10_000);
  await rejected;
});

test("starting twice retains a single live connection", () => {
  connect();
  client.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(client.isReady(), true);
});

test("a successful command resolves with its matching acknowledgement", async () => {
  const ws = connect();
  const pending = client.sendMsg("test-user", 1, { msgtype: "markdown" });
  ws.acknowledge();
  assert.equal((await pending).errcode, 0);
});

test("server errors reject commands instead of looking like success", async () => {
  const ws = connect();
  const result = assert.rejects(client.sendMsg("test-user", 1, {}), /rejected/);
  ws.acknowledge(undefined, 40014);
  await result;
});

test("registers a command before a synchronous acknowledgement arrives", async () => {
  const ws = connect();
  ws.onSend = (frame) => ws.acknowledge(frame);
  const response = await deadline(client.sendMsg("test-user", 1, {}));
  assert.notEqual(response, "still pending");
});

test("an unacknowledged subscription times out and reconnects", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  client.start();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  t.mock.timers.tick(10_000);
  assert.equal(ws.readyState, 3);
  assert.equal(client.getState(), "disconnected");
  t.mock.timers.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test("an unacknowledged heartbeat closes a half-open connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const ws = connect();
  t.mock.timers.tick(30_000);
  assert.equal(ws.sent.at(-1).cmd, "ping");
  t.mock.timers.tick(10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ws.readyState, 3);
  assert.equal(client.isReady(), false);
});

test("a rejected subscription is retried with backoff and given up after five refusals, until start", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  client.start();
  for (const [index, delay] of [1000, 2000, 4000, 8000, 0].entries()) {
    const ws = FakeWebSocket.instances[index];
    ws.open();
    ws.acknowledge(undefined, 40001);
    if (delay) t.mock.timers.tick(delay);
  }
  assert.equal(FakeWebSocket.instances.length, 5);
  assert.equal(client.stopped, true, "wrong credentials do not hammer the rate-limited subscription");
  t.mock.timers.tick(60_000);
  assert.equal(FakeWebSocket.instances.length, 5);
  client.start();
  assert.equal(FakeWebSocket.instances.length, 6);
  assert.equal(client.stopped, false);
});

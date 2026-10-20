import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { WeComGateway, type GatewayPeer } from "../../src/gateway/runtime.ts";
import { sessionTarget, type GatewayRegistration, type ServerFrame } from "../../src/shared/gateway-protocol.ts";
import { formatNotification, formatProcessingStatus, notificationPayload } from "../../src/shared/notification.ts";
import { parseInbound } from "../../src/shared/wecom-protocol.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

const SESSION_A = "01234567-89ab-4cde-8012-3456789abcde";
const SESSION_B = "01234567-89ab-4cde-8012-3456789abcdf";
let gateway: WeComGateway;
let sandbox: string;
let sequence = 0;

class Peer implements GatewayPeer {
  frames: ServerFrame[] = [];
  closed = false;
  send(frame: ServerFrame): boolean { if (this.closed) return false; this.frames.push(frame); return true; }
  close(): void { this.closed = true; }
  messages() { return this.frames.filter((frame) => frame.type === "task"); }
}

function registration(instanceId: string, sessionId = instanceId): GatewayRegistration {
  return {
    instanceId, registrationId: `registration-${instanceId}`,
    source: { sessionId, provider: `provider-${instanceId}`, modelName: `model-${instanceId}`, directoryName: `project-${instanceId}` },
    config: { botId: "unit-bot" },
  };
}

function add(instanceId: string, sessionId = instanceId, modify?: (value: GatewayRegistration) => void) {
  const value = registration(instanceId, sessionId);
  modify?.(value);
  const peer = new Peer();
  gateway.register(value, peer);
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.onSend = (frame) => {
    if (frame.cmd === "aibot_upload_media_init") ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
    else if (frame.cmd === "aibot_upload_media_chunk") ws.acknowledge(frame);
    else if (frame.cmd === "aibot_upload_media_finish") ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
  };
  if (ws.readyState === 0) { ws.open(); ws.acknowledge(); }
  return { value, peer, ws };
}

function message(content: string, body: Record<string, unknown> = {}) {
  const id = `message-${++sequence}`;
  const frame = { cmd: "aibot_msg_callback", headers: { req_id: id }, body: {
    msgid: id, from: { userid: "user" }, chattype: "single", msgtype: "text", text: { content }, ...body,
  } };
  FakeWebSocket.instances.at(-1)!.receive(frame);
  return frame;
}

function send(sessionId: string, text: string, body: Record<string, unknown> = {}) {
  return message(`/wecom-aibot send --sessionid ${sessionId} --prompt ${text}`, body);
}

function requests(peer: Peer) { return peer.frames.filter((frame) => frame.type === "request"); }

function quote(sessionId: string) { return { msgtype: "text", text: { content: `project · 会话通知\nprovider · model\nsession: ${sessionId}\n\nresult` } }; }
function prompt(): string { return FakeWebSocket.instances.at(-1)!.sent.at(-1).body.stream.content; }

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pi-wecom-aibot-runtime-"));
  FakeWebSocket.instances = [];
  sequence = 0;
  gateway = new WeComGateway({ botId: "unit-bot", secret: "unit-secret", createWebSocket: (url) => new FakeWebSocket(url) });
});
afterEach(() => { gateway.stop(); rmSync(sandbox, { recursive: true, force: true }); });
function dir(): string { return sandbox; }

test("only registered pi instances create and share the single WeCom connection", () => {
  assert.equal(FakeWebSocket.instances.length, 0);
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  assert.equal(gateway.size, 2);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_subscribe").length, 1);
  gateway.unregister(a.value.instanceId, a.peer);
  assert.equal(gateway.size, 1);
  send(SESSION_B, "still works");
  assert.equal(b.peer.messages().length, 1);
  assert.equal(a.peer.messages().length, 0);
  assert.equal(a.ws.readyState, 1);
});

test("a message without a target never reaches a pi: it teaches the command instead", () => {
  const a = add("A", SESSION_A);
  message("just a task");
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /先指定目标会话/);
  assert.match(prompt(), /\/wecom-aibot sessions/);
});

test("send names its target, and the target receives exactly the prompt", () => {
  const a = add("A", SESSION_A);
  send(SESSION_A, "检查构建");
  assert.deepEqual(a.peer.messages()[0].target, sessionTarget(a.value));
  assert.equal(a.peer.messages()[0].task.message.text, "检查构建");
});

test("a task's text result replaces its status message instead of a second push", async () => {
  const a = add("A", SESSION_A);
  const frames: any[] = [];
  a.ws.onSend = (frame: any) => { frames.push(frame); if (frame.cmd === "aibot_respond_msg") a.ws.acknowledge(frame); };
  const task = send(SESSION_A, "task");
  const id = task.headers.req_id;
  assert.equal(gateway.taskStatus("A", id, "running"), true);
  assert.equal(gateway.taskStatus("A", id, "settled"), true);
  await gateway.notify("A", { chatId: "user", chatType: 1 }, { kind: "reply", source: a.value.source, text: "RESULT-BODY" });
  const finish = frames.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.body.stream.finish).at(-1);
  assert.match(finish.body.stream.content, /RESULT-BODY$/);
  assert.match(finish.body.stream.content, new RegExp(`session: ${SESSION_A}`));
  assert.equal(frames.filter((frame) => frame.cmd === "aibot_send_msg").length, 0, "one bubble per task");
});

test("without a result notification the settled status closes after the grace window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = add("A", SESSION_A);
  const task = send(SESSION_A, "task");
  const id = task.headers.req_id;
  gateway.taskStatus("A", id, "running");
  gateway.taskStatus("A", id, "settled");
  t.mock.timers.tick(1_000);
  const finish = a.ws.sent.filter((frame: any) => frame.cmd === "aibot_respond_msg").at(-1);
  assert.equal(finish.body.stream.finish, true);
  assert.equal(finish.body.stream.content, formatProcessingStatus(SESSION_A, "settled"));
});

test("an unknown session ID gets an error plus the current list, never a guess", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  send("01234567-89ab-4cde-8012-000000000000", "task");
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
  assert.match(prompt(), /找不到这个 session ID/);
  assert.match(prompt(), new RegExp(SESSION_A));
  assert.match(prompt(), new RegExp(SESSION_B));
});

test("sessions lists directory, model, state and the full session ID on its own line", () => {
  const a = add("A", SESSION_A);
  add("B", SESSION_B);
  message("/wecom-aibot sessions");
  const text = prompt();
  assert.match(text, /当前有 2 个在线会话/);
  assert.match(text, /project-A · provider-A · model-A · 空闲/);
  assert.match(text, new RegExp(`session: ${SESSION_A}`));
  assert.match(text, new RegExp(`session: ${SESSION_B}`));
  // A running task is visible as busy.
  send(SESSION_A, "long task");
  const taskId = a.peer.messages()[0].task.id;
  gateway.taskStatus("A", taskId, "running");
  message("/wecom-aibot sessions");
  assert.match(prompt(), /project-A · provider-A · model-A · 执行中/);
});

test("a quoted notification routes that one message, without remembering anything", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  message("first", { quote: quote(SESSION_B) });
  assert.equal(b.peer.messages().length, 1);
  assert.equal(a.peer.messages().length, 0);
  // The next message has no target of its own, so it must be asked for again.
  message("second");
  assert.equal(b.peer.messages().length, 1);
  assert.match(prompt(), /先指定目标会话/);
});

test("a quote that names no online session is reported, never redirected to another pi", () => {
  const a = add("A", SESSION_A);
  message("orphan", { quote: quote(SESSION_B) });
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /无法定位到一个在线会话/);
  assert.match(prompt(), new RegExp(SESSION_A));
});

test("a quote with several session IDs is ambiguous and delivers nothing", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  const both = { msgtype: "text", text: { content: `session: ${SESSION_A}\nsession: ${SESSION_B}` } };
  message("which one", { quote: both });
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
  assert.match(prompt(), /无法定位/);
});

test("a command wins over a quote: the named session takes it", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  send(SESSION_A, "named", { quote: quote(SESSION_B) });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(b.peer.messages().length, 0);
});

test("--prompt keeps spaces, dashes, newlines and command-looking text verbatim", () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot send --sessionid ${SESSION_A} --prompt 修复 --screen 和 --sessionid 的解析\n第二行`);
  assert.equal(a.peer.messages()[0].task.message.text, "修复 --screen 和 --sessionid 的解析\n第二行");
});

test("--sessionid written after --prompt is an order error, not part of the prompt", () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot send --prompt 正文 --sessionid ${SESSION_A}`);
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /--sessionid 必须写在 --prompt 之前/);
});

test("an equals form is an unknown option, and the error lists what is supported", () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot send --sessionid=${SESSION_A} --prompt x`);
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /未知选项 --sessionid=/);
  assert.match(prompt(), /--sessionid/);
  assert.match(prompt(), /--prompt/);
});

test("a positional argument is rejected; the prompt belongs after --prompt", () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot send ${SESSION_A} 正文`);
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /不接受位置参数/);
});

test("screen asks the named pi and sends the image it returns", async () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
  const request = requests(a.peer)[0];
  assert.equal(request.type, "request");
  assert.deepEqual(request.request, { action: "screen", target: sessionTarget(a.value) });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const file = join(dir(), "screen.png");
  writeFileSync(file, png);
  gateway.response("A", request.id, { ok: true, image: { mime: "image/png", filename: "screen.png", path: file } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const sent = a.ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
  assert.equal(sent.body.msgtype, "image");
  assert.equal(a.ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"), true);
});

test("a failed screen request reports the pi's reason", () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
  gateway.response("A", requests(a.peer)[0].id, { ok: false, error: "该会话没有终端界面" });
  assert.match(prompt(), /截图失败：该会话没有终端界面/);
});

test("screen is only answered by the pi it was sent to", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
  const count = a.ws.sent.length;
  gateway.response("B", requests(a.peer)[0].id, { ok: true });
  assert.equal(a.ws.sent.length, count, "another pi's answer is ignored");
  t.mock.timers.tick(20_000);
  assert.match(prompt(), /20 秒内响应/);
});

test("cancel asks the named pi and says only that abort was requested", () => {
  const a = add("A", SESSION_A);
  message(`/wecom-aibot cancel --sessionid ${SESSION_A}`);
  const request = requests(a.peer)[0];
  assert.deepEqual(request.request, { action: "cancel", target: sessionTarget(a.value) });
  gateway.response("A", request.id, { ok: true });
  assert.match(prompt(), /已请求中止/);
});

test("a request nobody answers times out with the timeout named", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = add("A", SESSION_A);
  message(`/wecom-aibot screen --sessionid ${SESSION_A}`);
  t.mock.timers.tick(20_000);
  assert.match(prompt(), /20 秒内响应/);
});

test("group participants each name their own target; nothing is shared between senders", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  send(SESSION_A, "from alice", { from: { userid: "alice" }, chattype: "group", chatid: "group-1" });
  send(SESSION_B, "from bob", { from: { userid: "bob" }, chattype: "group", chatid: "group-1" });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(b.peer.messages().length, 1);
  assert.equal(a.peer.messages()[0].task.message.text, "from alice");
  assert.equal(b.peer.messages()[0].task.message.text, "from bob");
});

test("entering a chat sends nothing at all", () => {
  const a = add("A", SESSION_A);
  add("B", SESSION_B);
  const count = a.ws.sent.length;
  a.ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "enter" }, body: { from: { userid: "user" }, event: { eventtype: "enter_chat" } } });
  assert.equal(a.ws.sent.length, count);
});

test("duplicate callbacks produce one task and one command reply", () => {
  const a = add("A", SESSION_A);
  const frame = send(SESSION_A, "once");
  FakeWebSocket.instances.at(-1)!.receive(frame);
  assert.equal(a.peer.messages().length, 1);
});

test("the same full session cannot be registered by two pi instances", () => {
  const a = add("A", SESSION_A);
  assert.throws(() => add("B", SESSION_A), /另一个 pi 注册/);
  assert.equal(gateway.size, 1);
  assert.equal(a.peer.closed, false);
  send(SESSION_A, "original owner");
  assert.equal(a.peer.messages().length, 1);
});

test("switching sessions invalidates old callbacks and late disconnects cannot remove the new registration", () => {
  const a = add("A", SESSION_A);
  const inbound = send(SESSION_A, "task A");
  const next = registration("A", SESSION_B);
  next.registrationId = "new-registration";
  const peer = new Peer();
  gateway.register(next, peer);
  assert.equal(a.peer.closed, true);
  gateway.unregister("A", a.peer);
  assert.equal(gateway.size, 1);
  assert.equal(gateway.taskStatus("A", inbound.headers.req_id, "running"), false);
  message("old target", { quote: quote(SESSION_A) });
  assert.equal(peer.messages().length, 0);
  assert.match(prompt(), /无法定位/);
});

test("task states and notifications are checked against their owning pi and session", async () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  const inbound = message("task A", { quote: quote(SESSION_A) });
  const count = a.ws.sent.length;
  assert.equal(gateway.taskStatus("B", inbound.headers.req_id, "running"), false);
  assert.equal(gateway.taskStatus("A", "unknown-task", "running"), false);
  await assert.rejects(gateway.notify("A", { chatId: "user", chatType: 1 }, notificationPayload("notification", b.value.source, "wrong source")), /session/);
  assert.equal(a.ws.sent.length, count);
  assert.equal(gateway.taskStatus("A", inbound.headers.req_id, "running"), true);
  const status = a.ws.sent.at(-1);
  assert.equal(status.headers.req_id, inbound.headers.req_id);
  assert.deepEqual(status.body.stream, { id: status.body.stream.id, finish: false, content: formatProcessingStatus(SESSION_A, "running") });
});

test("concurrent notifications preserve separate source metadata and acknowledgement ownership", async () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  let resolvedA = false;
  const first = gateway.notify("A", { chatId: "user-A", chatType: 1 }, notificationPayload("notification", a.value.source, "result A")).then(() => { resolvedA = true; });
  const frameA = a.ws.sent.at(-1);
  const second = gateway.notify("B", { chatId: "group-B", chatType: 2 }, notificationPayload("notification", b.value.source, "result B"));
  const frameB = a.ws.sent.at(-1);
  a.ws.acknowledge(frameB);
  await second;
  assert.equal(resolvedA, false);
  assert.ok(frameA.body.markdown.content.includes(`🏷️ provider-A · model-A  \n🆔 session: ${SESSION_A}`));
  assert.ok(frameB.body.markdown.content.includes(`🏷️ provider-B · model-B  \n🆔 session: ${SESSION_B}`));
  assert.equal(frameA.body.chatid, "user-A");
  assert.equal(frameB.body.chat_type, 2);
  a.ws.acknowledge(frameA);
  await first;
});

test("allowlists hide and gate sessions, including quoted targets, and enter_chat stays silent", () => {
  const a = add("A", SESSION_A, (value) => { value.config.allowedUserIds = ["alice"]; });
  const b = add("B", SESSION_B, (value) => { value.config.allowedUserIds = ["bob"]; });
  message("blocked");
  send(SESSION_A, "alice", { from: { userid: "alice" } });
  message("cannot reach B", { from: { userid: "alice" }, quote: quote(SESSION_B) });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(b.peer.messages().length, 0);
  assert.equal(prompt().includes(SESSION_B), false);
  const count = a.ws.sent.length;
  a.ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "enter" }, body: { from: { userid: "blocked" }, event: { eventtype: "enter_chat" } } });
  assert.equal(a.ws.sent.length, count);
});

test("only a registered pi can wait for an identity, and registration needs this gateway's BotID", () => {
  const a = add("A", SESSION_A);
  assert.ok(a.peer.frames.some((frame) => frame.type === "registered"));
  assert.throws(() => gateway.watch("nobody", "watch", 60_000), /尚未注册/);
  assert.throws(() => add("other", SESSION_B, (value) => { value.config.botId = "other-bot"; }), /BotID/);
  assert.equal(gateway.size, 1);
});

test("whoami consumes only the next message for the waiting pi and reports its conversation", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  gateway.watch("A", "watch-1", 60_000);
  const frame = message("@bot 随便什么内容", { from: { userid: "user_one" }, chattype: "group", chatid: "group_chat" });
  assert.deepEqual(a.peer.frames.filter((item) => item.type === "identity"), [
    { type: "identity", id: "watch-1", identity: { chatId: "group_chat", chatType: 2, userid: "user_one" } },
  ]);
  assert.equal(b.peer.frames.some((item) => item.type === "identity"), false);
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0, "the identifying message is not a task");
  const receipt = a.ws.sent.at(-1);
  assert.equal(receipt.cmd, "aibot_respond_msg");
  assert.equal(receipt.headers.req_id, frame.headers.req_id);
  assert.equal(receipt.body.stream.finish, true);
  assert.match(receipt.body.stream.content, /chatid：`group_chat`　chat_type：2　userid：`user_one`/);
  assert.match(receipt.body.stream.content, /不会交给 pi/);

  // The hold is released after one message: the next one follows the normal command rules.
  message("/wecom-aibot sessions", { from: { userid: "user_one" }, chattype: "group", chatid: "group_chat" });
  assert.match(prompt(), /当前有 2 个在线会话/);
  assert.equal(a.peer.frames.filter((item) => item.type === "identity").length, 1);
});

test("a cancelled or expired whoami stops capturing, and a stale cancel cannot end a newer one", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const a = add("A", SESSION_A);
  gateway.watch("A", "watch-1", 60_000);
  gateway.unwatch("A", "watch-1");
  send(SESSION_A, "after cancel");
  gateway.watch("A", "watch-2", 1000);
  t.mock.timers.tick(1001);
  send(SESSION_A, "after expiry");
  assert.equal(a.peer.messages().length, 2);
  gateway.watch("A", "watch-3", 60_000);
  gateway.unwatch("A", "watch-2");
  send(SESSION_A, "identified");
  const identities = a.peer.frames.filter((item) => item.type === "identity");
  assert.equal(identities.length, 1);
  assert.ok(identities[0].type === "identity" && identities[0].id === "watch-3");
  assert.equal(a.peer.messages().length, 2);
});

test("whoami follows the waiting pi's allowlist and belongs to the connection that asked", () => {
  const a = add("A", SESSION_A, (value) => { value.config.allowedUserIds = ["alice"]; });
  gateway.watch("A", "watch", 60_000);
  const count = a.ws.sent.length;
  message("stranger", { from: { userid: "stranger" } });
  assert.equal(a.ws.sent.length, count, "a sender outside the allowlist gets no receipt");
  assert.equal(a.peer.frames.some((item) => item.type === "identity"), false);

  const replacement = new Peer();
  gateway.register(registration("A", SESSION_A), replacement);
  send(SESSION_A, "alice", { from: { userid: "alice" } });
  assert.equal(replacement.messages().length, 1, "a re-registered connection does not inherit the old whoami");
  assert.equal(replacement.frames.some((item) => item.type === "identity"), false);
});

test("duplicate callbacks cannot produce a second command reply or pi task", () => {
  const a = add("A", SESSION_A);
  const frame = send(SESSION_A, "once");
  a.ws.receive(frame);
  assert.equal(a.peer.messages().length, 1);
});

test("replacement by an external client stops reconnecting but retains registrations until explicit start", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  a.ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "replaced" }, body: { event: { eventtype: "disconnected_event" } } });
  t.mock.timers.tick(60_000);
  assert.equal(gateway.size, 2);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(a.peer.closed || b.peer.closed, false);
  gateway.resume();
  const next = FakeWebSocket.instances.at(-1)!;
  next.open(); next.acknowledge();
  assert.equal(FakeWebSocket.instances.length, 2);
  message("back", { quote: quote(SESSION_B) });
  assert.equal(b.peer.messages().length, 1);
});

test("the gateway ends a task's status message before WeCom's 10-minute limit, and a closed message stays closed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const a = add("A", SESSION_A);
  a.ws.onSend = (frame) => { if (frame.cmd === "ping") a.ws.acknowledge(frame); };
  const task = send(SESSION_A, "long task");
  const statuses = () => a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg" && frame.headers.req_id === task.headers.req_id);
  assert.equal(gateway.taskStatus("A", task.headers.req_id, "running"), true);
  t.mock.timers.tick(589_000);
  assert.equal(statuses().length, 1);
  t.mock.timers.tick(1_000);
  const [opened, closed] = statuses();
  assert.equal(closed.body.stream.id, opened.body.stream.id);
  assert.equal(closed.body.stream.finish, true);
  assert.equal(closed.body.stream.content, formatProcessingStatus(SESSION_A, "waiting"));
  assert.equal(gateway.taskStatus("A", task.headers.req_id, "settled"), false, "the result follows as a notification instead");
  assert.equal(statuses().length, 2);
});

test("a final state WeCom could not take while disconnected is sent after the reconnect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const a = add("A", SESSION_A);
  const task = send(SESSION_A, "task");
  gateway.taskStatus("A", task.headers.req_id, "running");
  a.ws.close();
  // Settled is deferred until its result arrives; the status itself is closed by the grace timer.
  assert.equal(gateway.taskStatus("A", task.headers.req_id, "settled"), true);
  t.mock.timers.tick(1_000);
  const next = FakeWebSocket.instances.at(-1)!;
  assert.notEqual(next, a.ws);
  next.open(); next.acknowledge();
  const flushed = next.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].headers.req_id, task.headers.req_id);
  assert.equal(flushed[0].body.stream.finish, true);
  assert.equal(flushed[0].body.stream.content, formatProcessingStatus(SESSION_A, "settled"));
});

test("an unreadable message from a permitted sender is answered instead of routed or guessed", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  const broken = message("no chat id", { chattype: "group" });
  const reply = a.ws.sent.at(-1);
  assert.equal(reply.headers.req_id, broken.headers.req_id);
  assert.equal(reply.body.stream.finish, true);
  assert.match(reply.body.stream.content, /无法识别/);
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
});

function imageFile(data = Buffer.alloc(64, 1)): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "gateway-image-"));
  const path = join(dir, "screen.png");
  writeFileSync(path, data);
  return { dir, path };
}

test("an image notification uploads media and sends a native image message instead of Markdown", async () => {
  const a = add("A", SESSION_A);
  const file = imageFile();
  const sent: any[] = [];
  a.ws.onSend = (frame: any) => {
    sent.push(frame);
    if (frame.cmd === "aibot_upload_media_init") a.ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
    else if (frame.cmd === "aibot_upload_media_chunk") a.ws.acknowledge(frame);
    else if (frame.cmd === "aibot_upload_media_finish") a.ws.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
    else if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
  };
  await gateway.notify("A", { chatId: "user", chatType: 1 }, {
    kind: "completion", source: a.value.source, text: "fallback", image: { mime: "image/png", filename: "pi-notification.png", path: file.path },
  });
  assert.equal(sent.some((frame) => frame.cmd === "aibot_upload_media_init"), true);
  const push = sent.find((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(push.body.msgtype, "image");
  assert.equal(push.body.image.media_id, "media-1");
  assert.equal(push.body.markdown, undefined);
  rmSync(file.dir, { recursive: true, force: true });
});

test("a missing image file falls back to the Markdown body with a visible reason", async () => {
  const a = add("A", SESSION_A);
  const sent: any[] = [];
  a.ws.onSend = (frame: any) => {
    sent.push(frame);
    if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
  };
  await gateway.notify("A", { chatId: "user", chatType: 1 }, {
    kind: "completion", source: a.value.source, text: "fallback body",
    image: { mime: "image/png", filename: "pi-notification.png", path: "/definitely/missing/pi-notification.png" },
  });
  const push = sent.find((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(push.body.msgtype, "markdown");
  assert.match(push.body.markdown.content, /fallback body/);
  assert.match(push.body.markdown.content, /图片发送失败：.*ENOENT.*已改发文字/);
});

test("a rejected media upload falls back to Markdown while a rejected image send also falls back", async () => {
  const a = add("A", SESSION_A);
  const file = imageFile();
  const sent: any[] = [];
  a.ws.onSend = (frame: any) => {
    sent.push(frame);
    if (frame.cmd === "aibot_upload_media_init") a.ws.receive({ headers: frame.headers, errcode: 40006, errmsg: "bad size" });
    else if (frame.cmd === "aibot_send_msg") a.ws.acknowledge(frame);
  };
  await gateway.notify("A", { chatId: "user", chatType: 1 }, {
    kind: "completion", source: a.value.source, text: "fallback body",
    image: { mime: "image/png", filename: "pi-notification.png", path: file.path },
  });
  const push = sent.find((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(push.body.msgtype, "markdown");
  assert.match(push.body.markdown.content, /图片发送失败：.*已改发文字/);
  rmSync(file.dir, { recursive: true, force: true });
});

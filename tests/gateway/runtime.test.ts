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
    config: { botId: "unit-bot", welcome: "hello" },
  };
}

function add(instanceId: string, sessionId = instanceId, modify?: (value: GatewayRegistration) => void) {
  const value = registration(instanceId, sessionId);
  modify?.(value);
  const peer = new Peer();
  gateway.register(value, peer);
  const ws = FakeWebSocket.instances.at(-1)!;
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

function quote(sessionId: string) { return { msgtype: "text", text: { content: `project · 会话通知\nprovider · model\nsession: ${sessionId}\n\nresult` } }; }
function prompt(): string { return FakeWebSocket.instances.at(-1)!.sent.at(-1).body.stream.content; }

beforeEach(() => {
  FakeWebSocket.instances = [];
  sequence = 0;
  gateway = new WeComGateway({ botId: "unit-bot", secret: "unit-secret", createWebSocket: (url) => new FakeWebSocket(url) });
});
afterEach(() => gateway.stop());

test("only registered pi instances create and share the single WeCom connection", () => {
  assert.equal(FakeWebSocket.instances.length, 0);
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  assert.equal(gateway.size, 2);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_subscribe").length, 1);
  gateway.unregister(a.value.instanceId, a.peer);
  assert.equal(gateway.size, 1);
  message("still works");
  assert.equal(b.peer.messages().length, 1);
  assert.equal(a.peer.messages().length, 0);
  assert.equal(a.ws.readyState, 1);
});

test("a single session receives direct messages with its exact registered identity", () => {
  const a = add("A", SESSION_A);
  message("task");
  assert.deepEqual(a.peer.messages()[0].target, sessionTarget(a.value));
  assert.equal(a.peer.messages()[0].task.message.text, "task");
});

test("multiple sessions retain the first task until a choice and remember that choice", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  const original = message("first task", { msgtype: "image", image: { url: "https://example.invalid/image", aeskey: "key" } });
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
  assert.match(prompt(), /已暂存/);
  assert.ok(prompt().includes(SESSION_A) && prompt().includes(SESSION_B));
  const choice = message("2");
  assert.equal(b.peer.messages().length, 1);
  assert.deepEqual(b.peer.messages()[0].task.message, parseInbound(original.body));
  assert.equal(b.peer.messages()[0].task.id, choice.headers.req_id);
  assert.equal(b.peer.messages()[0].target.sessionId, SESSION_B);
  message("followup");
  assert.equal(b.peer.messages()[1].task.message.text, "followup");
  assert.equal(a.peer.messages().length, 0);
});

test("quoted replies route by the full session ID without changing the direct-message selection", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  message(`/wecom-aibot use ${SESSION_A}`);
  message("reply B", { quote: quote(SESSION_B) });
  message("direct A");
  assert.equal(b.peer.messages()[0].task.message.text, "reply B");
  assert.equal(a.peer.messages()[0].task.message.text, "direct A");
});

test("an offline, truncated or malformed quoted session never falls back to the only online pi", () => {
  const a = add("A", SESSION_A);
  for (const sessionId of [SESSION_A.slice(0, 8), "offline-session", "broken id", ""]) {
    message("must not be delivered", { quote: quote(sessionId) });
    assert.match(prompt(), /离线或不可用/);
  }
  assert.equal(a.peer.messages().length, 0);
});

test("ambiguous quoted session IDs require an explicit choice", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  message("ambiguous", { quote: { msgtype: "text", text: { content: `session: ${SESSION_A}\nsession: ${SESSION_B}` } } });
  assert.match(prompt(), /多个 session ID/);
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
});

test("a damaged source header cannot redirect a quote through a valid-looking ID in its body", () => {
  const a = add("A", SESSION_A);
  message("damaged quote", { quote: { msgtype: "text", text: { content: `session: damaged id\n\nsession: ${SESSION_A}` } } });
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /多个 session ID/);
});

test("flattened or truncated notification quotes cannot fall back to the selected pi", () => {
  const a = add("A", SESSION_A);
  add("B", SESSION_B);
  message(`/wecom-aibot use ${SESSION_A}`);
  for (const content of [`project-B · 会话通知 provider-B · model-B session: ${SESSION_B} result`, "project-B · 会话通知\nprovider-B · model-B"]) {
    message("quote B", { quote: { msgtype: "text", text: { content } } });
    assert.match(prompt(), /重新选择/);
  }
  assert.equal(a.peer.messages().length, 0);
});

test("quoted Markdown session IDs round trip the notification's escaping", () => {
  const a = add("A", "session_with_[brackets]\\suffix");
  const content = formatNotification(a.value.source, "result");
  message("reply", { quote: { msgtype: "markdown", markdown: { content } } });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(a.peer.messages()[0].target.sessionId, a.value.source.sessionId);
});

test("a notification's source header owns routing even when its metadata and output mention sessions", async () => {
  const a = add("A", SESSION_A, (value) => { value.source = { ...value.source, directoryName: "project session: notes", modelName: "model session: custom" }; });
  const b = add("B", SESSION_B);
  const content = formatNotification(a.value.source, `Output about another session:\nsession: ${SESSION_B}`);
  const sent = gateway.notify("A", { chatId: "user", chatType: 1 }, notificationPayload("notification", a.value.source, `Output about another session:\nsession: ${SESSION_B}`));
  assert.equal(a.ws.sent.at(-1).body.markdown.content, content, "the gateway renders exactly what pi would have formatted");
  a.ws.acknowledge();
  await sent;
  message("reply to A", { quote: { msgtype: "markdown", markdown: { content } } });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(b.peer.messages().length, 0);
});

test("the selected pi exiting requires a new choice even when only one other pi remains", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  message(`/wecom-aibot use ${SESSION_A}`);
  gateway.unregister(a.value.instanceId, a.peer);
  message("next task");
  assert.equal(b.peer.messages().length, 0);
  assert.match(prompt(), /已离线/);
  message("1");
  assert.equal(b.peer.messages()[0].task.message.text, "next task");
});

test("automatic selection of a singleton is also pinned when a second pi joins", () => {
  const a = add("A", SESSION_A);
  message("task A");
  const b = add("B", SESSION_B);
  message("still A");
  assert.equal(a.peer.messages().length, 2);
  assert.equal(b.peer.messages().length, 0);
});

test("selection numbers cannot shift to a different pi when membership changes", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  message("pending");
  gateway.unregister(a.value.instanceId, a.peer);
  const replacement = add("new-A", SESSION_A);
  message("1");
  assert.match(prompt(), /已离线或选择无效/);
  assert.equal(b.peer.messages().length + replacement.peer.messages().length, 0);
  message("2");
  assert.equal(replacement.peer.messages()[0].task.message.text, "pending");
});

test("a new pi reopening the same session cannot inherit a previous pi's direct-message selection", () => {
  const a = add("A", SESSION_A);
  message("first");
  gateway.unregister(a.value.instanceId, a.peer);
  const replacement = add("new-A", SESSION_A);
  message("next");
  assert.equal(replacement.peer.messages().length, 0);
  assert.match(prompt(), /已离线/);
});

test("group selections are separate for each sender and for each conversation", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  const group = { chattype: "group", chatid: "group-1" };
  message(`@bot /wecom-aibot use ${SESSION_A}`, { ...group, from: { userid: "alice" } });
  message(`@bot /wecom-aibot use ${SESSION_B}`, { ...group, from: { userid: "bob" } });
  message("alice task", { ...group, from: { userid: "alice" } });
  message("bob task", { ...group, from: { userid: "bob" } });
  message("another chat", { ...group, chatid: "group-2", from: { userid: "alice" } });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(b.peer.messages().length, 1);
  assert.equal(a.peer.messages()[0].task.message.text, "alice task");
  assert.equal(b.peer.messages()[0].task.message.text, "bob task");
  assert.match(prompt(), /请选择|回复序号/);
});

test("ordinary messages while choosing cannot overwrite the retained task or become a choice", () => {
  const a = add("A", SESSION_A);
  add("B", SESSION_B);
  message("original");
  message("another task");
  assert.match(prompt(), /已保留最初/);
  message("1");
  assert.equal(a.peer.messages().length, 1);
  assert.equal(a.peer.messages()[0].task.message.text, "original");
});

test("retained messages expire rather than starting a stale task later", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
  const a = add("A", SESSION_A);
  add("B", SESSION_B);
  message("expired task");
  // Keep the fake upstream responsive while advancing time.
  a.ws.onSend = (frame) => { if (frame.cmd === "ping") a.ws.acknowledge(frame); };
  t.mock.timers.tick(301_000);
  message(`/wecom-aibot use ${SESSION_A}`);
  assert.equal(a.peer.messages().length, 0);
  assert.match(prompt(), /请发送任务/);
});

test("the same full session cannot be registered by two pi instances", () => {
  const a = add("A", SESSION_A);
  assert.throws(() => add("B", SESSION_A), /另一个 pi 注册/);
  assert.equal(gateway.size, 1);
  assert.equal(a.peer.closed, false);
  message("original owner");
  assert.equal(a.peer.messages().length, 1);
});

test("switching sessions invalidates old callbacks and late disconnects cannot remove the new registration", () => {
  const a = add("A", SESSION_A);
  const inbound = message("task A");
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
  assert.match(prompt(), /离线/);
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

test("allowlists hide and gate sessions, including quoted targets and welcome events", () => {
  const a = add("A", SESSION_A, (value) => { value.config.allowedUserIds = ["alice"]; });
  const b = add("B", SESSION_B, (value) => { value.config.allowedUserIds = ["bob"]; });
  message("blocked");
  message("alice", { from: { userid: "alice" } });
  message("cannot reach B", { from: { userid: "alice" }, quote: quote(SESSION_B) });
  assert.equal(a.peer.messages().length, 1);
  assert.equal(b.peer.messages().length, 0);
  assert.equal(prompt().includes(SESSION_B), false);
  const count = a.ws.sent.length;
  a.ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "welcome" }, body: { from: { userid: "blocked" }, event: { eventtype: "enter_chat" } } });
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

  // The hold is released after one message: the next one is routed as usual (two sessions: choose).
  message("task", { from: { userid: "user_one" }, chattype: "group", chatid: "group_chat" });
  assert.match(prompt(), /当前有 2 个可用会话/);
  assert.equal(a.peer.frames.filter((item) => item.type === "identity").length, 1);
});

test("a cancelled or expired whoami stops capturing, and a stale cancel cannot end a newer one", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const a = add("A", SESSION_A);
  gateway.watch("A", "watch-1", 60_000);
  gateway.unwatch("A", "watch-1");
  message("after cancel");
  gateway.watch("A", "watch-2", 1000);
  t.mock.timers.tick(1001);
  message("after expiry");
  assert.equal(a.peer.messages().length, 2);
  gateway.watch("A", "watch-3", 60_000);
  gateway.unwatch("A", "watch-2");
  message("identified");
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
  message("alice", { from: { userid: "alice" } });
  assert.equal(replacement.messages().length, 1, "a re-registered connection does not inherit the old whoami");
  assert.equal(replacement.frames.some((item) => item.type === "identity"), false);
});

test("a singleton welcome retains the original plain-text source format", () => {
  const a = add("A", SESSION_A);
  a.ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "welcome" }, body: { from: { userid: "user" }, event: { eventtype: "enter_chat" } } });
  const welcome = a.ws.sent.at(-1);
  assert.equal(welcome.cmd, "aibot_respond_welcome_msg");
  assert.equal(welcome.body.text.content, `🔔 project-A · 欢迎\n🏷️ provider-A · model-A\n🆔 session: ${SESSION_A}\n\nhello`);
});

test("a multiple-session welcome is sent once and does not arbitrarily select a pi", () => {
  const a = add("A", SESSION_A);
  const b = add("B", SESSION_B);
  a.ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "welcome" }, body: { from: { userid: "user" }, event: { eventtype: "enter_chat" } } });
  assert.equal(a.ws.sent.filter((frame) => frame.cmd === "aibot_respond_welcome_msg").length, 1);
  assert.match(a.ws.sent.at(-1).body.text.content, /2 个在线会话/);
  message("task");
  assert.equal(a.peer.messages().length + b.peer.messages().length, 0);
});

test("duplicate callbacks cannot produce a second choice prompt or pi task", () => {
  const a = add("A", SESSION_A);
  const frame = message("once");
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
  const task = message("long task");
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
  const task = message("task");
  gateway.taskStatus("A", task.headers.req_id, "running");
  a.ws.close();
  assert.equal(gateway.taskStatus("A", task.headers.req_id, "settled"), false);
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
  assert.match(push.body.markdown.content, /图片发送失败，已改发文字/);
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
  assert.match(push.body.markdown.content, /图片发送失败，已改发文字/);
  rmSync(file.dir, { recursive: true, force: true });
});

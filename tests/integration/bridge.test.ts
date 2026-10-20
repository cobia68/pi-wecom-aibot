import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, afterEach, beforeEach, test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeWebSocket } from "../support/fake-websocket.ts";
import { LoopbackClient } from "../support/loopback-client.ts";
import { installTuiFixture } from "../support/tui-fixture.ts";

const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-bridge-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../../src/extension/index.ts");
const { saveConfig, clearConfig, CONFIG_FILE } = await import("../../src/extension/config.ts");
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let handlers: Map<string, Handler[]>;
let command: (args: string, ctx: ExtensionContext) => Promise<void>;
let complete: (prefix: string) => { value: string; label: string }[] | null;
let sent: { content: any; options: any }[];
let tools: Map<string, any>;
let idle: boolean;
let ctx: ExtensionContext;
let ws: FakeWebSocket;
let clock: TestContext["mock"]["timers"];
let sessionId: string;
let sessionEntries: any[];
let autoAcknowledge: boolean;
/** Simulate pi refusing the prompt: no before_agent_start and no agent_settled, exactly as the SDK does it. */
let refusePrompt: boolean;
let rasterise: (screen: any, options?: any) => Promise<Uint8Array>;
const modelA = { id: "model-a", name: "Model A", provider: "test-provider" };
const modelB = { id: "model-b", name: "Model B", provider: "another-provider" };

function assertSource(content: string, modelName = "Model A", provider = "test-provider"): void {
  assert.ok(content.startsWith(`🔔 ${basename(sandbox)} · `));
  assert.ok(content.includes(`  \n🏷️ ${provider} · ${modelName}  \n🆔 session: pi-session-1\n\n`));
  assert.equal(content.includes(dirname(sandbox)), false, "parent directories must not appear in source metadata");
}

async function emit(type: string, event: any = {}, context = ctx): Promise<void> {
  if (type === "message_end") {
    sessionEntries.push({ type: "message", id: `entry-${sessionEntries.length + 1}`, message: event.message });
  }
  for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, context);
}

async function drain(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.tick(10);
  }
}

function inbound(id: string, extra: Record<string, unknown> = {}): void {
  // Media callbacks carry no text, so they name their target by quoting a notification instead.
  const media = typeof extra.msgtype === "string" && extra.msgtype !== "text";
  const quote = { quote: { msgtype: "text", text: { content: `session: ${sessionId}` } } };
  ws.receive({
    cmd: "aibot_msg_callback", headers: { req_id: `callback-${id}` },
    body: {
      msgid: id, from: { userid: "test-user" }, chattype: "single", msgtype: "text",
      text: { content: taskText(id) }, ...(media ? quote : {}), ...extra,
      ...(media ? quote : {}),
    },
  });
}

/** Every task names its target: the bridge tests speak the WeCom-side grammar. */
function taskText(prompt: string): string {
  return `/wecom-aibot send --sessionid ${sessionId} --prompt ${prompt}`;
}

function sendNotification(params: Record<string, unknown>): Promise<any> {
  const pending = tools.get("wecom_send").execute("notify", params, undefined, undefined, ctx);
  void pending.catch(() => {});
  return pending;
}

function identityDialogs(t: TestContext, confirm: () => Promise<boolean> = async () => true): string[] {
  const notices: string[] = [];
  Object.assign(ctx, { hasUI: true });
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  t.mock.method(ctx.ui, "confirm", confirm);
  Object.assign(ctx.ui, {
    select(_title: string, _choices: string[], options: { signal: AbortSignal }) {
      return new Promise<undefined>((resolve) => options.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    },
  });
  return notices;
}

beforeEach(async (t) => {
	assert.ok("mock" in t);
  clock = t.mock.timers;
  clock.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  FakeWebSocket.instances = [];
  handlers = new Map();
  tools = new Map();
  sent = [];
  idle = true;
  sessionId = "pi-session-1";
  sessionEntries = [];
  autoAcknowledge = true;
  refusePrompt = false;
  rasterise = async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  ctx = {
    hasUI: false, cwd: sandbox, isIdle: () => idle,
    model: { ...modelA },
    modelRegistry: { find: (provider: string, id: string) => [modelA, modelB].find((model) => model.provider === provider && model.id === id) },
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => sessionEntries,
      getLeafId: () => sessionEntries.at(-1)?.id ?? null,
    },
    ui: { notify() {}, async confirm() { return true; } },
  } as unknown as ExtensionContext;
  const pi = {
    on(type: string, handler: Handler) {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return () => {};
    },
    registerCommand(_name: string, options: { handler: typeof command; getArgumentCompletions: typeof complete }) {
      command = options.handler;
      complete = options.getArgumentCompletions;
    },
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    sendUserMessage(content: any, options: any) {
      sent.push({ content, options });
      idle = false;
      // pi echoes the prompt it starts through before_agent_start; a refused prompt echoes nothing.
      if (!refusePrompt) void emit("before_agent_start", {
        messageType: "user", prompt: typeof content === "string" ? content : content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"),
        images: typeof content === "string" ? undefined : content.filter((part: any) => part.type === "image"),
      });
    },
  } as unknown as ExtensionAPI;
  saveConfig({ botId: "test-bot", secret: "test-secret" });
  // The real gateway in-process: its routing, status messages and rendered notifications are what these tests assert.
  extension(pi, {
    renderScreen: (screen, options) => rasterise(screen, options),
    createClient: (options) => new LoopbackClient(options, (url) => {
      const socket = new FakeWebSocket(url);
      socket.onSend = (frame) => {
        if (frame.cmd === "aibot_upload_media_init") socket.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
        else if (frame.cmd === "aibot_upload_media_chunk") socket.acknowledge(frame);
        else if (frame.cmd === "aibot_upload_media_finish") socket.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
        else if (frame.cmd === "ping" || (autoAcknowledge && frame.cmd === "aibot_send_msg")) socket.acknowledge(frame);
      };
      return socket;
    }),
  });
  await emit("session_start");
  await command("connect", ctx);
  ws = FakeWebSocket.instances[0];
  ws.open();
  ws.acknowledge();
});

afterEach(async () => {
  await emit("session_shutdown");
});

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  assert.equal(dirname(sandbox), tmpdir());
  await rm(sandbox, { recursive: true, force: true });
});

test("re-reading an unchanged configuration keeps queued work and pending notifications", async () => {
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true, content: "PENDING-BEFORE-RECONNECT" });
  inbound("queued-before-reconnect");
  await drain();
  const previous = ws;
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  if (ws !== previous) { ws.open(); ws.acknowledge(); }
  idle = true;
  await emit("agent_settled", { aborted: false });
  const pushed = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].body.markdown.content, /PENDING-BEFORE-RECONNECT/);
  clock.tick(250);
  await drain();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content[0].text, /queued-before-reconnect/);
  assert.equal(ws, previous, "an unchanged configuration must not replace the registration");
});

test("an allowlist change still revokes queued work and notifications from the old registration", async () => {
  idle = false;
  inbound("old-permission-task");
  await sendNotification({ chatid: "test-user", after_settle: true, content: "OLD-PERMISSION-RESULT" });
  const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  await writeFile(CONFIG_FILE, JSON.stringify({ ...config, allowedUserIds: ["different-user"] }));
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("starts the next request after the settled notification has returned", async () => {
  inbound("first");
  inbound("second");
  await drain();
  assert.equal(sent.length, 1);
  idle = true;
  await emit("agent_settled", { aborted: false });
  assert.equal(sent.length, 1, "the next run must not start inside the settled handler");
  await drain();
  assert.equal(sent.length, 2);
});

test("bulk inbound media uses bounded preparation concurrency and stop cancels waiting downloads", async (t) => {
  let active = 0;
  let peak = 0;
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    downloads++;
    active++;
    peak = Math.max(peak, active);
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => { active--; reject(options.signal!.reason); }, { once: true });
    });
  });
  idle = false;
  for (let i = 0; i < 50; i++) inbound(`bulk-${i}`, { msgtype: "image", image: { url: `https://example.invalid/${i}.png` } });
  await drain();
  assert.equal(peak, 2, "reserving 50 FIFO positions must not start 50 media preparations");
  assert.equal(downloads, 2);
  assert.equal(sent.length, 0);
  await command("disconnect", ctx);
  await drain();
  assert.equal(active, 0);
  assert.equal(downloads, 2, "cancelled waiters must never start fetching later");
});

test("keeps arrival order when an image download is slower than the next text", async (t) => {
  let finishDownload!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finishDownload = resolve; }));
  inbound("first", { msgtype: "image", image: { url: "https://example.invalid/image" } });
  inbound("second");
  await drain();
  assert.equal(sent.length, 0);
  finishDownload(new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } }));
  await drain();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content.map((part: { type: string }) => part.type), ["text", "image"], "the quoted source stays with the image");
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  assert.match(sent[1].content[0].text, /second/);
});

test("a media download finishing after stop never starts a pi task", async (t) => {
  let finishDownload!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finishDownload = resolve; }));
  inbound("late-image", { msgtype: "image", image: { url: "https://example.invalid/image" } });
  await drain();
  await command("disconnect", ctx);
  finishDownload(new Response("image", { headers: { "content-type": "image/png" } }));
  await drain();
  assert.equal(sent.length, 0);
});

test("stop clears old requests so a later local response cannot leak on restart", async () => {
  inbound("old-request");
  inbound("old-queued-request");
  await drain();
  await command("disconnect", ctx);
  await command("connect", ctx);
  const nextWs = FakeWebSocket.instances.at(-1)!;
  nextWs.open();
  nextWs.acknowledge();
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "LOCAL-ONLY" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  assert.equal(nextWs.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length, 0);
  assert.equal(sent.length, 1);
});

test("a task pi refused is reported instead of taking the next local answer", async () => {
  // pi refuses a prompt (no model, no key, expired OAuth, compaction) without any event: no run starts.
  refusePrompt = true;
  inbound("refused-task");
  await drain();
  assert.equal(sent.length, 1, "the prompt was handed to pi");
  // pi refused it and stays idle; the user then asks something locally.
  idle = false;
  await emit("before_agent_start", { messageType: "user", prompt: "LOCAL-ONLY-QUESTION" });
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "LOCAL-ONLY-ANSWER" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.chatid, "test-user");
  assert.match(pushes[0].body.markdown.content, /没有接受/);
  assert.doesNotMatch(pushes[0].body.markdown.content, /LOCAL-ONLY-ANSWER/);
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1).body.stream.finish, true);
  // The local run does not inherit the refused task's conversation as wecom_send's default target.
  await assert.rejects(sendNotification({ content: "LOCAL-PUSH" }), /缺少 chatid/);
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
  // The queue is no longer wedged: the next WeCom task runs.
  refusePrompt = false;
  inbound("after-refusal");
  clock.tick(250);
  await drain();
  assert.equal(sent.length, 2);
  assert.match(sent[1].content[0].text, /after-refusal/);
});

test("a task pi silently refused fails while the session stays idle", async () => {
  refusePrompt = true;
  inbound("silently-refused");
  await drain();
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
  // pi refused the prompt and stays idle; no before_agent_start follows.
  idle = true;
  clock.tick(5_000);
  await drain();
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.chatid, "test-user");
  assert.match(pushes[0].body.markdown.content, /没有接受/);
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1).body.stream.finish, true);
});

test("changing pi sessions closes the old connection and discards its active request without reconnecting", async () => {
  inbound("old-session");
  await drain();
  sessionId = "pi-session-2";
  await emit("session_start", {}, { ...ctx, cwd: join(sandbox, "another-project") });
  assert.equal(ws.readyState, 3);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("duplicate callbacks result in one pi task", async () => {
  inbound("duplicate");
  inbound("duplicate");
  await drain();
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  assert.equal(sent.length, 1);
});

test("a status message and a scheduled notification produce only one final result", async () => {
  inbound("one-result");
  await drain();
  await sendNotification({ chatid: "test-user", after_settle: true });
  await emit("message_end", { message: {
    role: "assistant", content: [{ type: "text", text: "RESULT-1024" }],
  } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  const results = ws.sent.filter((frame) => (frame.body?.markdown?.content ?? frame.body?.stream?.content ?? "").includes("RESULT-1024"));
  assert.equal(results.length, 1, "同一任务的结果只能发送一次");
  const statuses = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
  assert.equal(statuses.length, 2, "状态消息只在开始和结束时各更新一次");
  assert.equal(statuses[0].body.stream.finish, false);
  assert.equal(statuses[0].body.stream.content, "🆔 session: pi-session-1  \n执行中…");
  assert.equal(statuses[1].body.stream.id, statuses[0].body.stream.id, "应更新同一条状态消息");
  assert.equal(statuses[1].body.stream.finish, true);
  assert.equal(statuses[1].body.stream.content, "🆔 session: pi-session-1  \n本轮已结束。");
  assert.equal(results[0].cmd, "aibot_send_msg");
  assert.equal(results[0].body.chatid, "test-user");
});

test("a scheduled notification for another chat does not suppress the sender's result", async () => {
  inbound("other-target");
  await drain();
  await sendNotification({ chatid: "another-chat", chat_type: 2, after_settle: true });
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "RESULT" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  const targets = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").map((frame) => [frame.body.chatid, frame.body.chat_type]);
  assert.deepEqual(targets.sort(), [["another-chat", 2], ["test-user", 1]]);
});

test("assistant streaming does not replace the compact status with partial results", async () => {
  inbound("stream");
  await drain();
  await emit("message_start", { message: { role: "assistant" } });
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "OLD-TOOL-TURN" } });
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "OLD-TOOL-TURN" }] } });
  await emit("message_start", { message: { role: "assistant", model: "model-b", provider: "another-provider" } });
  await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "NEW-ANSWER" } });
  clock.tick(5000);
  const statuses = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].body.stream.content, "🆔 session: pi-session-1  \n执行中…");
  await emit("message_end", { message: { role: "assistant", model: "model-b", provider: "another-provider", content: [{ type: "text", text: "NEW-ANSWER" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  const result = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1).body.markdown.content;
  assertSource(result, "Model B", "another-provider");
  assert.match(result, /\n\nNEW-ANSWER$/);
  assert.doesNotMatch(result, /OLD-TOOL-TURN/);
});

test("a completed reply survives reconnect and ignores unrelated local output", async () => {
  inbound("reconnect");
  await drain();
  ws.close();
  await emit("message_end", { message: { role: "assistant", model: "model-a", provider: "test-provider", content: [{ type: "text", text: "REMOTE-RESULT" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  ctx.model = { ...ctx.model!, ...modelB };
  ctx.cwd = join(sandbox, "UNRELATED-PROJECT");
  await emit("message_end", { message: { role: "assistant", model: "model-b", provider: "another-provider", content: [{ type: "text", text: "LOCAL-ONLY" }] } });
  await emit("agent_settled", { aborted: false });
  clock.tick(1000);
  const nextWs = FakeWebSocket.instances.at(-1)!;
  nextWs.open();
  nextWs.acknowledge();
  await drain();
  const status = nextWs.sent.find((frame) => frame.cmd === "aibot_respond_msg");
  assert.equal(status.headers.req_id, "callback-reconnect");
  assert.equal(status.body.stream.finish, true);
  assert.match(status.body.stream.content, /本轮已结束/);
  const replies = nextWs.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.chatid, "test-user");
  assert.equal(replies[0].body.chat_type, 1);
  assertSource(replies[0].body.markdown.content);
  assert.match(replies[0].body.markdown.content, /\n\nREMOTE-RESULT$/);
  assert.doesNotMatch(replies[0].body.markdown.content, /LOCAL-ONLY|UNRELATED|Model B/);
});

test("a long task closes the status animation and later sends exactly one final notification", async () => {
  inbound("long-task");
  await drain();
  clock.tick(590_000);
  const closedStream = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
  assert.equal(closedStream.body.stream.finish, true);
  assert.match(closedStream.body.stream.content, /请等待会话通知/);
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "FINAL-LONG-RESULT" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  const results = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(results.length, 1);
  const final = results[0];
  assert.equal(final.body.msgtype, "markdown");
  assertSource(final.body.markdown.content);
  assert.match(final.body.markdown.content, /\n\nFINAL-LONG-RESULT$/);
});

test("long Chinese and emoji replies remain valid UTF-8 within the byte limit", async () => {
  inbound("long-text");
  await drain();
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "汉字🙂".repeat(4000) }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  const content = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1).body.markdown.content;
  assertSource(content);
  assert.ok(Buffer.byteLength(content, "utf8") <= 20_480);
  assert.equal(content.includes("\ufffd"), false);
  assert.match(content, /已截断/);
});

test("an aborted task ends its status and includes the cancellation in its result", async () => {
  inbound("aborted");
  await drain();
  idle = true;
  await emit("agent_settled", { aborted: true });
  const status = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
  assert.equal(status.body.stream.finish, true);
  assert.match(status.body.stream.content, /本轮已结束/);
  const result = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1).body.markdown.content;
  assert.equal((result.match(/已中止/g) ?? []).length, 1);
});

test("the pi bridge also checks the allowlist before accepting a task", async () => {
  saveConfig({ botId: "test-bot", secret: "test-secret", allowedUserIds: ["allowed-user"] });
  await emit("session_start");
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  inbound("blocked");
  ws.receive({ cmd: "aibot_event_callback", headers: { req_id: "blocked-enter" }, body: { from: { userid: "test-user" }, event: { eventtype: "enter_chat" } } });
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_respond_welcome_msg").length, 0);
  inbound("allowed", { from: { userid: "allowed-user" } });
  await drain();
  assert.equal(sent.length, 1);
});

test("a queued task cannot run after the underlying pi session ID changes", async () => {
  idle = false;
  inbound("must stay in original session");
  await drain();
  sessionId = "unexpected-new-session";
  idle = true;
  clock.tick(250);
  await drain();
  assert.equal(sent.length, 0);
  assert.equal(ws.readyState, 3);
});

test("a new session's output cannot fill an old session's active notification", async () => {
  inbound("original task");
  await drain();
  sessionId = "unexpected-new-session";
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "NEW-SESSION-ONLY" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  assert.equal(ws.sent.some((frame) => JSON.stringify(frame.body).includes("NEW-SESSION-ONLY")), false);
});

test("disconnect leaves shared config unchanged and a session switch requires manual connect", async () => {
  const saved = await readFile(CONFIG_FILE, "utf8");
  await command("disconnect", ctx);
  assert.equal(await readFile(CONFIG_FILE, "utf8"), saved);
  sessionId = "pi-session-2";
  await emit("session_start");
  assert.equal(FakeWebSocket.instances.length, 1);
  await command("connect", ctx);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test("proactive push validates bytes and waits for the server acknowledgement", async () => {
  autoAcknowledge = false;
  const tool = tools.get("wecom_send");
  await assert.rejects(tool.execute("bad", { chatid: "test-user", content: "汉".repeat(7000) }), /20480/);
  const result = tool.execute("push", { chatid: "test-group", chat_type: 2, content: "hello" });
  const push = ws.sent.at(-1);
  assert.equal(push.cmd, "aibot_send_msg");
  assert.equal(push.body.chatid, "test-group");
  assert.equal(push.body.chat_type, 2);
  ws.acknowledge(push);
  assert.equal((await result).details.chat_type, 2);
});

test("a malformed incoming message cannot block the next queued request", async () => {
  inbound("malformed", { chattype: "group", text: { content: 123 } });
  inbound("valid");
  await drain();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content[0].text, /valid/);
  const error = ws.sent.find((frame) => frame.headers.req_id === "callback-malformed");
  assert.equal(error.body.stream.finish, true);
});

test("notifications include the actual session, provider, model name and last directory", async () => {
  const pending = sendNotification({
    chatid: "test-user", session_id: "pi-session-1", content: "实际结果",
  });
  const frame = ws.sent.at(-1);
  assertSource(frame.body.markdown.content);
  assert.match(frame.body.markdown.content, /实际结果/);
  ws.acknowledge(frame);
  const { details } = await pending;
  assert.equal(details.session_id, "pi-session-1");
  assert.equal(details.provider, "test-provider");
  assert.equal(details.model_name, "Model A");
  assert.equal(details.directory_name, basename(sandbox));
});

test("an excerpt uses its original provider and model while custom content uses the current selection", async () => {
  await emit("message_end", { message: {
    role: "assistant", model: "model-a", provider: "test-provider", content: [{ type: "text", text: "ORIGINAL-ANSWER" }],
  } });
  ctx.model = { ...ctx.model!, ...modelB };
  const excerpt = sendNotification({ chatid: "test-user" });
  const first = ws.sent.at(-1);
  assertSource(first.body.markdown.content, "Model A");
  ws.acknowledge(first);
  const excerptDetails = (await excerpt).details;
  assert.equal(excerptDetails.model_name, "Model A");
  assert.equal(excerptDetails.provider, "test-provider");
  const custom = sendNotification({ chatid: "test-user", content: "NEW-CONTENT" });
  const second = ws.sent.at(-1);
  assertSource(second.body.markdown.content, "Model B", "another-provider");
  ws.acknowledge(second);
  const customDetails = (await custom).details;
  assert.equal(customDetails.model_name, "Model B");
  assert.equal(customDetails.provider, "another-provider");
});

test("notifications can extract the last paragraphs from pi's latest visible reply", async () => {
  await emit("message_end", { message: { role: "assistant", content: [
    { type: "thinking", thinking: "PRIVATE-THINKING" },
    { type: "text", text: "第一段\n\n第二段\n\n第三段\n\n第四段" },
    { type: "toolCall", name: "bash", arguments: { command: "PRIVATE-TOOL" } },
  ] } });
  await emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE-TOOL-RESULT" }] } });
  const pending = sendNotification({ chatid: "test-user", tail_paragraphs: 2 });
  const frame = ws.sent.at(-1);
  assert.equal(frame.cmd, "aibot_send_msg");
  assert.match(frame.body.markdown.content, /第三段\n\n第四段$/);
  assert.doesNotMatch(frame.body.markdown.content, /第一段|第二段|PRIVATE-/);
  ws.acknowledge(frame);
  await pending;
});

test("omitting content defaults to the last three paragraphs and the current session ID", async () => {
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "第一段\n\n第二段\n\n第三段\n\n第四段" }] } });
  const pending = sendNotification({ chatid: "test-user" });
  const frame = ws.sent.at(-1);
  assert.match(frame.body.markdown.content, /pi-session-1/);
  assert.match(frame.body.markdown.content, /第二段\n\n第三段\n\n第四段$/);
  assert.doesNotMatch(frame.body.markdown.content, /第一段/);
  ws.acknowledge(frame);
  assert.equal((await pending).details.tail_paragraphs, 3);
});

test("a completion notification waits for the real final reply", async () => {
  autoAcknowledge = false;
  idle = false;
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "正在处理" }] } });
  const scheduled = await sendNotification({
    chatid: "test-user", after_settle: true, tail_paragraphs: 2,
  });
  assert.equal(scheduled.details.status, "queued");
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
  inbound("next-after-notification");
  await drain();
  await emit("message_end", { message: { role: "assistant", model: "model-b", provider: "another-provider", content: [{ type: "text", text: "开头\n\n最终结果\n\n验证通过" }] } });
  idle = true;
  let settled = false;
  const settlement = emit("agent_settled", { aborted: false }).then(() => { settled = true; });
  const frame = ws.sent.at(-1);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.tick(1000);
    assert.equal(settled, false, "pi must wait for the notification acknowledgement before completing");
    assert.equal(sent.length, 0, "queued pi work must wait for the settlement boundary");
    assert.equal(frame.cmd, "aibot_send_msg");
    assertSource(frame.body.markdown.content, "Model B", "another-provider");
    assert.ok(frame.body.markdown.content.startsWith(`🔔 ${basename(sandbox)} · 会话通知  \n`));
    assert.match(frame.body.markdown.content, /最终结果\n\n验证通过$/);
    assert.doesNotMatch(frame.body.markdown.content, /正在处理|开头/);
  } finally {
    ws.acknowledge(frame);
    await settlement;
  }
  await drain();
});

test("completion without a new reply cannot accidentally forward an earlier task", async () => {
  ws.onSend = (frame) => { if (frame.cmd === "aibot_send_msg") ws.acknowledge(frame); };
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "PREVIOUS-TASK" }] } });
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true });
  idle = true;
  await emit("agent_settled", { aborted: true });
  const frame = ws.sent.at(-1);
  assert.equal(frame.cmd, "aibot_send_msg");
  assert.match(frame.body.markdown.content, /中止/);
  assert.doesNotMatch(frame.body.markdown.content, /PREVIOUS-TASK/);
  ws.acknowledge(frame);
  await drain();
});

test("a recorded model error is sent once while the status only reports that the run ended", async () => {
  inbound("error-task");
  await drain();
  await sendNotification({ chatid: "test-user", after_settle: true });
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "EARLIER-PROGRESS" }] } });
  await emit("message_start", { message: { role: "assistant" } });
  await emit("message_end", { message: {
    role: "assistant", model: "model-a", provider: "test-provider", content: [],
    stopReason: "error", errorMessage: "429: rate limit exceeded",
  } });
  ws.onSend = (frame) => { if (frame.cmd === "aibot_send_msg") ws.acknowledge(frame); };
  idle = true;
  await emit("agent_settled", { aborted: false });
  const status = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1).body.stream.content;
  assert.equal(status, "🆔 session: pi-session-1  \n本轮已结束。");
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 1);
  const content = pushes[0].body.markdown.content;
  assertSource(content);
  assert.ok(content.startsWith(`🔔 ${basename(sandbox)} · 会话通知  \n`));
  assert.match(content, /错误信息：429: rate limit exceeded$/);
  assert.doesNotMatch(content, /EARLIER-PROGRESS|任务完成/);
});

test("an explicit session ID cannot mislabel another session's output", async () => {
  const rejected = assert.rejects(sendNotification({
    chatid: "test-user", session_id: "another-session", content: "result",
  }), /session_id/);
  if (ws.sent.at(-1).cmd === "aibot_send_msg") ws.acknowledge();
  await rejected;
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("disconnect cancels notifications scheduled for the end of a run", async () => {
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true });
  await command("disconnect", ctx);
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "LATE-RESULT" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("wecom_send without a target replies to the chat that sent the WeCom task", async () => {
  inbound("source-target-task");
  await drain();
  const result = await sendNotification({ content: "SOURCE-REPLY" });
  assert.equal(result.details.chatid, "test-user");
  const push = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
  assert.equal(push.body.chatid, "test-user");
  assert.equal(push.body.chat_type, 1);
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "DONE" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
});

test("group messages addressed to the bot reach pi and receive a reply in that conversation", async () => {
  inbound("group-request", {
    chattype: "group", chatid: "test-group", text: { content: taskText("帮我检查项目") },
  });
  await drain();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content[0].text, /帮我检查项目/);
  assert.doesNotMatch(sent[0].content[0].text, /@Robot|\[企业微信|chatid=|chat_type=/);
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "检查完成" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  const reply = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
  assert.equal(reply.headers.req_id, "callback-group-request");
  assert.match(reply.body.stream.content, /本轮已结束/);
  const notification = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
  assert.equal(notification.body.chatid, "test-group");
  assert.equal(notification.body.chat_type, 2);
  assertSource(notification.body.markdown.content);
  assert.match(notification.body.markdown.content, /\n\n检查完成$/);
});

for (const reconnectEarly of [false, true]) test(`a known-unsent completion survives a closing socket (${reconnectEarly ? "reconnect before result" : "result before reconnect"})`, async () => {
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true, content: "KNOWN-UNSENT-RESULT" });
  // CLOSING precedes onclose: the gateway's cached status still says subscribed.
  ws.readyState = 2;
  idle = true;
  const pending = emit("agent_settled", { aborted: false });
  if (!reconnectEarly) await pending;
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
  ws.close();
  clock.tick(1000);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  await pending;
  await drain();
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].body.markdown.content, /KNOWN-UNSENT-RESULT/);
  await emit("agent_settled", { aborted: false });
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
});

test("a completion whose ACK was lost is not automatically pushed again after reconnect", async () => {
  autoAcknowledge = false;
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true, content: "UNKNOWN-DELIVERY-RESULT" });
  idle = true;
  const pending = emit("agent_settled", { aborted: false });
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
  ws.close();
  await pending;
  clock.tick(1000);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  await drain();
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("overlapping settlement events wait for one push rather than duplicating an in-flight completion", async () => {
  autoAcknowledge = false;
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true, content: "ONCE" });
  idle = true;
  const first = emit("agent_settled", { aborted: false });
  let secondDone = false;
  const second = emit("agent_settled", { aborted: false }).then(() => { secondDone = true; });
  await drain();
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 1);
  assert.equal(secondDone, false, "every settlement waits for the outstanding ACK");
  ws.acknowledge(pushes[0]);
  await Promise.all([first, second]);
});

test("a newer queued task keeps its reply while an older completion awaits ACK after reconnect", async () => {
  autoAcknowledge = false;
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true, content: "OLDER-COMPLETION" });
  inbound("newer-task");
  await drain();
  ws.close();
  idle = true;
  await emit("agent_settled", { aborted: false });
  clock.tick(1000);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  await drain();
  assert.equal(sent.length, 1);
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "NEWER-REPLY" }] } });
  idle = true;
  const settled = emit("agent_settled", { aborted: false });
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 2);
  assert.match(pushes[0].body.markdown.content, /OLDER-COMPLETION/);
  assert.match(pushes[1].body.markdown.content, /NEWER-REPLY/);
  ws.acknowledge(pushes[0]);
  await drain();
  ws.acknowledge(pushes[1]);
  await settled;
  await emit("agent_settled", { aborted: false });
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 2);
});

test("an offline completion notification retains its snapshot until reconnect", async () => {
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true });
  ws.close();
  await emit("message_end", { message: { role: "assistant", model: "model-a", provider: "test-provider", content: [{ type: "text", text: "ORIGINAL-RESULT" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  ctx.model = { ...ctx.model!, ...modelB };
  ctx.cwd = join(sandbox, "UNRELATED-PROJECT");
  await emit("message_end", { message: { role: "assistant", model: "model-b", provider: "another-provider", content: [{ type: "text", text: "UNRELATED-LOCAL-RESULT" }] } });
  await emit("agent_settled", { aborted: false });
  clock.tick(1000);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  const frame = ws.sent.at(-1);
  assert.equal(frame.cmd, "aibot_send_msg");
  assertSource(frame.body.markdown.content);
  assert.match(frame.body.markdown.content, /ORIGINAL-RESULT/);
  assert.doesNotMatch(frame.body.markdown.content, /UNRELATED/);
  ws.acknowledge(frame);
  await drain();
});

test("switching sessions cancels a scheduled notification", async () => {
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true });
  sessionId = "pi-session-2";
  sessionEntries = [];
  await emit("session_start");
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ANOTHER-SESSION" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("changing branches cannot substitute another branch's reply into a notification", async () => {
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL-BRANCH" }] } });
  idle = false;
  await sendNotification({ chatid: "test-user", after_settle: true });
  sessionEntries = [{ type: "message", id: "other-branch", message: { role: "assistant", content: [{ type: "text", text: "OTHER-BRANCH" }] } }];
  idle = true;
  await emit("agent_settled", { aborted: false });
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("notifications use the configured target without changing an explicit target's chat type", async () => {
  saveConfig({ botId: "test-bot", secret: "test-secret", defaultChatId: "configured-group", defaultChatType: 2 });
  await emit("session_start");
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  const defaultSend = sendNotification({ content: "default target" });
  const defaultFrame = ws.sent.at(-1);
  assert.equal(defaultFrame.cmd, "aibot_send_msg");
  assert.equal(defaultFrame.body.chatid, "configured-group");
  assert.equal(defaultFrame.body.chat_type, 2);
  ws.acknowledge(defaultFrame);
  await defaultSend;
  const explicitSend = sendNotification({ chatid: "explicit-user", content: "explicit target" });
  const explicitFrame = ws.sent.at(-1);
  assert.equal(explicitFrame.body.chatid, "explicit-user");
  assert.equal(explicitFrame.body.chat_type, 1);
  ws.acknowledge(explicitFrame);
  await explicitSend;
});

test("the deployment test command sends a labelled test to the default target and waits for confirmation", async () => {
  autoAcknowledge = false;
  saveConfig({ botId: "test-bot", secret: "test-secret", defaultChatId: "test-user", defaultChatType: 1 });
  await emit("session_start");
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  const pending = command("test", ctx);
  void pending.catch(() => {});
  const frame = ws.sent.at(-1);
  assert.equal(frame.cmd, "aibot_send_msg");
  assert.equal(frame.body.chatid, "test-user");
  assert.match(frame.body.markdown.content, /部署测试/);
  assertSource(frame.body.markdown.content);
  ws.acknowledge(frame);
  await pending;
});

test("every help form describes targets and the actual config path without executing commands or clearing queued notifications", async (t) => {
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  t.mock.method(ctx.ui, "confirm", async () => assert.fail("help must not request confirmation"));
  const saved = await readFile(CONFIG_FILE, "utf8");
  const frameCount = ws.sent.length;
  idle = false;
  await sendNotification({ chatid: "test-user", content: "PRESERVED-NOTIFICATION", after_settle: true });
  const variants = ["--help", "-h", "setup --help", "setup --bot-id sensitive-bot --secret=sensitive-secret --help", "connect --help", "disconnect -h", "logout --help", "test --help", "test your-userid --chat-type 1 --help", "whoami --help", "whoami --wait 180 -h", "setup whoami --help", "setup whoami --bot-id sensitive-bot --wait 300 -h"];
  for (const args of variants) await command(args, ctx);
  assert.equal(notices.length, variants.length);
  for (const help of notices) {
    assert.ok(help.includes(CONFIG_FILE), "help must use this pi's resolved configuration path");
    assert.doesNotMatch(help, /test-secret|sensitive-secret|sensitive-bot/);
  }
  assert.equal(notices[0], notices[1], "--help and -h both show the total help");
  assert.match(notices[2], /^setup — /, "a topic help is scoped to that command");
  assert.match(notices[0], /defaultChatId/);
  assert.match(notices[0], /defaultChatType/);
  assert.match(notices[0], /1 = 单聊，2 = 群聊/);
  assert.equal(await readFile(CONFIG_FILE, "utf8"), saved);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(ws.readyState, 1);
  assert.equal(ws.sent.length, frameCount, "help must not send a deployment test or reconnect");
  idle = true;
  await emit("agent_settled", { aborted: false });
  assert.match(ws.sent.at(-1).body.markdown.content, /PRESERVED-NOTIFICATION/);
});

test("help works before configuration without creating a file or starting a connection", async (t) => {
  await command("disconnect", ctx);
  clearConfig();
  await emit("session_start");
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  await command("--help", ctx);
  assert.match(notices[0], /\/wecom-aibot setup/);
  // One file of its own next to pi's settings.json, in the agent directory pi was started with.
  assert.equal(CONFIG_FILE, join(sandbox, "wecom-aibot", "config.json"));
  assert.ok(notices[0].includes(CONFIG_FILE));
  await assert.rejects(readFile(CONFIG_FILE), { code: "ENOENT" });
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("unknown subcommands point to help instead of silently showing status", async (t) => {
  const notices: { message: string; type: string }[] = [];
  t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
  await command("strat", ctx);
  assert.equal(notices[0].type, "warning");
  assert.match(notices[0].message, /\/wecom-aibot --help/);
  assert.equal(ws.readyState, 1);
  assert.equal(FakeWebSocket.instances.length, 1);
});

test("subcommand help is scoped and identical for --help, -h and a leading --help", async (t) => {
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  await command("connect --help", ctx);
  await command("--help connect", ctx);
  await command("connect -h", ctx);
  assert.equal(notices[0], notices[1]);
  assert.equal(notices[0], notices[2]);
  assert.match(notices[0], /用法：\/wecom-aibot connect$/m);
  assert.match(notices[0], /每个 session.*手动.*\/wecom-aibot connect/);
  assert.doesNotMatch(notices[0], /\/wecom-aibot setup \[--bot-id/);
});

test("actions written as options, unknown options and extra positional arguments fail before side effects", async (t) => {
  const notices: { message: string; type: string }[] = [];
  t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
  t.mock.method(ctx.ui, "confirm", async () => assert.fail("invalid arguments must not request confirmation"));
  const saved = await readFile(CONFIG_FILE, "utf8");
  const frameCount = ws.sent.length;
  const invalid = ["--connect", "--disconnect", "connect --unknown", "disconnect --unknown", "logout extra", "disconnect extra", "connect help", "--chatid user", "--whoami",
    "setup bot secret", "setup --botid x", "setup --bot-id", "setup --bot-id a --bot-id b", "setup --chat-type 2", "setup whoami --chatid x", "setup whoami --chat-type 2", "setup --wait 300", "setup connect", "setup whoami whoami", "setup --whoami",
    "setup --chatid 'x'", 'test "user"',
    "test user 2", "test --chat-type 3 user", "test --chat-type 2", "whoami 120", "whoami --wait 5", "whoami --wait=abc", "connect --wait 120"];
  for (const args of invalid) await command(args, ctx);
  assert.equal(notices.length, invalid.length);
  assert.ok(notices.every((notice) => notice.type === "warning"));
  assert.match(notices[0].message, /connect 是子命令，不带 --/);
  assert.match(notices[0].message, /\/wecom-aibot connect/);
  assert.equal(await readFile(CONFIG_FILE, "utf8"), saved);
  assert.equal(ws.readyState, 1);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(ws.sent.length, frameCount);
});

test("an immediate excerpt only reads the current run, never the previous run's answer", async () => {
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "PREVIOUS-RUN" }] } });
  await emit("agent_start");
  await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "把结果发到企微" }] } });
  // pi persists the assistant message before running its tool calls; this one has no text.
  await emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", name: "wecom_send", arguments: {} }] } });
  await assert.rejects(sendNotification({ chatid: "test-user" }), /本轮还没有可摘录的文本回复/);
  assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
  await emit("message_end", { message: { role: "assistant", content: [
    { type: "text", text: "THIS-RUN" }, { type: "toolCall", name: "wecom_send", arguments: {} },
  ] } });
  await sendNotification({ chatid: "test-user" });
  const push = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
  assertSource(push.body.markdown.content);
  assert.match(push.body.markdown.content, /\n\nTHIS-RUN$/);
});

test("setup merges into the file as it is now: fields edited after this pi started survive", async () => {
  // A hand edit (or another window) adds an allowlist after this pi loaded its configuration.
  const edited = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8")), allowedUserIds: ["boss"] };
  await writeFile(CONFIG_FILE, JSON.stringify(edited));
  await command("setup --bot-id rotated-bot --secret rotated-secret --chatid boss", ctx);
  const saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual(saved.allowedUserIds, ["boss"]);
  assert.deepEqual([saved.botId, saved.secret, saved.defaultChatId, saved.defaultChatType], ["rotated-bot", "rotated-secret", "boss", 1]);
  // The reconnected bridge enforces the merged allowlist.
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  inbound("not-on-the-allowlist");
  await drain();
  assert.equal(sent.length, 0);
});

test("connect after a logout in another pi reports the missing configuration instead of restoring the secret", async (t) => {
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  clearConfig();
  await command("connect", ctx);
  assert.match(notices.at(-1)!, /尚未配置/);
  await assert.rejects(readFile(CONFIG_FILE), { code: "ENOENT" });
});

for (const [kind, broken] of [
  ["invalid JSON", "{ \"botId\": "],
  ["a wrongly typed field", JSON.stringify({ botId: "test-bot", secret: "test-secret", allowedUserIds: "alice" })],
] as const) {
  test(`connect reports ${kind} in the configuration instead of calling it unconfigured`, async (t) => {
    const notices: string[] = [];
    t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
    await writeFile(CONFIG_FILE, broken);
    await command("connect", ctx);
    const notice = notices.at(-1)!;
    assert.match(notice, /配置无法使用/);
    assert.ok(notice.includes(CONFIG_FILE), "the file to fix must be named");
    assert.doesNotMatch(notice, /尚未配置/);
  });
}

test("double dash keeps a literal --help target from being interpreted as an option", async () => {
  await command("test --chat-type 1 -- --help", ctx);
  const pushed = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].body.chatid, "--help");
  assert.equal(pushed[0].body.chat_type, 1);
});

test("logout reports deletion failure and stops this pi without claiming the credentials were cleared", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("uses POSIX directory permissions"); return; }
  const notices: string[] = [];
  Object.assign(ctx, { hasUI: true });
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  const before = await readFile(CONFIG_FILE, "utf8");
  // The configuration lives in the plugin folder: that is the directory whose write access governs deletion.
  await chmod(dirname(CONFIG_FILE), 0o500);
  try {
    await command("logout", ctx);
    assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
    assert.equal(notices.includes("已清除企业微信配置"), false);
    assert.match(notices.at(-1)!, /已停止.*配置.*删除失败/);
    assert.equal(ws.readyState, 3);
  } finally {
    await chmod(dirname(CONFIG_FILE), 0o700);
  }
});

for (const change of ["bot while waiting", "bot during confirmation", "Secret during confirmation"]) {
  test(`whoami cannot save an old identity after changing the ${change}`, async (t) => {
    const replacement = { botId: change.startsWith("Secret") ? "test-bot" : "replacement-bot", secret: "replacement-secret", enabled: true };
    const replace = () => writeFile(CONFIG_FILE, JSON.stringify(replacement));
    const notices = identityDialogs(t, async () => {
      if (change.includes("confirmation")) await replace();
      return true;
    });
    const pending = command("whoami", ctx);
    await drain();
    if (change.includes("waiting")) await replace();
    inbound("old-bot-identity");
    await pending;
    assert.deepEqual(JSON.parse(await readFile(CONFIG_FILE, "utf8")), replacement);
    assert.ok(notices.some((line) => /配置已改变/.test(line)), notices.join("\n"));
  });
}

test("stopping and restarting during whoami confirmation invalidates that registration's identity", async (t) => {
  const notices = identityDialogs(t, async () => {
    await command("disconnect", ctx);
    await command("connect", ctx);
    return true;
  });
  const pending = command("whoami", ctx);
  await drain();
  inbound("old-registration-identity");
  await pending;
  assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).defaultChatId, undefined);
  assert.ok(notices.some((line) => /已停止或切换/.test(line)), notices.join("\n"));
});

test("whoami validates its wait and its preconditions before waiting for any message", async (t) => {
  const notices: { message: string; type: string }[] = [];
  t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
  const frameCount = ws.sent.length;
  for (const args of ["whoami --wait 5", "whoami --wait 601", "whoami --wait=1.5", "whoami --wait abc"]) await command(args, ctx);
  assert.equal(notices.length, 4);
  assert.ok(notices.every((notice) => notice.type === "warning" && /10～600/.test(notice.message)));
  await command("disconnect", ctx);
  await command("whoami", ctx);
  assert.match(notices.at(-1)!.message, /\/wecom-aibot connect/);
  clearConfig();
  await emit("session_start");
  await command("whoami", ctx);
  assert.match(notices.at(-1)!.message, /\/wecom-aibot setup/);
  assert.equal(ws.sent.length, frameCount, "none of these may send or reply upstream");
});

test("whoami help explains the identification message and the wait", async (t) => {
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  await command("whoami --help", ctx);
  assert.match(notices[0], /用法：\/wecom-aibot whoami \[--wait <秒>\]/);
  assert.match(notices[0], /不会交给 pi 处理/);
  assert.match(notices[0], /群聊需 @机器人/);
  assert.match(notices[0], /默认 120/);
});

test("interactive setup: missing credentials are asked for, the target comes from a menu, Esc cancels", async (t) => {
  const notices: { message: string; type: string }[] = [];
  let answers: (string | undefined)[] = ["new-bot", "new-secret", "group_chat"];
  let choice: RegExp | undefined = /手动填写群聊/;
  const menus: string[][] = [];
  Object.assign(ctx, { hasUI: true });
  Object.assign(ctx.ui, {
    async input() { return answers.shift(); },
    async select(_title: string, options: string[]) { menus.push(options); return choice ? options.find((option) => choice!.test(option)) : undefined; },
  });
  t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
  await command("setup", ctx);
  let saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual([saved.botId, saved.secret, saved.defaultChatId, saved.defaultChatType], ["new-bot", "new-secret", "group_chat", 2]);
  assert.match(menus[0][0], /自动识别/);
  assert.equal(menus[0][3], "暂不设置");
  assert.match(notices.at(-1)!.message, /默认推送目标已保存：group_chat（群聊）/);

  // Credentials given as options: only the menu is shown, and it can keep the current target.
  choice = /保持当前/;
  await command("setup --bot-id new-bot --secret new-secret", ctx);
  assert.equal(menus[1][3], "保持当前：group_chat（群聊）");
  saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual([saved.defaultChatId, saved.defaultChatType], ["group_chat", 2]);
  assert.match(notices.at(-1)!.message, /默认推送目标保持：group_chat/);

  // Esc at the menu, an empty ID and a pasted ID with quotes all cancel before anything is written or reconnected.
  const before = await readFile(CONFIG_FILE, "utf8");
  const sockets = FakeWebSocket.instances.length;
  choice = undefined;
  await command("setup --bot-id other --secret other", ctx);
  choice = /手动填写单聊/;
  answers = [""];
  await command("setup --bot-id other --secret other", ctx);
  answers = ['"user_one"'];
  await command("setup --bot-id other --secret other", ctx);
  assert.match(notices.at(-2)!.message, /含引号或空格/);
  assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
  assert.equal(FakeWebSocket.instances.length, sockets);
  assert.equal(notices.filter((notice) => /已取消，配置未修改/.test(notice.message)).length, 3);
});

test("setup options are used as given: --chatid is always a literal ID, even whoami", async () => {
  Object.assign(ctx.ui, { async input() { return assert.fail("no prompt when every value is given"); } });
  await command("setup --bot-id new-bot --secret=new-secret --chatid group_chat --chat-type 2", ctx);
  let saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual([saved.botId, saved.secret, saved.defaultChatId, saved.defaultChatType], ["new-bot", "new-secret", "group_chat", 2]);
  // No special values: a userid that happens to be "whoami" is saved like any other.
  await command("setup --chatid whoami --secret s2 --bot-id b2", ctx);
  saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual([saved.botId, saved.secret, saved.defaultChatId, saved.defaultChatType], ["b2", "s2", "whoami", 1]);
  // Without a UI and without --chatid, the current target is kept.
  await command("setup --bot-id b3 --secret s3", ctx);
  saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual([saved.botId, saved.defaultChatId], ["b3", "whoami"]);
});

test("setup connects only this session and leaves the shared file otherwise untouched", async () => {
  await writeFile(CONFIG_FILE, JSON.stringify({ botId: "old-bot", secret: "old-secret", futureField: { kept: true } }));
  const sockets = FakeWebSocket.instances.length;
  await command("setup --bot-id fresh-bot --secret fresh-secret --chatid fresh-user", ctx);
  const saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  assert.deepEqual(saved.futureField, { kept: true }, "a field this version does not own survives the edit");
  assert.equal(FakeWebSocket.instances.length, sockets + 1, "setup connects the current session");
  await emit("session_start");
  assert.equal(FakeWebSocket.instances.length, sockets + 1, "the next session never connects automatically");
});

test("empty or dismissed setup credentials cancel without HTTP requests, config changes or reconnects", async (t) => {
  const notices: string[] = [];
  const prompts: string[] = [];
  let answers: (string | undefined)[] = [];
  let requests = 0;
  Object.assign(ctx, { hasUI: true });
  Object.assign(ctx.ui, {
    async input(title: string) { prompts.push(title); return answers.shift(); },
    async select() { return assert.fail("cancelled credentials must not open a target selector"); },
  });
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("setup must not make HTTP requests"); });
  const before = await readFile(CONFIG_FILE, "utf8");
  const sockets = FakeWebSocket.instances.length;
  const cases: { input: string; answers: (string | undefined)[] }[] = [
    { input: "setup", answers: [""] },
    { input: "setup", answers: ["   "] },
    { input: "setup", answers: [undefined] },
    { input: "setup --secret given-secret", answers: [""] },
    { input: "setup --bot-id given-bot", answers: [""] },
    { input: "setup --bot-id given-bot", answers: ["   "] },
    { input: "setup --bot-id given-bot", answers: [undefined] },
    { input: "setup", answers: ["given-bot", ""] },
    { input: "setup whoami", answers: [""] },
    { input: "setup --chatid boss", answers: [""] },
  ];
  for (const item of cases) {
    answers = [...item.answers];
    await command(item.input, ctx);
    assert.match(notices.at(-1)!, /已取消，配置未修改/);
    assert.equal(requests, 0);
    assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
    assert.equal(FakeWebSocket.instances.length, sockets);
    assert.equal(ws.readyState, 1, "cancelling setup must preserve the working connection");
  }
  assert.ok(prompts.every((title) => title === "企业微信 BotID" || title === "长连接 Secret"));
});

test("empty setup does not provision a bot or create configuration on first use", async (t) => {
  await command("disconnect", ctx);
  clearConfig();
  await emit("session_start");
  const notices: string[] = [];
  Object.assign(ctx, { hasUI: true });
  Object.assign(ctx.ui, { async input() { return ""; } });
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("no provisioning requests"); });
  const sockets = FakeWebSocket.instances.length;
  await command("setup", ctx);
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(notices.at(-1)!, /已取消，配置未修改/);
  await assert.rejects(readFile(CONFIG_FILE), { code: "ENOENT" });
  assert.equal(FakeWebSocket.instances.length, sockets);
});

test("setup help only offers credentials for an existing bot", async (t) => {
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  for (const input of ["setup --help", "setup -h"]) await command(input, ctx);
  for (const help of notices) {
    assert.match(help, /已有机器人/);
    assert.match(help, /BotID/);
    assert.match(help, /Secret/);
    assert.doesNotMatch(help, /扫码|二维码|\/ai\/qc\//);
  }
  // The total help describes setup but keeps its credentials under `setup --help`.
  await command("--help", ctx);
  const total = notices.at(-1)!;
  assert.match(total, /已有机器人/);
  assert.doesNotMatch(total, /扫码|二维码|\/ai\/qc\//);
});

test("an action and a value never mix: setup whoami runs two actions, quotes are rejected rather than removed", async (t) => {
  const notices: string[] = [];
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  const saved = await readFile(CONFIG_FILE, "utf8");
  const frameCount = ws.sent.length;
  await command("setup --whoami", ctx);
  assert.match(notices.at(-1)!, /请使用 \/wecom-aibot setup whoami/);
  await command("setup --wait 300", ctx);
  assert.match(notices.at(-1)!, /--wait 属于 whoami，写成 \/wecom-aibot setup whoami --wait <秒>/);
  await command("setup whoami --chatid user_one", ctx);
  assert.match(notices.at(-1)!, /由识别结果决定默认推送目标/);
  await command("setup connect", ctx);
  assert.match(notices.at(-1)!, /setup 后面只能接 whoami，connect 请单独运行/);
  await command("whoami setup", ctx);
  assert.match(notices.at(-1)!, /whoami 后面不能再接其他动作/);
  await command('test "user_one"', ctx);
  assert.match(notices.at(-1)!, /chatid「"user_one"」含引号或空格/);
  assert.equal(await readFile(CONFIG_FILE, "utf8"), saved);
  assert.equal(ws.sent.length, frameCount);
});

test("argument completion offers subcommands, each command's own options and whoami after setup", () => {
  const values = (prefix: string) => complete(prefix)?.map((item) => item.value) ?? null;
  assert.deepEqual(values("se"), ["setup"]);
  assert.deepEqual(values("--h"), ["--help"]);
  assert.deepEqual(values("setup w"), ["setup whoami"]);
  assert.deepEqual(values("setup --bot-id x w"), ["setup --bot-id x whoami"]);
  assert.deepEqual(values("setup --c"), ["setup --chatid ", "setup --chat-type "]);
  assert.deepEqual(values("setup --bot-id x --"), ["setup --bot-id x --secret ", "setup --bot-id x --chatid ", "setup --bot-id x --chat-type ", "setup --bot-id x --help"]);
  // After `setup whoami`: whoami's --wait is offered, and the target options it decides are not.
  assert.deepEqual(values("setup whoami --"), ["setup whoami --bot-id ", "setup whoami --secret ", "setup whoami --wait ", "setup whoami --help"]);
  assert.deepEqual(values("test x --"), ["test x --chat-type ", "test x --help"]);
  assert.deepEqual(values("whoami --w"), ["whoami --wait "]);
  // A command with nothing to pass has no --help to offer: `connect` and `status` are bare actions.
  assert.equal(values("connect -"), null);
  assert.equal(values("status -"), null);
  assert.deepEqual(values("test -"), ["test --chat-type ", "test --help"]);
  // A finished token or a value position shows no list: Enter must run the command, not apply a completion.
  for (const done of ["setup", "setup whoami", "setup --chatid w", "setup --chatid x w", "whoami --wait", "--help", "connect x", "connect ", "setup "]) {
    assert.equal(complete(done), null, done);
  }
});

test("brief disconnects and successful reconnects do not repeat UI notices", async (t) => {
  const notices: string[] = [];
  Object.assign(ctx, { hasUI: true });
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  for (let i = 0; i < 3; i++) {
    ws.close();
    clock.tick(1000);
    ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    ws.acknowledge();
  }
  assert.deepEqual(notices, [], "short outages must be logged, not announced on every reconnect");
});

test("an outage is reported once after 30 seconds and recovery is announced once", async (t) => {
  const notices: { message: string; type: string }[] = [];
  Object.assign(ctx, { hasUI: true });
  t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
  ws.close();
  clock.tick(29_999);
  assert.equal(notices.length, 0);
  clock.tick(1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "warning");
  assert.match(notices[0].message, /30 秒.*自动重连.*\/wecom-aibot log/);
  clock.tick(1000);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  assert.equal(notices.length, 2);
  assert.match(notices[1].message, /恢复/);
  assert.equal(notices[1].type, "info");
  await drain();
  assert.equal(notices.length, 2);
});

test("disconnect cancels a delayed disconnect warning", async (t) => {
  const notices: string[] = [];
  Object.assign(ctx, { hasUI: true });
  t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
  ws.close();
  await command("disconnect", ctx);
  notices.length = 0;
  clock.tick(60_000);
  assert.deepEqual(notices, []);
});

test("a refused first subscription is reported in pi instead of leaving the bridge silently waiting", async (t) => {
  const notices: { message: string; type: string }[] = [];
  Object.assign(ctx, { hasUI: true });
  t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
  await emit("session_start");
  await command("connect", ctx);
  for (const [index, delay] of [1000, 2000, 4000, 8000, 0].entries()) {
    const socket = FakeWebSocket.instances.at(-1)!;
    assert.equal(FakeWebSocket.instances.length, index + 2);
    socket.open();
    socket.acknowledge(undefined, 40001);
    clock.tick(delay);
  }
  const stopped = notices.filter((notice) => /连接已停止/.test(notice.message));
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].type, "warning");
  assert.match(stopped[0].message, /subscribe failed: 40001.*BotID\/Secret.*\/wecom-aibot connect/);
  await command("status", ctx);
  assert.match(notices.at(-1)!.message, /subscribe failed: 40001/);
  await command("connect", ctx);
  assert.equal(FakeWebSocket.instances.length, 7, "/wecom-aibot connect subscribes again");
});

test("a file from WeCom is saved in the project with a .gitignore that keeps it out of commits", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.from("%PDF-1.4 test"), { headers: { "content-type": "application/pdf" } }));
  inbound("file-1", { msgtype: "file", file: { url: "https://example.invalid/file" } });
  // Saving is real file I/O: wait on the real clock, the mocked one does not cover it.
  const deadline = performance.now() + 4000;
  while (!sent.length && performance.now() < deadline) await drain();
  const saved = join(sandbox, ".pi-wecom-aibot-files", "file-1-file.pdf");
  assert.ok(sent[0].content[0].text.includes(`[文件已保存到：${saved}]`));
  assert.equal(await readFile(saved, "utf8"), "%PDF-1.4 test");
  assert.match(await readFile(join(sandbox, ".pi-wecom-aibot-files", ".gitignore"), "utf8"), /^\*$/m);
});

async function imageModeStart() {
  saveConfig({ botId: "test-bot", secret: "test-secret", sendMode: "image" });
  const fixture = installTuiFixture(ctx);
  await emit("session_start");
  await command("connect", ctx);
  ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.acknowledge();
  return fixture;
}

test("image mode sends an automatic result as a native image message with no Markdown body", async () => {
  const fixture = await imageModeStart();
  fixture.state.lines = ["SCREEN-ANSWER", "tool output"];
  inbound("image-mode-task");
  await drain();
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "FINAL-ANSWER" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.msgtype, "image");
  assert.equal(pushes[0].body.image.media_id, "media-1");
  assert.equal(pushes[0].body.markdown, undefined);
});

test("image mode keeps explicit content as Markdown and never uploads an image", async () => {
  await imageModeStart();
  await sendNotification({ chatid: "test-user", content: "EXPLICIT-CONTENT" });
  const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
  assert.equal(pushes.at(-1)?.body.msgtype, "markdown");
  assert.match(pushes.at(-1)?.body.markdown.content ?? "", /EXPLICIT-CONTENT/);
  assert.equal(ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"), false);
});

test("image mode falls back to the Markdown answer when rendering is unavailable", async () => {
  rasterise = async () => { throw new Error("no rasteriser"); };
  await imageModeStart();
  inbound("image-fallback-task");
  await drain();
  await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "FINAL-TEXT" }] } });
  idle = true;
  await emit("agent_settled", { aborted: false });
  await drain();
  const push = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
  assert.equal(push.body.msgtype, "markdown");
  assert.match(push.body.markdown.content, /FINAL-TEXT/);
  assert.equal(ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"), false);
});

test("the deployment test stays text even in image mode", async () => {
  await imageModeStart();
  await command("test test-user", ctx);
  const push = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
  assert.equal(push.body.msgtype, "markdown");
  assert.match(push.body.markdown.content, /部署测试/);
  assert.equal(ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"), false);
});

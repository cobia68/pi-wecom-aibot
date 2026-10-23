import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, afterEach, beforeEach, type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { inspectPng } from "../../src/gateway/png-marker.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";
import { LoopbackClient } from "../support/loopback-client.ts";
import { TINY_PNG } from "../support/media.ts";
import { fixtureTheme, fixtureThemes, installTuiFixture, setLiveTheme } from "../support/tui-fixture.ts";

const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-bridge-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../../src/extension/index.ts");
const { writeLayer, clearConfig, layerFile, CONFIG_FILE, SESSIONS_DIR } = await import("../../src/extension/config.ts");
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
/** The session header pi reports; a fork names its parent here. */
let sessionHeader: { parentSession?: string } | null;
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
		cmd: "aibot_msg_callback",
		headers: { req_id: `callback-${id}` },
		body: {
			msgid: id,
			from: { userid: "test-user" },
			chattype: "single",
			msgtype: "text",
			text: { content: taskText(id) },
			...(media ? quote : {}),
			...extra,
			...(media ? quote : {}),
		},
	});
}

/** Every task names its target: the bridge tests speak the WeCom-side grammar. */
function taskText(prompt: string): string {
	return `/wecom-aibot --sessionid ${sessionId} send --prompt ${prompt}`;
}

function sendNotification(params: Record<string, unknown>): Promise<any> {
	const pending = tools.get("wecom_send").execute("notify", params, undefined, undefined, ctx);
	void pending.catch(() => {});
	return pending;
}

/**
 * Dialogs for config whoami: confirm answers with `confirm`; the waiting dialog stays open until the wait ends.
 * `codes` collects the one-time codes the waiting dialogs show, in order.
 */
function identityDialogs(
	t: TestContext,
	confirm: () => Promise<boolean> = async () => true,
): string[] & { codes: string[] } {
	const notices = Object.assign([] as string[], { codes: [] as string[] });
	Object.assign(ctx, { hasUI: true });
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	t.mock.method(ctx.ui, "confirm", confirm);
	Object.assign(ctx.ui, {
		select(title: string, _choices: string[], options: { signal: AbortSignal }) {
			const code = /把 (\d{6}) 发给机器人/.exec(title)?.[1];
			if (code) notices.codes.push(code);
			return new Promise<undefined>((resolve) =>
				options.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
			);
		},
	});
	return notices;
}

/** A WeCom message that is exactly this text, e.g. a one-time code. */
function plain(content: string, extra: Record<string, unknown> = {}): void {
	const id = `plain-${content}-${Math.random()}`;
	ws.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: `callback-${id}` },
		body: {
			msgid: id,
			from: { userid: "test-user" },
			chattype: "single",
			msgtype: "text",
			text: { content },
			...extra,
		},
	});
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
	sessionHeader = null;
	await rm(SESSIONS_DIR, { recursive: true, force: true });
	autoAcknowledge = true;
	refusePrompt = false;
	rasterise = async () =>
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
	ctx = {
		hasUI: false,
		cwd: sandbox,
		isIdle: () => idle,
		model: { ...modelA },
		modelRegistry: {
			find: (provider: string, id: string) =>
				[modelA, modelB].find((model) => model.provider === provider && model.id === id),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => sessionHeader,
			getBranch: () => sessionEntries,
			getLeafId: () => sessionEntries.at(-1)?.id ?? null,
		},
		ui: {
			notify() {},
			async confirm() {
				return true;
			},
			getAllThemes: fixtureThemes,
		},
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
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		sendUserMessage(content: any, options: any) {
			sent.push({ content, options });
			idle = false;
			// pi echoes the prompt it starts through before_agent_start; a refused prompt echoes nothing.
			if (!refusePrompt)
				void emit("before_agent_start", {
					messageType: "user",
					prompt:
						typeof content === "string"
							? content
							: content
									.filter((part: any) => part.type === "text")
									.map((part: any) => part.text)
									.join("\n"),
					images: typeof content === "string" ? undefined : content.filter((part: any) => part.type === "image"),
				});
		},
	} as unknown as ExtensionAPI;
	writeLayer("global", { botId: "test-bot", secret: "test-secret", defaultChatId: "default-user" });
	// The real gateway in-process: its routing, status messages and rendered notifications are what these tests assert.
	extension(pi, {
		renderScreen: (screen, options) => rasterise(screen, options),
		createClient: (options) =>
			new LoopbackClient(options, (url) => {
				const socket = new FakeWebSocket(url);
				socket.onSend = (frame) => {
					if (frame.cmd === "aibot_upload_media_init")
						socket.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { upload_id: "upload-1" } });
					else if (frame.cmd === "aibot_upload_media_chunk") socket.acknowledge(frame);
					else if (frame.cmd === "aibot_upload_media_finish")
						socket.receive({ headers: frame.headers, errcode: 0, errmsg: "ok", body: { media_id: "media-1" } });
					else if (
						frame.cmd === "ping" ||
						frame.cmd === "aibot_respond_msg" ||
						(autoAcknowledge && frame.cmd === "aibot_send_msg")
					)
						socket.acknowledge(frame);
				};
				return socket;
			}),
	});
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances[0];
	ws.open();
	ws.acknowledge();
	await drain();
	ws.sent.length = 0; // Each test starts after the separately tested connection entry.
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
	if (ws !== previous) {
		ws.open();
		ws.acknowledge();
	}
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
	// Replacing a registration with pending work needs a confirmation, which an interactive pi gives.
	Object.assign(ctx, { hasUI: true });
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	ws.sent.length = 0;
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
			options.signal!.addEventListener(
				"abort",
				() => {
					active--;
					reject(options.signal!.reason);
				},
				{ once: true },
			);
		});
	});
	idle = false;
	for (let i = 0; i < 50; i++)
		inbound(`bulk-${i}`, { msgtype: "image", image: { url: `https://example.invalid/${i}.png` } });
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
	t.mock.method(
		globalThis,
		"fetch",
		() =>
			new Promise<Response>((resolve) => {
				finishDownload = resolve;
			}),
	);
	inbound("first", { msgtype: "image", image: { url: "https://example.invalid/image" } });
	inbound("second");
	await drain();
	assert.equal(sent.length, 0);
	finishDownload(
		new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } }),
	);
	await drain();
	assert.equal(sent.length, 1);
	assert.deepEqual(
		sent[0].content.map((part: { type: string }) => part.type),
		["text", "image"],
		"the quoted source stays with the image",
	);
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.match(sent[1].content[0].text, /second/);
});

test("a media download finishing after stop never starts a pi task", async (t) => {
	let finishDownload!: (response: Response) => void;
	t.mock.method(
		globalThis,
		"fetch",
		() =>
			new Promise<Response>((resolve) => {
				finishDownload = resolve;
			}),
	);
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
	idle = false;
	await emit("before_agent_start", { messageType: "user", prompt: "LOCAL-ONLY-QUESTION" });
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "LOCAL-ONLY-ANSWER" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const status = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1)!;
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length,
		0,
		"the failure replaces the status message",
	);
	assert.equal(status.body.stream.finish, true);
	assert.match(status.body.stream.content, /没有接受/);
	assert.doesNotMatch(status.body.stream.content, /LOCAL-ONLY-ANSWER/);
	// The local run uses the configured default, never the refused task's source chat.
	await sendNotification({ content: "LOCAL-PUSH" });
	const localPush = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1)!;
	assert.equal(localPush.body.chatid, "default-user");
	assert.doesNotMatch(localPush.body.markdown.content, /LOCAL-ONLY-ANSWER/);
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
	idle = true;
	clock.tick(5_000);
	await drain();
	const status = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1)!;
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
	assert.match(status.body.stream.content, /没有接受/);
	assert.equal(status.body.stream.finish, true);
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
	await emit("message_end", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: "RESULT-1024" }],
		},
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	const results = ws.sent.filter((frame) =>
		(frame.body?.markdown?.content ?? frame.body?.stream?.content ?? "").includes("RESULT-1024"),
	);
	assert.equal(results.length, 1, "同一任务的结果只能发送一次");
	clock.tick(1_000); // the scheduled notification owns the result; the status closes by itself
	const statuses = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	assert.equal(statuses.length, 2, "状态消息只在开始和结束时各更新一次");
	assert.equal(statuses[0].body.stream.finish, false);
	assert.equal(statuses[0].body.stream.content, "🆔 session: pi-session-1  \n执行中…");
	assert.equal(statuses[1].body.stream.id, statuses[0].body.stream.id, "应更新同一条状态消息");
	assert.equal(statuses[1].body.stream.finish, true);
	assert.equal(statuses[1].body.stream.content, "🆔 session: pi-session-1  \n本轮已结束");
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
	const targets = ws.sent
		.filter((frame) => frame.cmd === "aibot_send_msg")
		.map((frame) => [frame.body.chatid, frame.body.chat_type]);
	assert.deepEqual(targets, [["another-chat", 2]], "the source chat's result replaces its status message");
	const status = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1)!;
	assert.equal(status.body.stream.finish, true);
	assert.match(status.body.stream.content, /\n\nRESULT$/);
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
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-b",
			provider: "another-provider",
			content: [{ type: "text", text: "NEW-ANSWER" }],
		},
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
	const result = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1).body.stream.content;
	assertSource(result, "Model B", "another-provider");
	assert.match(result, /\n\nNEW-ANSWER$/);
	assert.doesNotMatch(result, /OLD-TOOL-TURN/);
});

test("a completed reply survives reconnect and ignores unrelated local output", async () => {
	inbound("reconnect");
	await drain();
	ws.close();
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-a",
			provider: "test-provider",
			content: [{ type: "text", text: "REMOTE-RESULT" }],
		},
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	ctx.model = { ...ctx.model!, ...modelB };
	ctx.cwd = join(sandbox, "UNRELATED-PROJECT");
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-b",
			provider: "another-provider",
			content: [{ type: "text", text: "LOCAL-ONLY" }],
		},
	});
	await emit("agent_settled", { aborted: false });
	clock.tick(1000);
	const nextWs = FakeWebSocket.instances.at(-1)!;
	nextWs.open();
	nextWs.acknowledge();
	await drain();
	const status = nextWs.sent.find((frame) => frame.cmd === "aibot_respond_msg");
	assert.equal(status.headers.req_id, "callback-reconnect");
	assert.equal(status.body.stream.finish, true);
	assertSource(status.body.stream.content);
	assert.match(status.body.stream.content, /\n\nREMOTE-RESULT$/);
	assert.doesNotMatch(status.body.stream.content, /LOCAL-ONLY|UNRELATED|Model B/);
	assert.equal(nextWs.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("by default a run typed in the terminal stays local", async () => {
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).notificationScope, undefined);
	idle = false;
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "LOCAL-RUN-ANSWER" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("notificationScope=all-runs saved in another window sends a local run's answer without reconnecting", async () => {
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		notificationScope: "all-runs",
	});
	await drain();
	ws.sent.length = 0;
	idle = false;
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-a",
			provider: "test-provider",
			content: [{ type: "text", text: "LOCAL-RUN-ANSWER" }],
		},
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].body.chatid, "default-user");
	assertSource(pushes[0].body.markdown.content);
	assert.match(pushes[0].body.markdown.content, /\n\nLOCAL-RUN-ANSWER$/);
	assert.equal(sent.length, 0, "no prompt is handed to pi");
});

test("all-runs and a scheduled completion send the local answer only once", async () => {
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		notificationScope: "all-runs",
	});
	await drain();
	ws.sent.length = 0;
	idle = false;
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "EARLIER-TURN" }] },
	});
	// The scheduled completion owns this run's delivery; all-runs must not add a second message.
	await sendNotification({ chatid: "default-user", after_settle: true });
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "ONLY-ONCE" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1, "the scheduled completion owns the delivery");
	assert.match(pushes[0].body.markdown.content, /ONLY-ONCE/);
});

test("all-runs sends to the adopted target while a saved target waits for connect", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	await command("config set --scope global notificationScope=all-runs defaultChatId=new-user", ctx);
	assert.match(notices.at(-1)!, /通知设置已热更新；接入配置待重新接入/);
	const registration = ws;
	idle = false;
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "STILL-THE-OLD-TARGET" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(ws, registration, "saving never reconnects");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].body.chatid, "default-user", "the target changes only with /wecom-aibot connect");
	assert.equal(
		notices.filter((line) => /接入配置已改变/.test(line)).length,
		0,
		"the save already said it waits; later reads do not repeat it",
	);
});

test("config set --scope session notificationScope applies to the running session without reconnecting", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	const registration = ws;
	await command("config set --scope session notificationScope=all-runs", ctx);
	const sessionFile = layerFile({ session: sessionId });
	assert.equal(
		JSON.parse(await readFile(sessionFile, "utf8")).notificationScope,
		"all-runs",
		"the session keeps the switch",
	);
	assert.equal(
		JSON.parse(await readFile(CONFIG_FILE, "utf8")).notificationScope,
		undefined,
		"the global file is untouched",
	);
	assert.equal(ws, registration, "a setting change never replaces the registration");
	assert.match(
		notices.at(-1)!,
		/已保存 session 覆盖：notificationScope：wecom-tasks（内置默认值） → all-runs（session）[\s\S]*通知设置已热更新/,
	);
	ws.sent.length = 0;
	idle = false;
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "AFTER-NOTIFY-ON" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1, "the switch applies to the running session");
	assert.match(pushes[0].body.markdown.content, /AFTER-NOTIFY-ON/);
	await command("config unset --scope session notificationScope", ctx);
	assert.deepEqual(JSON.parse(await readFile(sessionFile, "utf8")), {}, "unset keeps the session's own (empty) file");
	ws.sent.length = 0;
	idle = false;
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "AFTER-NOTIFY-OFF" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("a long task closes the status animation and later sends exactly one final notification", async () => {
	inbound("long-task");
	await drain();
	clock.tick(590_000);
	const closedStream = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
	assert.equal(closedStream.body.stream.finish, true);
	assert.match(closedStream.body.stream.content, /请等待会话通知/);
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "FINAL-LONG-RESULT" }] },
	});
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
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "汉字🙂".repeat(4000) }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	const content = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1).body.stream.content;
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
	assert.equal((status.body.stream.content.match(/已中止/g) ?? []).length, 1);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("the pi bridge also checks the allowlist before accepting a task", async () => {
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		allowedUserIds: ["allowed-user"],
	});
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	inbound("blocked");
	ws.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: "blocked-enter" },
		body: { from: { userid: "test-user" }, event: { eventtype: "enter_chat" } },
	});
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
	assert.equal(
		ws.sent.some((frame) => JSON.stringify(frame.body).includes("NEW-SESSION-ONLY")),
		false,
	);
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
		chatid: "test-user",
		session_id: "pi-session-1",
		content: "实际结果",
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
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-a",
			provider: "test-provider",
			content: [{ type: "text", text: "ORIGINAL-ANSWER" }],
		},
	});
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
	await emit("message_end", {
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "PRIVATE-THINKING" },
				{ type: "text", text: "第一段\n\n第二段\n\n第三段\n\n第四段" },
				{ type: "toolCall", name: "bash", arguments: { command: "PRIVATE-TOOL" } },
			],
		},
	});
	await emit("message_end", {
		message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE-TOOL-RESULT" }] },
	});
	const pending = sendNotification({ chatid: "test-user", tail_paragraphs: 2 });
	const frame = ws.sent.at(-1);
	assert.equal(frame.cmd, "aibot_send_msg");
	assert.match(frame.body.markdown.content, /第三段\n\n第四段$/);
	assert.doesNotMatch(frame.body.markdown.content, /第一段|第二段|PRIVATE-/);
	ws.acknowledge(frame);
	await pending;
});

test("omitting content defaults to the last three paragraphs and the current session ID", async () => {
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "第一段\n\n第二段\n\n第三段\n\n第四段" }] },
	});
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
		chatid: "test-user",
		after_settle: true,
		tail_paragraphs: 2,
	});
	assert.equal(scheduled.details.status, "queued");
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
	inbound("next-after-notification");
	await drain();
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-b",
			provider: "another-provider",
			content: [{ type: "text", text: "开头\n\n最终结果\n\n验证通过" }],
		},
	});
	idle = true;
	let settled = false;
	const settlement = emit("agent_settled", { aborted: false }).then(() => {
		settled = true;
	});
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
	ws.onSend = (frame) => {
		if (["aibot_send_msg", "aibot_respond_msg"].includes(frame.cmd)) ws.acknowledge(frame);
	};
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
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-a",
			provider: "test-provider",
			content: [],
			stopReason: "error",
			errorMessage: "429: rate limit exceeded",
		},
	});
	ws.onSend = (frame) => {
		if (["aibot_send_msg", "aibot_respond_msg"].includes(frame.cmd)) ws.acknowledge(frame);
	};
	idle = true;
	await emit("agent_settled", { aborted: false });
	clock.tick(1_000);
	const status = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1).body.stream.content;
	assert.equal(status, "🆔 session: pi-session-1  \n本轮已结束");
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	const content = pushes[0].body.markdown.content;
	assertSource(content);
	assert.ok(content.startsWith(`🔔 ${basename(sandbox)} · 会话通知  \n`));
	assert.match(content, /错误信息：429: rate limit exceeded$/);
	assert.doesNotMatch(content, /EARLIER-PROGRESS|任务完成/);
});

test("an explicit session ID cannot mislabel another session's output", async () => {
	const rejected = assert.rejects(
		sendNotification({
			chatid: "test-user",
			session_id: "another-session",
			content: "result",
		}),
		/session_id/,
	);
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
	await drain();
	ws.sent.length = 0;
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
		chattype: "group",
		chatid: "test-group",
		text: { content: taskText("帮我检查项目") },
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
	assert.match(reply.body.stream.content, /\n\n检查完成$/);
	assertSource(reply.body.stream.content);
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length,
		0,
		"the result replaces the reply to the asker",
	);
});

for (const reconnectEarly of [false, true])
	test(`a known-unsent completion survives a closing socket (${reconnectEarly ? "reconnect before result" : "result before reconnect"})`, async () => {
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
	const second = emit("agent_settled", { aborted: false }).then(() => {
		secondDone = true;
	});
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
	assert.equal(pushes.length, 1, "the newer reply replaces its own status message");
	assert.match(pushes[0].body.markdown.content, /OLDER-COMPLETION/);
	const reply = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
	assert.match(reply.body.stream.content, /NEWER-REPLY/);
	ws.acknowledge(pushes[0]);
	await drain();
	await settled;
	await emit("agent_settled", { aborted: false });
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length,
		1,
		"the merged reply is not pushed twice",
	);
});

test("an offline completion notification retains its snapshot until reconnect", async () => {
	idle = false;
	await sendNotification({ chatid: "test-user", after_settle: true });
	ws.close();
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-a",
			provider: "test-provider",
			content: [{ type: "text", text: "ORIGINAL-RESULT" }],
		},
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	ctx.model = { ...ctx.model!, ...modelB };
	ctx.cwd = join(sandbox, "UNRELATED-PROJECT");
	await emit("message_end", {
		message: {
			role: "assistant",
			model: "model-b",
			provider: "another-provider",
			content: [{ type: "text", text: "UNRELATED-LOCAL-RESULT" }],
		},
	});
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
	await drain();
	ws.sent.length = 0;
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ANOTHER-SESSION" }] } });
	idle = true;
	await emit("agent_settled", { aborted: false });
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("changing branches cannot substitute another branch's reply into a notification", async () => {
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL-BRANCH" }] } });
	idle = false;
	await sendNotification({ chatid: "test-user", after_settle: true });
	sessionEntries = [
		{
			type: "message",
			id: "other-branch",
			message: { role: "assistant", content: [{ type: "text", text: "OTHER-BRANCH" }] },
		},
	];
	idle = true;
	await emit("agent_settled", { aborted: false });
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
});

test("notifications use the configured target without changing an explicit target's chat type", async () => {
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "configured-group",
		defaultChatType: 2,
	});
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
	writeLayer("global", { botId: "test-bot", secret: "test-secret", defaultChatId: "test-user", defaultChatType: 1 });
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

test("every help form names the actual config path where it belongs without executing commands or clearing queued notifications", async (t) => {
	const notices: { message: string; type: string }[] = [];
	t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
	t.mock.method(ctx.ui, "confirm", async () => assert.fail("help must not request confirmation"));
	const saved = await readFile(CONFIG_FILE, "utf8");
	const frameCount = ws.sent.length;
	idle = false;
	await sendNotification({ chatid: "test-user", content: "PRESERVED-NOTIFICATION", after_settle: true });
	const variants = [
		"--help",
		"config --help",
		"config set --scope session screenshotTheme=light --help",
		"connect --help",
		"reset --help",
		"test --help",
		"test your-userid --chat-type 1 --help",
		"config whoami --scope global --help",
	];
	// -h is no help option: it is refused like any unknown option, before anything runs.
	const refused = ["-h", "disconnect -h", "config whoami --wait 180 -h", "config edit --scope global -h"];
	for (const args of [...variants, ...refused]) await command(args, ctx);
	assert.equal(notices.length, variants.length + refused.length);
	const helps = notices.slice(0, variants.length).map((notice) => notice.message);
	for (const [index, help] of helps.entries()) {
		if (["--help", "config --help", "reset --help"].includes(variants[index]))
			assert.ok(help.includes(CONFIG_FILE), "help must use this pi's resolved configuration path");
		assert.doesNotMatch(help, /test-secret/);
	}
	assert.match(helps[1], /^config — /, "a topic help is scoped to that command");
	assert.equal(helps[2], helps[1], "--help never runs the set it is written after");
	await assert.rejects(readFile(layerFile({ session: sessionId })), { code: "ENOENT" });
	assert.match(helps[1], /defaultChatId/);
	assert.match(helps[1], /defaultChatType/);
	assert.match(helps[5], /chatid {2}单聊填企微 userid/);
	for (const [index, notice] of notices.slice(variants.length).entries()) {
		assert.equal(notice.type, "warning", refused[index]);
		assert.match(notice.message, /未知选项 -h/, refused[index]);
	}
	assert.equal(helps[7], helps[1], "--help after config whoami never starts an identification");
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
	assert.match(notices[0], /\/wecom-aibot config/);
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

test("subcommand help is scoped and identical for --help and a leading --help; -h shows none", async (t) => {
	const notices: { message: string; type: string }[] = [];
	t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
	await command("connect --help", ctx);
	await command("--help connect", ctx);
	await command("connect -h", ctx);
	assert.equal(notices[0].message, notices[1].message);
	assert.equal(notices[2].type, "warning");
	assert.match(notices[2].message, /^未知选项 -h/);
	assert.match(notices[0].message, /用法：\/wecom-aibot connect$/m);
	assert.match(notices[0].message, /每个 session.*手动.*\/wecom-aibot connect/);
	assert.doesNotMatch(notices[0].message, /用法：\/wecom-aibot config/);
});

test("actions written as options, unknown options and extra positional arguments fail before side effects", async (t) => {
	const notices: { message: string; type: string }[] = [];
	t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
	t.mock.method(ctx.ui, "confirm", async () => assert.fail("invalid arguments must not request confirmation"));
	const saved = await readFile(CONFIG_FILE, "utf8");
	const frameCount = ws.sent.length;
	const invalid = [
		"--connect",
		"--disconnect",
		"connect --unknown",
		"disconnect --unknown",
		"reset extra",
		"disconnect extra",
		"connect help",
		"--chatid user",
		"--whoami",
		"setup",
		"setup --bot-id a --secret b",
		"notify on",
		"config set screenshotTheme=light",
		"config set --scope session",
		"config set --scope session screenshotTheme=sepia",
		"config set --scope global secret=leaked",
		"config unset screenshotTheme",
		"config set --scope session --mode text",
		"config set --scope session defaultChatId='x'",
		'test "user"',
		"test user 2",
		"test --chat-type 3 user",
		"test --chat-type 2",
		"whoami",
		"config whoami 120",
		"config whoami --wait 5",
		"config whoami --wait=abc",
		"config show --wait 120",
		"connect --wait 120",
	];
	for (const args of invalid) await command(args, ctx);
	assert.equal(notices.length, invalid.length);
	assert.ok(notices.every((notice) => notice.type === "warning"));
	assert.match(notices[0].message, /connect 是子命令，不带 --/);
	assert.match(notices[0].message, /\/wecom-aibot connect/);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), saved);
	await assert.rejects(readFile(layerFile({ session: sessionId })), { code: "ENOENT" });
	assert.equal(ws.readyState, 1);
	assert.equal(FakeWebSocket.instances.length, 1);
	assert.equal(ws.sent.length, frameCount);
});

test("an immediate excerpt only reads the current run, never the previous run's answer", async () => {
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "PREVIOUS-RUN" }] } });
	await emit("agent_start");
	await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "把结果发到企微" }] } });
	// pi persists the assistant message before running its tool calls; this one has no text.
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "toolCall", name: "wecom_send", arguments: {} }] },
	});
	await assert.rejects(sendNotification({ chatid: "test-user" }), /本轮还没有可摘录的文本回复/);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
	await emit("message_end", {
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "THIS-RUN" },
				{ type: "toolCall", name: "wecom_send", arguments: {} },
			],
		},
	});
	await sendNotification({ chatid: "test-user" });
	const push = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assertSource(push.body.markdown.content);
	assert.match(push.body.markdown.content, /\n\nTHIS-RUN$/);
});

test("config merges into the file as it is now, keeps the connection, and connect adopts the result", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	// A hand edit (or another window) adds an allowlist after this pi loaded its configuration.
	const edited = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8")), allowedUserIds: ["boss"] };
	await writeFile(CONFIG_FILE, JSON.stringify(edited));
	await command("config set --scope global defaultChatId=boss", ctx);
	const saved = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
	assert.deepEqual(saved.allowedUserIds, ["boss"]);
	assert.deepEqual(
		[saved.botId, saved.secret, saved.defaultChatId, saved.defaultChatType],
		["test-bot", "test-secret", "boss", 1],
	);
	// Saving never disconnects: the registration keeps its old target and allowlist until connect.
	assert.equal(ws.readyState, 1);
	assert.match(notices.at(-1)!, /defaultChatId：default-user（global） → boss（global）[\s\S]*待重新接入/);
	await command("status", ctx);
	assert.match(
		notices.at(-1)!,
		/^🔌 企业微信智能机器人：已接入\n待重新接入：[^\n]*\n\n {2}机器人 {4}[^\n]+\n {2}默认推送 {2}default-user（单聊）\n/,
	);
	const sockets = FakeWebSocket.instances.length;
	Object.assign(ctx, { hasUI: true });
	await command("connect", ctx);
	assert.equal(FakeWebSocket.instances.length, sockets + 1);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	inbound("not-on-the-allowlist");
	await drain();
	assert.equal(sent.length, 0);
	await command("config show", ctx);
	assert.match(notices.at(-1)!, /当前接入与以上配置一致/);
});

test("connect after a reset in another pi reports the missing configuration instead of restoring the secret", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	clearConfig();
	await command("connect", ctx);
	assert.match(notices.at(-1)!, /尚未配置/);
	await assert.rejects(readFile(CONFIG_FILE), { code: "ENOENT" });
});

for (const [kind, broken] of [
	["invalid JSON", '{ "botId": '],
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

test("reset reports deletion failure and stops this pi without claiming the configuration was deleted", async (t) => {
	if (process.platform === "win32" || process.getuid?.() === 0) {
		t.skip("uses POSIX directory permissions");
		return;
	}
	const notices: string[] = [];
	Object.assign(ctx, { hasUI: true });
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	const before = await readFile(CONFIG_FILE, "utf8");
	// The configuration lives in the plugin folder: that is the directory whose write access governs deletion.
	await chmod(dirname(CONFIG_FILE), 0o500);
	try {
		await command("reset", ctx);
		assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
		assert.equal(notices.includes("已删除企业微信配置"), false);
		assert.match(notices.at(-1)!, /已停止.*配置.*删除失败/);
		assert.equal(ws.readyState, 3);
	} finally {
		await chmod(dirname(CONFIG_FILE), 0o700);
	}
});

for (const change of ["bot while waiting", "bot during confirmation", "Secret during confirmation"]) {
	test(`config whoami cannot save an old identity after changing the ${change}`, async (t) => {
		const replacement = {
			botId: change.startsWith("Secret") ? "test-bot" : "replacement-bot",
			secret: "replacement-secret",
			enabled: true,
		};
		const replace = () => writeFile(CONFIG_FILE, JSON.stringify(replacement));
		const notices = identityDialogs(t, async () => {
			if (change.includes("confirmation")) await replace();
			return true;
		});
		const pending = command("config whoami --scope global", ctx);
		await drain();
		if (change.includes("waiting")) await replace();
		plain(notices.codes[0]);
		await pending;
		assert.deepEqual(JSON.parse(await readFile(CONFIG_FILE, "utf8")), replacement);
		assert.ok(
			notices.some((line) => /配置已改变/.test(line)),
			notices.join("\n"),
		);
	});
}

test("config whoami shows the code, saves the identified chat into the chosen layer, and leaves other messages alone", async (t) => {
	const notices = identityDialogs(t);
	const pending = command("config whoami --scope session", ctx);
	await drain();
	assert.equal(notices.codes.length, 1);
	inbound("during-the-wait");
	await drain();
	assert.ok(sent.some((content) => JSON.stringify(content).includes("during-the-wait")));
	plain(`@robot ${notices.codes[0]}`, { chattype: "group", chatid: "group-chat" });
	await pending;
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")), {
		defaultChatId: "group-chat",
		defaultChatType: 2,
	});
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).defaultChatId, "default-user", "global unchanged");
	assert.ok(notices.some((line) => /已保存 session 覆盖/.test(line)));
});

test("config whoami without a scope only reports the chat and the command that would save it", async (t) => {
	const notices = identityDialogs(t, async () => assert.fail("nothing to confirm without a scope"));
	const before = await readFile(CONFIG_FILE, "utf8");
	const pending = command("config whoami", ctx);
	await drain();
	plain(notices.codes[0], { from: { userid: "colleague" } });
	await pending;
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
	const report = notices.at(-1)!;
	assert.match(report, /^已识别单聊：chatid=colleague　chat_type=1　userid=colleague$/m);
	assert.match(
		report,
		/设为默认推送目标：\/wecom-aibot config set --scope <global\|session> defaultChatId=colleague defaultChatType=1/,
	);
	assert.match(report, /未配置 allowedUserIds/);
});

test("a reconnect during the confirmation keeps a chat identified with the same bot", async (t) => {
	const notices = identityDialogs(t, async () => {
		await command("disconnect", ctx);
		await command("connect", ctx);
		return true;
	});
	const pending = command("config whoami --scope global", ctx);
	await drain();
	plain(notices.codes[0], { from: { userid: "new-user" } });
	await pending;
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).defaultChatId, "new-user");
	assert.ok(
		notices.some((line) => /已保存全局配置/.test(line)),
		notices.join("\n"),
	);
});

test("config whoami validates its wait and its preconditions before waiting for any message", async (t) => {
	const notices: { message: string; type: string }[] = [];
	t.mock.method(ctx.ui, "notify", (message: string, type: string) => notices.push({ message, type }));
	const frameCount = ws.sent.length;
	for (const args of [
		"config whoami --wait 5",
		"config whoami --wait 601",
		"config whoami --wait=1.5",
		"config whoami --wait abc",
	])
		await command(args, ctx);
	assert.equal(notices.length, 4);
	assert.ok(notices.every((notice) => notice.type === "warning" && /10～600/.test(notice.message)));
	await command("disconnect", ctx);
	clearConfig();
	await emit("session_start");
	await command("config whoami", ctx);
	assert.match(notices.at(-1)!.message, /\/wecom-aibot config edit --scope global/);
	assert.equal(ws.sent.length, frameCount, "none of these may send or reply upstream");
});

test("config help explains whoami's code, the group mention and the wait", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	await command("config whoami --help", ctx);
	assert.match(notices[0], /^ {2}whoami \[--scope <global\|session>\]/m);
	assert.match(notices[0], /6 位验证码/);
	assert.match(notices[0], /群聊需 @机器人/);
	assert.match(notices[0], /默认 300/);
});

test("config edit guides a first configuration, then edits one item of the chosen layer", async (t) => {
	await command("disconnect", ctx);
	clearConfig();
	await emit("session_start");
	const notices: string[] = [];
	const menus: { title: string; options: string[] }[] = [];
	let answers: (string | undefined)[] = ["new-bot", "new-secret", "group_chat"];
	let choices: RegExp[] = [/手动填写群聊/];
	Object.assign(ctx, { hasUI: true });
	Object.assign(ctx.ui, {
		async input() {
			return answers.shift();
		},
		async select(title: string, options: string[]) {
			menus.push({ title, options });
			const wanted = choices.shift();
			return wanted && options.find((option) => wanted.test(option));
		},
	});
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	const sockets = FakeWebSocket.instances.length;
	await command("config edit --scope global", ctx);
	assert.deepEqual(JSON.parse(await readFile(CONFIG_FILE, "utf8")), {
		botId: "new-bot",
		secret: "new-secret",
		defaultChatId: "group_chat",
		defaultChatType: 2,
	});
	assert.match(notices.at(-1)!, /已保存全局配置[\s\S]*配置不等于接入/);
	assert.doesNotMatch(notices.at(-1)!, /new-secret/, "the Secret is never shown");
	assert.equal(FakeWebSocket.instances.length, sockets, "a saved configuration never connects by itself");
	// With credentials in place, edit opens a menu and changes the one item chosen.
	choices = [/^截图主题：/, /^light$/];
	await command("config edit --scope global", ctx);
	assert.equal(menus.at(-2)?.title, "编辑全局配置");
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).screenshotTheme, "light");
	choices = [/^通知方式：/, /^screenshot：/];
	await command("config edit --scope session", ctx);
	assert.equal(menus.at(-2)?.title, "编辑当前 session 的覆盖项");
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")), {
		notificationMode: "screenshot",
	});
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).notificationMode, undefined);
	// The session override can be dropped from the same menu.
	choices = [/^通知方式：/, /^取消覆盖/];
	await command("config edit --scope session", ctx);
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")), {});
	// Esc, an empty Secret and a pasted ID with quotes cancel before anything is written.
	const before = await readFile(CONFIG_FILE, "utf8");
	choices = [];
	await command("config edit --scope global", ctx);
	choices = [/^机器人凭据：/];
	answers = ["", ""];
	await command("config edit --scope global", ctx);
	choices = [/^默认推送目标：/, /手动填写单聊/];
	answers = ['"user_one"'];
	await command("config edit --scope global", ctx);
	assert.match(notices.at(-2)!, /含引号或空格/);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
	assert.equal(notices.filter((notice) => /已取消，配置未修改/.test(notice)).length, 3);
	// Without an interactive UI there is nothing to edit with.
	Object.assign(ctx, { hasUI: false });
	await command("config edit --scope global", ctx);
	assert.match(notices.at(-1)!, /需要交互界面.*config set --scope global/);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
});

test("config show and config <layer> show say where each value comes from, never the Secret", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	await command("config set --scope session screenshotTheme=light", ctx);
	await command("config show", ctx);
	const merged = notices.at(-1)!;
	assert.match(merged, /screenshotTheme +light（session）/);
	assert.match(merged, /notificationMode +text（内置默认值）/);
	assert.match(merged, /defaultChatId +default-user（global）/);
	assert.match(merged, /secret +已配置（global）/);
	assert.match(merged, /当前接入与以上配置一致/);
	await command("config show --scope session", ctx);
	assert.match(notices.at(-1)!, /当前 session 的覆盖项：\n {2}screenshotTheme {2}light\n文件：/);
	await command("config show --scope global", ctx);
	assert.match(notices.at(-1)!, /^全局配置/);
	for (const text of notices) assert.doesNotMatch(text, /test-secret/);
	// Nothing configured anywhere: the next step is named instead of a table of blanks alone.
	await command("disconnect", ctx);
	clearConfig();
	await command("config show", ctx);
	assert.match(notices.at(-1)!, /未配置：运行 \/wecom-aibot config edit --scope global/);
});

test("config without an action lists the subcommands and runs only the one chosen", async (t) => {
	const notices: string[] = [];
	const menus: { title: string; options: string[] }[] = [];
	const editor: string[] = [];
	let choice: RegExp | undefined;
	Object.assign(ctx, { hasUI: true });
	Object.assign(ctx.ui, {
		async select(title: string, options: string[]) {
			menus.push({ title, options });
			return choice && options.find((option) => choice?.test(option));
		},
		setEditorText: (text: string) => editor.push(text),
	});
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	const before = await readFile(CONFIG_FILE, "utf8");
	// Esc: nothing runs and nothing is said.
	await command("config", ctx);
	assert.equal(menus.at(-1)?.options.length, 12);
	assert.equal(notices.length, 0);
	// A form without values runs at once.
	choice = /^show {2,}/;
	await command("config", ctx);
	assert.match(notices.at(-1)!, /^当前 session 的企业微信配置（合并结果）/);
	// One that needs values goes to the editor to be completed; a scope lists only its own.
	choice = /^set --scope session /;
	await command("config --scope session", ctx);
	assert.deepEqual(
		menus.at(-1)?.options.map((option) => option.split(/ {2,}/)[0]),
		[
			"show --scope session",
			"edit --scope session",
			"set --scope session 字段=值 …",
			"unset --scope session 字段 …",
			"whoami --scope session",
		],
	);
	assert.equal(
		new Set(menus.at(-1)?.options.map((option) => visibleWidth(/^(\S.*?) {2,}\S/.exec(option)?.[0] ?? ""))).size,
		1,
		"the descriptions line up",
	);
	assert.deepEqual(editor, ["/wecom-aibot config set --scope session "]);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before, "choosing never writes by itself");
	// Without an interactive UI the subcommands are listed instead.
	Object.assign(ctx, { hasUI: false });
	await command("config --scope global", ctx);
	assert.match(notices.at(-1)!, /^\/wecom-aibot config 需要写明动作，例如 \/wecom-aibot config show --scope global/);
	assert.match(notices.at(-1)!, /edit --scope global/);
	assert.doesNotMatch(notices.at(-1)!, /session/);
});

test("a fork takes over its parent's overrides at session start", async (t) => {
	const parentId = "parent-session";
	const parentFile = join(sandbox, "parent.jsonl");
	await writeFile(parentFile, `${JSON.stringify({ type: "session", id: parentId, cwd: sandbox })}\n`);
	writeLayer({ session: parentId }, { defaultChatId: "private-user", defaultChatType: 1 });
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	sessionId = "forked-session";
	sessionHeader = { parentSession: parentFile };
	await emit("session_start");
	assert.match(notices.at(-1)!, /已从父会话继承企业微信覆盖项：defaultChatId、defaultChatType/);
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")), {
		defaultChatId: "private-user",
		defaultChatType: 1,
	});
	await command("config show", ctx);
	assert.match(notices.at(-1)!, /defaultChatId +private-user（session）/);
});

test("without an interactive UI, connect never replaces a registration that still has work", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	t.mock.method(ctx.ui, "confirm", async () => assert.fail("no dialog without an interactive UI"));
	idle = false;
	inbound("pending-task");
	await drain();
	await command("config set --scope global defaultChatId=new-user", ctx);
	const registration = ws;
	await command("connect", ctx);
	assert.match(notices.at(-1)!, /还有 .*排队任务.*没有交互界面无法确认，未重新接入/);
	assert.equal(ws, registration);
	assert.equal(ws.readyState, 1);
	assert.equal(FakeWebSocket.instances.length, 1);
	await command("disconnect", ctx);
	await command("connect", ctx);
	assert.equal(FakeWebSocket.instances.length, 2, "after disconnect nothing is pending and connect proceeds");
});

test("argument completion through pi offers subcommands, options and config's grammar", () => {
	const values = (prefix: string) => complete(prefix)?.map((item) => item.value) ?? null;
	assert.deepEqual(values("co"), ["config ", "connect "]);
	assert.deepEqual(values("se"), null, "setup is gone");
	assert.deepEqual(values("--h"), ["--help"]);
	assert.deepEqual(values("config set --scope session screenshotTheme="), [
		"config set --scope session screenshotTheme=system ",
		"config set --scope session screenshotTheme=dark ",
		"config set --scope session screenshotTheme=light ",
	]);
	assert.deepEqual(values("test x --"), ["test x --chat-type ", "test x --help"]);
	assert.deepEqual(values("config whoami --w"), ["config whoami --wait "]);
	assert.deepEqual(values("config edit --scope "), ["config edit --scope global ", "config edit --scope session "]);
	assert.deepEqual(values("config show "), ["config show --scope ", "config show --help"]);
	// A bare action still offers --help, so the list is complete at every position.
	assert.deepEqual(values("connect -"), ["connect --help"]);
	assert.deepEqual(values("status "), ["status --help"]);
	assert.deepEqual(values("test -"), ["test --chat-type ", "test --help"]);
	for (const done of ["config", "config whoami --wait ", "--help", "connect x", "connect --help "]) {
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
	assert.match(notices.at(-1)!.message, /^🛑 企业微信智能机器人：已停止（subscribe failed: 40001/);
	await command("connect", ctx);
	assert.equal(FakeWebSocket.instances.length, 7, "/wecom-aibot connect subscribes again");
});

test("a file from WeCom is saved in the project with a .gitignore that keeps it out of commits", async (t) => {
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(Buffer.from("%PDF-1.4 test"), { headers: { "content-type": "application/pdf" } }),
	);
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
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		notificationMode: "screenshot",
	});
	const fixture = installTuiFixture(ctx);
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	ws.sent.length = 0;
	return fixture;
}

test("connect sends one quotable image entry without drawing notification prose into the screenshot", async () => {
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		notificationMode: "screenshot",
	});
	const fixture = installTuiFixture(ctx);
	fixture.state.lines = ["CURRENT-SCREEN"];
	await emit("session_start");
	let screen: any;
	let header: any;
	rasterise = async (snapshot, options) => {
		screen = snapshot;
		header = options.header;
		return TINY_PNG;
	};
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].body.msgtype, "image");
	assert.equal(header.badge, "会话已接入");
	assert.equal(header.session, "pi-session-1");
	assert.match(screen.lines.join("\n"), /CURRENT-SCREEN/);
	assert.doesNotMatch(screen.lines.join("\n"), /引用本条消息/);
	const chunks = ws.sent.filter((frame) => frame.cmd === "aibot_upload_media_chunk");
	const uploaded = Buffer.concat(chunks.map((frame) => Buffer.from(frame.body.base64_data, "base64")));
	assert.equal(inspectPng(uploaded)?.session, "pi-session-1");
	await command("connect", ctx);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
});

test("changing notificationMode needs no connect: active and queued work survive, unfinished results use it", async () => {
	const fixture = installTuiFixture(ctx);
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	ws.sent.length = 0;
	inbound("first-mode-task");
	inbound("second-mode-task");
	await drain();
	assert.equal(sent.length, 1);
	await sendNotification({ content: "SCHEDULED-FALLBACK", after_settle: true });
	const current = ws;
	await command("config set --scope session notificationMode=screenshot", ctx);
	assert.equal(ws, current);
	assert.equal(FakeWebSocket.instances.length, 2, "mode changes must not create a new registration");
	fixture.state.lines = ["FIRST-MODE-RESULT"];
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "FIRST-TEXT-FALLBACK" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(sent.length, 2, "queued task survives the mode change");
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
	assert.equal(ws.sent.find((frame) => frame.cmd === "aibot_send_msg").body.msgtype, "image");
	await command("config unset --scope session notificationMode", ctx);
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "SECOND-TEXT-RESULT" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	const last = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1)!;
	assert.match(last.body.stream.content, /SECOND-TEXT-RESULT/);
});

test("a prepared offline image remains frozen when connect reloads text mode", async () => {
	const fixture = await imageModeStart();
	let captures = 0;
	const render = rasterise;
	rasterise = async (screen, options) => {
		captures++;
		return render(screen, options);
	};
	idle = false;
	await sendNotification({ content: "FROZEN-FALLBACK", after_settle: true });
	ws.close();
	fixture.state.lines = ["ORIGINAL-SNAPSHOT"];
	idle = true;
	await emit("agent_settled", { aborted: false });
	assert.equal(captures, 1);
	fixture.state.lines = ["UNRELATED-LOCAL-SCREEN"];
	const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
	await writeFile(CONFIG_FILE, JSON.stringify({ ...cfg, notificationMode: "text" }));
	await command("connect", ctx);
	clock.tick(1000);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].body.msgtype, "image");
	assert.equal(captures, 1, "frozen notifications must never recapture a newer screen");
});

test("an automatic result completed offline freezes its image before later local output or mode reload", async () => {
	const fixture = await imageModeStart();
	const captured: string[][] = [];
	const render = rasterise;
	rasterise = async (screen, options) => {
		captured.push([...screen.lines]);
		return render(screen, options);
	};
	inbound("offline-image-task");
	await drain();
	ws.close();
	fixture.state.lines = ["ORIGINAL-OFFLINE-RESULT"];
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "ORIGINAL-FALLBACK" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	assert.equal(captured.length, 1, "automatic results freeze even when their final status cannot yet be handed over");
	fixture.state.lines = ["UNRELATED-LOCAL-OUTPUT"];
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "LOCAL-FALLBACK" }] } });
	await emit("agent_settled", { aborted: false });
	const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
	await writeFile(CONFIG_FILE, JSON.stringify({ ...cfg, notificationMode: "text" }));
	await command("connect", ctx);
	clock.tick(1000);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].body.msgtype, "image");
	assert.equal(captured.length, 1);
	assert.match(captured[0].join("\n"), /ORIGINAL-OFFLINE-RESULT/);
	assert.doesNotMatch(captured[0].join("\n"), /UNRELATED/);
});

test("image mode leaves status, help and session-list messages as text", async () => {
	await imageModeStart();
	for (const content of ["/wecom-aibot --help", "/wecom-aibot sessions"]) {
		ws.receive({
			cmd: "aibot_msg_callback",
			headers: { req_id: content },
			body: {
				msgid: content,
				from: { userid: "test-user" },
				chattype: "single",
				msgtype: "text",
				text: { content },
			},
		});
	}
	const replies = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	assert.equal(replies.length, 2);
	assert.ok(replies.every((frame) => frame.body.msgtype === "stream" && frame.body.stream.finish === true));
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"),
		false,
	);
});

test("screen fails with a text error instead of a fabricated image or notification body", async () => {
	await imageModeStart();
	rasterise = async () => {
		throw new Error("rasteriser unavailable");
	};
	ws.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: "screen-error" },
		body: {
			msgid: "screen-error",
			from: { userid: "test-user" },
			chattype: "single",
			msgtype: "text",
			text: { content: `/wecom-aibot --sessionid ${sessionId} screen` },
		},
	});
	await drain();
	const reply = ws.sent.find((frame) => frame.cmd === "aibot_respond_msg");
	assert.match(reply.body.stream.content, /截图失败：.*rasteriser unavailable/);
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_send_msg"),
		false,
	);
});

test("the WeCom list and target-only query ask this pi whether it is busy right now", async () => {
	let asked = 0;
	const state = async (content: string) => {
		const reqId = `sessions-${++asked}`;
		ws.receive({
			cmd: "aibot_msg_callback",
			headers: { req_id: reqId },
			body: {
				msgid: reqId,
				from: { userid: "test-user" },
				chattype: "single",
				msgtype: "text",
				text: { content },
			},
		});
		await drain();
		const reply = ws.sent.find((frame) => frame.cmd === "aibot_respond_msg" && frame.headers.req_id === reqId);
		return /· (执行中|空闲|状态未知)\n/.exec(reply?.body.stream.content ?? "")?.[1];
	};
	const commands = ["/wecom-aibot sessions", `/wecom-aibot --sessionid ${sessionId}`];
	for (const content of commands) assert.equal(await state(content), "空闲");
	idle = false;
	for (const content of commands) assert.equal(await state(content), "执行中", "a run typed in pi itself");
	assert.equal(sent.length, 0, "neither query starts a task");
	inbound("queued-behind-local-run");
	idle = true;
	for (const content of commands)
		assert.equal(await state(content), "执行中", "pi is idle, but a WeCom task is still on its way");
});

test("an explicit image notification uses its content as the text fallback when capture fails", async () => {
	await imageModeStart();
	rasterise = async () => {
		throw new Error("cannot capture");
	};
	await sendNotification({ content: "EXPLICIT-FALLBACK" });
	const push = ws.sent.find((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(push.body.msgtype, "markdown");
	assert.match(push.body.markdown.content, /EXPLICIT-FALLBACK/);
	assert.match(push.body.markdown.content, /图片发送失败：.*cannot capture.*已改发文字/);
});

test("automatic reconnect does not send a scheduled completion before the run settles", async () => {
	idle = false;
	await sendNotification({ content: "ONLY-AFTER-SETTLE", after_settle: true });
	ws.close();
	clock.tick(1000);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_send_msg"),
		false,
	);
	idle = true;
	await emit("agent_settled", { aborted: false });
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.match(pushes[0].body.markdown.content, /ONLY-AFTER-SETTLE/);
});

test("image mode keeps an automatic reconnect from capturing an unfinished completion", async () => {
	const fixture = await imageModeStart();
	let captures = 0;
	const render = rasterise;
	rasterise = async (screen, options) => {
		captures++;
		return render(screen, options);
	};
	idle = false;
	await sendNotification({ content: "AFTER-SETTLE-FALLBACK", after_settle: true });
	ws.close();
	clock.tick(1000);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	assert.equal(captures, 0);
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_send_msg"),
		false,
	);
	fixture.state.lines = ["FINAL-AFTER-RECONNECT"];
	idle = true;
	await emit("agent_settled", { aborted: false });
	assert.equal(captures, 1);
	assert.equal(ws.sent.find((frame) => frame.cmd === "aibot_send_msg").body.msgtype, "image");
});

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

test("image mode sends explicit content as the current screenshot, not a rendered body", async () => {
	await imageModeStart();
	const screens: string[][] = [];
	rasterise = async (screen) => {
		screens.push([...screen.lines]);
		return Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
	};
	await sendNotification({ chatid: "test-user", content: "EXPLICIT-CONTENT" });
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.at(-1)?.body.msgtype, "image");
	assert.equal(pushes.at(-1)?.body.markdown, undefined);
	assert.equal(screens.length, 1);
	assert.doesNotMatch(screens[0].join("\n"), /EXPLICIT-CONTENT/);
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"),
		true,
	);
});

test("image mode falls back to the Markdown answer when rendering is unavailable", async () => {
	rasterise = async () => {
		throw new Error("no rasteriser");
	};
	await imageModeStart();
	inbound("image-fallback-task");
	await drain();
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "FINAL-TEXT" }] } });
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const reply = ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
	assert.equal(reply.body.stream.finish, true);
	assert.match(reply.body.stream.content, /本轮已结束，结果将另行通知/);
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.match(pushes[0].body.markdown.content, /FINAL-TEXT/);
	assert.match(pushes[0].body.markdown.content, /图片发送失败：.*no rasteriser.*已改发文字/);
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"),
		false,
	);
});

test("screenshots follow pi's own theme until screenshotTheme names one, read at capture time", async (t) => {
	await imageModeStart();
	// pi shows its light theme: an unset screenshotTheme renders exactly that.
	setLiveTheme("light");
	t.after(() => setLiveTheme("dark"));
	Object.assign(ctx.ui, { theme: fixtureTheme("light") });
	const backgrounds: string[] = [];
	const render = rasterise;
	rasterise = async (screen, options) => {
		backgrounds.push(screen.background);
		return render(screen, options);
	};
	const registration = ws;
	await sendNotification({ chatid: "test-user", content: "PI" });
	await command("config set --scope session screenshotTheme=dark", ctx);
	await sendNotification({ chatid: "test-user", content: "DARK" });
	// A theme pi does not have is refused, and nothing changes.
	await command("config set --scope session screenshotTheme=sepia", ctx);
	await sendNotification({ chatid: "test-user", content: "STILL DARK" });
	assert.deepEqual(backgrounds, ["#ffffff", "#000000", "#000000"]);
	assert.equal(ws, registration);
});

test("the deployment test follows image mode and uploads the current screenshot", async () => {
	await imageModeStart();
	await command("test test-user", ctx);
	const push = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assert.equal(push.body.msgtype, "image");
	assert.equal(push.body.markdown, undefined);
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_upload_media_init"),
		true,
	);
});

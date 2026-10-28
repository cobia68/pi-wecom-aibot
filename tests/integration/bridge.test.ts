import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, afterEach, beforeEach, type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clamp } from "../../src/shared/card.ts";
import {
	CONTROL_KEYS,
	controlCardFor,
	isControlCardId,
	PI_ICON_URL,
	parseControlKey,
	sessionFingerprint,
} from "../../src/shared/control-card.ts";
import type { GatewayNotification } from "../../src/shared/notification-types.ts";
import type { ChatRef } from "../../src/shared/wecom-protocol.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";
import { LoopbackClient } from "../support/loopback-client.ts";
import { installTuiFixture } from "../support/tui-fixture.ts";

const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-bridge-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../../src/extension/index.ts");
const { writeLayer, clearConfig, layerFile, CONFIG_FILE, SESSIONS_DIR } = await import("../../src/extension/config.ts");
const { promptOptions } = await import("../../src/extension/control-view.ts");
/** The default dropdown's one option, as WeCom returns it. */
const CONTINUE = promptOptions(["继续"])[0].id;
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let handlers: Map<string, Handler[]>;
let command: (args: string, ctx: ExtensionContext) => Promise<void>;
let complete: (prefix: string) => { value: string; label: string }[] | null;
let sent: { content: any; options: any }[];
let tools: Map<string, any>;
let idle: boolean;
let ctx: ExtensionContext;
let ws: FakeWebSocket;
let initialControl: any;
/** What pi handed the gateway: a result's reply is the notification's text, the card shows the window. */
let notified: GatewayNotification[];
let clock: TestContext["mock"]["timers"];
let sessionId: string;
let sessionEntries: any[];
/** The session header pi reports; a fork names its parent here. */
let sessionHeader: { parentSession?: string } | null;
let autoAcknowledge: boolean;
/** Simulate pi refusing the prompt: no before_agent_start and no agent_settled, exactly as the SDK does it. */
let refusePrompt: boolean;
/** pi's prompt sections, kept from one run to the next as pi keeps them. */
let promptSections: Record<string, string>;
const modelA = { id: "model-a", name: "Model A", provider: "test-provider" };
const modelB = { id: "model-b", name: "Model B", provider: "another-provider" };

/**
 * Whatever pi publishes is a new copy of its session's control card: its directory, model · provider and
 * session, the control buttons; never a parent directory.
 */
function assertCard(frame: any, modelName = "Model A", provider = "test-provider"): void {
	assert.equal(frame.body.msgtype, "template_card");
	const card = frame.body.template_card;
	assert.equal(card.card_type, "button_interaction");
	assert.ok(controlCardFor(card.task_id, "pi-session-1"), card.task_id);
	assert.notEqual(card.task_id, initialControl?.body.template_card.task_id, "a new copy, at the end of the chat");
	assert.equal(card.main_title.title, clamp(`📁 ${basename(sandbox)}`, 36));
	assert.equal(card.main_title.desc, clamp(`🤖 ${modelName} · ${provider}`, 40));
	assert.match(card.sub_title_text, /^🆔 session-id: pi-session-1(；|$)/);
	assert.equal(card.horizontal_content_list.at(-1).keyname, "窗口记录");
	assert.equal(buttons(frame)[0], "refresh");
	assert.equal(JSON.stringify(card).includes(dirname(sandbox)), false, "parent directories must not appear on a card");
}

/**
 * A finished run's result: a new copy of the session's control card in its done state (green 已完成, red
 * 已中止 or 未执行), 窗口记录 naming the outcome, and the control card's buttons; never a parent directory.
 */
function assertResultCard(frame: any, note: string, label = "已完成"): void {
	assert.equal(frame.body.msgtype, "template_card");
	const card = frame.body.template_card;
	assert.ok(controlCardFor(card.task_id, "pi-session-1"), "a control card of the session");
	assert.notEqual(card.task_id, initialControl.body.template_card.task_id, "a new copy, at the end of the chat");
	assert.deepEqual(
		{ desc: card.source.desc, color: card.source.desc_color },
		{ desc: label, color: label === "已完成" ? 3 : 2 },
	);
	assert.equal(card.main_title.title, clamp(`📁 ${basename(sandbox)}`, 36));
	assert.equal(card.horizontal_content_list.at(-1).keyname, "窗口记录");
	assert.match(card.horizontal_content_list.at(-1).value, new RegExp(`^\\d\\d:\\d\\d ${note}$`));
	assert.deepEqual(buttons(frame).at(0), "refresh");
	assert.equal(JSON.stringify(card).includes(dirname(sandbox)), false, "parent directories must not appear on a card");
}

/** Result cards the bridge published to a chat: a task's result is a card there, never a reply to its message. */
function resultCards(chatId = "test-user", frames = ws.sent): any[] {
	return frames.filter(
		(frame) =>
			frame.cmd === "aibot_send_msg" &&
			frame.body.chatid === chatId &&
			isControlCardId(frame.body?.template_card?.task_id) &&
			["已完成", "已中止", "未执行"].includes(frame.body.template_card.source?.desc),
	);
}

/** Replies to the task's own message. */
function replies(frames = ws.sent): any[] {
	return frames.filter((frame) => frame.cmd === "aibot_respond_msg");
}

/** What pi published with a card: its whole answer, on the session's page. */
function bodyOf(frame: any): string {
	const published = notified.find((notification) => notification.control?.cardId === frame.body.template_card.task_id);
	assert.ok(published, "the card came with its notification");
	return published.text;
}

/**
 * What a push shows: a card's headline, excerpt, text and 窗口记录, or a Markdown body. A control card shows
 * the notice's headline only; the body it was published with (on its page, a refused card's Markdown) is
 * added from what pi handed the gateway with it.
 */
function shown(frame: any): string {
	const body = frame.body;
	if (body.msgtype === "markdown") return body.markdown.content;
	const card = body.template_card ?? {};
	const published = notified.find((notification) => notification.control?.cardId === card.task_id);
	return [
		card.main_title?.title,
		card.quote_area?.quote_text,
		card.sub_title_text,
		card.horizontal_content_list?.at(-1)?.value,
		published?.text,
	]
		.filter(Boolean)
		.join("\n");
}

/** 窗口记录 of a control card, without its time. */
function noteOf(frame: any): string {
	return frame.body.template_card.horizontal_content_list.at(-1).value.replace(/^\d\d:\d\d /, "");
}

/** Control cards that introduce the session (connect, card), not ones a notification published. */
function introductions(frames: any[]): any[] {
	return frames.filter(
		(frame) => isControlCardId(frame.body?.template_card?.task_id) && /^(已接入|已补发控制卡)$/.test(noteOf(frame)),
	);
}

/** The buttons of a pushed card: a control card's as actions (its keys also name the session). */
function buttons(frame: any): string[] {
	return frame.body.template_card.button_list.map(
		(button: { key: string }) => parseControlKey(button.key)?.action ?? button.key,
	);
}

/** Press a button on a card the bot pushed, as WeCom reports it; `selected` is the card's dropdowns. */
/**
 * A control card's button by its action: on the card, each key also names the session it was drawn for. A
 * card whose keys name none (from before version 10) keeps the bare key.
 */
function buttonKey(frame: any, key: string): string {
	const card = frame.body?.template_card;
	if (key.includes("@") || !isControlCardId(card?.task_id) || !Object.values(CONTROL_KEYS).includes(key as never))
		return key;
	const print = card.button_list?.map((button: any) => parseControlKey(button.key)?.fingerprint).find(Boolean);
	return print ? `${key}@${print}` : key;
}

function clickCard(frame: any, action: string, userid = "test-user", selected?: Record<string, string>): void {
	const key = buttonKey(frame, action);
	const id = `click-${key}-${Math.random()}`;
	ws.receive({
		cmd: "aibot_event_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid },
			chattype: frame.body.chat_type === 2 ? "group" : "single",
			...(frame.body.chat_type === 2 ? { chatid: frame.body.chatid } : {}),
			msgtype: "event",
			event: {
				eventtype: "template_card_event",
				template_card_event: {
					card_type: "button_interaction",
					event_key: key,
					task_id: frame.body.template_card.task_id,
					...(selected
						? {
								selected_items: {
									selected_item: Object.entries(selected).map(([question, option]) => ({
										question_key: question,
										option_ids: { option_id: [option] },
									})),
								},
							}
						: {}),
				},
			},
		},
	});
}

async function emit(type: string, event: any = {}, context = ctx): Promise<void> {
	if (type === "message_end") {
		sessionEntries.push({
			type: "message",
			id: `entry-${sessionEntries.length + 1}`,
			timestamp: new Date().toISOString(),
			message: event.message,
		});
	}
	for (const handler of handlers.get(type) ?? []) {
		const prompt = type === "before_agent_start" ? { systemPromptOptions: { sections: promptSections } } : {};
		await handler({ type, ...prompt, ...event }, context);
	}
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
	notified = [];
	const notify = LoopbackClient.prototype.notify;
	t.mock.method(
		LoopbackClient.prototype,
		"notify",
		function (this: LoopbackClient, chat: ChatRef, notification: GatewayNotification) {
			notified.push(notification);
			return notify.call(this, chat, notification);
		},
	);
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
	promptSections = {};
	await rm(SESSIONS_DIR, { recursive: true, force: true });
	// The machine's record of document pages is shared by every pi; each test starts without one.
	await rm(join(sandbox, "wecom-aibot", "session-doc.json"), { force: true });
	await rm(join(sandbox, "wecom-aibot", "session-doc.lock"), { force: true });
	autoAcknowledge = true;
	refusePrompt = false;
	ctx = {
		hasUI: false,
		cwd: sandbox,
		isIdle: () => idle,
		model: { ...modelA },
		modelRegistry: {
			find: (provider: string, id: string) =>
				[modelA, modelB].find((model) => model.provider === provider && model.id === id),
			getAvailable: () => [modelA, modelB],
		},
		scopedModels: [],
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => sessionHeader,
			getBranch: () => sessionEntries,
			getEntries: () => sessionEntries,
			getLeafId: () => sessionEntries.at(-1)?.id ?? null,
			getEntry: (id: string) => sessionEntries.find((entry) => entry.id === id),
		},
		ui: {
			notify() {},
			async confirm() {
				return true;
			},
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
		appendEntry(customType: string, data: unknown) {
			sessionEntries.push({ type: "custom", id: `entry-${sessionEntries.length + 1}`, customType, data });
		},
		async setModel(model: any) {
			if (model.provider === "keyless") return false;
			ctx.model = { ...model };
			return true;
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
		createClient: (options) =>
			new LoopbackClient(options, (url) => {
				const socket = new FakeWebSocket(url);
				socket.onSend = (frame) => {
					if (
						frame.cmd === "ping" ||
						frame.cmd === "aibot_respond_msg" ||
						frame.cmd === "aibot_respond_update_msg" ||
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
	initialControl = ws.sent.find((frame) => isControlCardId(frame.body?.template_card?.task_id));
	// These long-standing task tests start with both their default and task chat already introduced.
	plain(`/wecom-aibot --sessionid ${sessionId} card`);
	await drain();
	ws.sent.length = 0;
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
	const controls = introductions(pushed);
	assert.equal(controls.length, 1, "connect publishes a new control card, also without a new registration");
	const notifications = pushed.filter((frame) => !controls.includes(frame));
	assert.equal(notifications.length, 1);
	assert.match(shown(notifications[0]), /PENDING-BEFORE-RECONNECT/);
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
	assert.equal(replies().length, 0, "the message itself gets no reply");
	const [card] = resultCards();
	assertResultCard(card, "⚠️ 未执行：refused-task", "未执行");
	assert.match(bodyOf(card), /没有接受/);
	assert.doesNotMatch(bodyOf(card), /LOCAL-ONLY-ANSWER/);
	// The local run uses the configured default, never the refused task's source chat.
	await sendNotification({ content: "LOCAL-PUSH" });
	const localPush = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1)!;
	assert.equal(localPush.body.chatid, "default-user");
	assert.doesNotMatch(shown(localPush), /LOCAL-ONLY-ANSWER/);
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
	assert.equal(resultCards().length, 0);
	idle = true;
	clock.tick(5_000);
	await drain();
	assert.equal(replies().length, 0);
	const [card] = resultCards();
	assertResultCard(card, "⚠️ 未执行：silently-refused", "未执行");
	assert.match(bodyOf(card), /没有接受/);
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

test("a scheduled notification owns a task's result: one card, and the message keeps no reply", async () => {
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
	// The scheduled notification is a card; no reply to the message carries the result as well.
	const results = ws.sent.filter((frame) =>
		(frame.body?.stream?.content ?? (frame.cmd === "aibot_send_msg" ? shown(frame) : "")).includes("RESULT-1024"),
	);
	assert.equal(results.length, 1, "同一任务的结果只能发送一次");
	clock.tick(1_000);
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length,
		0,
		"no 执行中, no 结果见下方卡片: the card is the answer",
	);
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
	await drain();
	assert.equal(resultCards("another-chat").length, 1, "the scheduled notice goes where it was asked");
	const [card] = resultCards();
	assertResultCard(card, "✅ 完成：other-target");
	assert.equal(bodyOf(card), "RESULT");
	assert.equal(replies().length, 0);
});

test("assistant streaming sends nothing: the task's one message is its result card", async () => {
	inbound("stream");
	await drain();
	await emit("message_start", { message: { role: "assistant" } });
	await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "OLD-TOOL-TURN" } });
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "OLD-TOOL-TURN" }] } });
	await emit("message_start", { message: { role: "assistant", model: "model-b", provider: "another-provider" } });
	await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "NEW-ANSWER" } });
	clock.tick(5000);
	assert.equal(replies().length, 0, "no status, no partials");
	assert.equal(resultCards().length, 0);
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
	await drain();
	assert.equal(replies().length, 0);
	const cards = resultCards();
	assert.equal(cards.length, 1);
	assertCard(cards[0], "Model B", "another-provider");
	assert.equal(bodyOf(cards[0]), "NEW-ANSWER");
});

test("a completed result survives reconnect and ignores unrelated local output", async () => {
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
	assert.equal(replies(nextWs.sent).length, 0);
	const cards = resultCards("test-user", nextWs.sent);
	assert.equal(cards.length, 1);
	assertResultCard(cards[0], "✅ 完成：reconnect");
	assert.equal(bodyOf(cards[0]), "REMOTE-RESULT");
	assert.doesNotMatch(JSON.stringify(cards[0].body), /UNRELATED|Model B/);
});

test("a finished run's result is a new control card: the window's last lines, its outcome, then the live state on a click", async () => {
	await writeFile(
		CONFIG_FILE,
		JSON.stringify({ ...JSON.parse(await readFile(CONFIG_FILE, "utf8")), notificationScope: "all-runs" }),
	);
	// The terminal is bound at session_start: a pi with a screen to read.
	const fixture = await tuiStart();
	idle = false;
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "THE REPLY" }] } });
	fixture.state.lines = ["● 运行检查", "✔ 542 passed", "", "检查全部通过，改动未提交", "────────"];
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const result = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assertResultCard(result, "✅ 本轮完成");
	assert.equal(
		result.body.template_card.quote_area.quote_text,
		"● 运行检查\n✔ 542 passed\n检查全部通过，改动未提交",
		"the window as the run left it",
	);
	assert.equal(notified.at(-1)!.text, "THE REPLY");
	// It is a control card: 刷新卡片 asks this pi and redraws it in the live state.
	clickCard(result, "refresh");
	await drain();
	const update = lastUpdate();
	assert.equal(update.body.template_card.task_id, result.body.template_card.task_id);
	assert.equal(update.body.template_card.source.desc, "空闲");
	assert.match(update.body.template_card.horizontal_content_list.at(-1).value, /已刷新/);
	// An aborted run is red, and says so.
	ws.sent.length = 0;
	idle = false;
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "HALF" }] } });
	idle = true;
	await emit("agent_settled", { aborted: true });
	await drain();
	assertResultCard(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1), "⛔ 本轮已中止", "已中止");
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
	assertResultCard(pushes[0], "✅ 本轮完成");
	assert.equal(notified.at(-1)!.text, "LOCAL-RUN-ANSWER", "the reply goes with it, for a refused card's Markdown");
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
	assert.match(shown(pushes[0]), /ONLY-ONCE/);
});

test("all-runs sends to the adopted target while a saved target waits for connect", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	await command("config --scope global set notificationScope=all-runs defaultChatId=new-user", ctx);
	assert.match(notices.at(-1)!, /设置已热更新；接入配置待重新接入/);
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

test("config --scope session set notificationScope applies to the running session without reconnecting", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	const registration = ws;
	await command("config --scope session set notificationScope=all-runs", ctx);
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
		/已保存 session 覆盖：notificationScope：wecom-tasks（内置默认值） → all-runs（session）[\s\S]*设置已热更新/,
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
	assertResultCard(pushes[0], "✅ 本轮完成");
	assert.match(notified.at(-1)!.text, /AFTER-NOTIFY-ON/);
	await command("config --scope session unset notificationScope", ctx);
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

test("a task longer than ten minutes still ends in its result card", async () => {
	inbound("long-task");
	await drain();
	clock.tick(30 * 60_000);
	assert.equal(replies().length, 0, "nothing while it runs");
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: "FINAL-LONG-RESULT" }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(replies().length, 0);
	const cards = resultCards();
	assert.equal(cards.length, 1);
	assertResultCard(cards[0], "✅ 完成：long-task");
	assert.equal(bodyOf(cards[0]), "FINAL-LONG-RESULT");
});

test("long Chinese and emoji answers reach the result card whole and valid", async () => {
	inbound("long-text");
	await drain();
	const answer = "汉字🙂".repeat(4000);
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: answer }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const [card] = resultCards();
	assert.equal(bodyOf(card), answer, "the page shows it whole");
	assert.equal(JSON.stringify(card.body).includes("\ufffd"), false);
});

test("an aborted task's result card says it was stopped", async () => {
	inbound("aborted");
	await drain();
	idle = true;
	await emit("agent_settled", { aborted: true });
	await drain();
	assert.equal(replies().length, 0);
	const [card] = resultCards();
	assertResultCard(card, "⛔ 已中止：aborted", "已中止");
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

test("proactive push waits for the server acknowledgement", async () => {
	autoAcknowledge = false;
	const tool = tools.get("wecom_send");
	await assert.rejects(tool.execute("blank", { chatid: "test-user", content: "  " }), /content 不能为空/);
	const result = tool.execute("push", { chatid: "test-group", chat_type: 2, content: "hello" });
	await drain();
	const push = ws.sent.at(-1);
	assert.equal(push.cmd, "aibot_send_msg");
	assert.equal(push.body.chatid, "test-group");
	assert.equal(push.body.chat_type, 2);
	ws.acknowledge(push);
	assert.equal((await result).details.chat_type, 2);
});

test("wecom_send tells the model what of its next-step comment the card did not take", async () => {
	const tool = tools.get("wecom_send");
	const ok = await tool.execute("ok", { chatid: "test-user", content: '结论\n<!-- wecom_next ["继续"] -->' });
	assert.equal(ok.content[0].text, "已发送到 test-user");
	const broken = await tool.execute("broken", { chatid: "test-user", content: "结论\n<!-- wecom_next [继续] -->" });
	assert.match(broken.content[0].text, /^已发送到 test-user。wecom_next 不是有效的 JSON：/);
	const card = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assert.doesNotMatch(JSON.stringify(card.body), /wecom_next/, "the comment is still taken out");
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
	assertCard(frame);
	assert.match(shown(frame), /实际结果/);
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
	assertCard(first, "Model A");
	ws.acknowledge(first);
	const excerptDetails = (await excerpt).details;
	assert.equal(excerptDetails.model_name, "Model A");
	assert.equal(excerptDetails.provider, "test-provider");
	const custom = sendNotification({ chatid: "test-user", content: "NEW-CONTENT" });
	const second = ws.sent.at(-1);
	assertCard(second, "Model B", "another-provider");
	ws.acknowledge(second);
	const customDetails = (await custom).details;
	assert.equal(customDetails.model_name, "Model B");
	assert.equal(customDetails.provider, "another-provider");
});

test("an extracted reply goes with its card, which shows the session's window, never the reply's private parts", async () => {
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
	const pending = sendNotification({ chatid: "test-user" });
	await drain();
	const frame = ws.sent.at(-1);
	assert.equal(frame.cmd, "aibot_send_msg");
	assertCard(frame);
	assert.equal(noteOf(frame), "📣 会话通知");
	assert.equal(notified.at(-1)!.text, "第一段\n\n第二段\n\n第三段\n\n第四段", "the reply goes with it");
	assert.doesNotMatch(JSON.stringify(frame.body), /PRIVATE-/);
	ws.acknowledge(frame);
	await pending;
	// The reply is read on the session's page, which the quote opens: nothing is pushed into the chat.
	assert.deepEqual(buttons(frame), ["refresh", "send", "model", "abort"]);
});

test("explicit content is headed by its first line on the card, which pushes nothing more into the chat", async () => {
	const body = `部署成功\n\n${"日志".repeat(300)}`;
	const pending = sendNotification({ chatid: "test-user", content: body });
	await drain();
	const card = ws.sent.at(-1);
	ws.acknowledge(card);
	assert.equal((await pending).details.status, "sent");
	assertCard(card);
	assert.equal(noteOf(card), "📣 部署成功", "窗口记录 names the notice");
	assert.equal(card.body.template_card.source.desc, "空闲", "the session's live state");
	assert.deepEqual(buttons(card), ["refresh", "send", "model", "abort"]);
	assert.equal(notified.at(-1)!.text, body, "the whole body goes with it, for a refused card's Markdown");
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 1);
});

test("a completion notification waits for the real final reply", async () => {
	autoAcknowledge = false;
	idle = false;
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "正在处理" }] } });
	const scheduled = await sendNotification({ chatid: "test-user", after_settle: true });
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
		assertCard(frame, "Model B", "another-provider");
		assert.equal(noteOf(frame), "✅ 本轮完成");
		assert.equal(frame.body.template_card.source.desc, "已完成", "a scheduled completion is drawn as the run ended");
		assert.equal(notified.at(-1)!.text, "开头\n\n最终结果\n\n验证通过");
		assert.doesNotMatch(shown(frame), /正在处理/);
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
	assert.match(shown(frame), /中止/);
	assert.doesNotMatch(shown(frame), /PREVIOUS-TASK/);
	ws.acknowledge(frame);
	await drain();
});

test("a recorded model error is sent once, on the card, and the message keeps no other reply", async () => {
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
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length, 0);
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assertCard(pushes[0]);
	const content = shown(pushes[0]);
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

test("group messages addressed to the bot reach pi and their result card goes to that conversation", async () => {
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
	await drain();
	assert.equal(replies().length, 0);
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 2, "the first task in a new chat introduces its control card, then its result");
	for (const push of pushes) {
		assert.ok(controlCardFor(push.body.template_card.task_id, sessionId));
		assert.equal(push.body.chatid, "test-group");
		assert.equal(push.body.chat_type, 2);
	}
	const [card] = resultCards("test-group");
	assertResultCard(card, "✅ 完成：帮我检查项目");
	assert.equal(bodyOf(card), "检查完成");
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
		assert.match(shown(pushes[0]), /KNOWN-UNSENT-RESULT/);
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

test("a newer queued task keeps its own result while an older completion awaits ACK after reconnect", async () => {
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
	await drain();
	const older = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg" && /OLDER-COMPLETION/.test(shown(frame)));
	assert.equal(older.length, 1, "the older completion is out, waiting for its ACK");
	for (let round = 0; round < 3; round++) {
		for (const frame of ws.sent.filter((frame) => frame.cmd === "aibot_send_msg")) ws.acknowledge(frame);
		await drain();
	}
	await settled;
	const newer = resultCards().filter((frame) => bodyOf(frame) === "NEWER-REPLY");
	assert.equal(newer.length, 1, "the newer task has its own card");
	assertResultCard(newer[0], "✅ 完成：newer-task");
	assert.equal(replies().length, 0);
	const pushed = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, pushed, "nothing is pushed twice");
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
	assertCard(frame);
	assert.match(shown(frame), /ORIGINAL-RESULT/);
	assert.doesNotMatch(shown(frame), /UNRELATED/);
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
	assert.match(shown(frame), /部署测试/);
	assertCard(frame);
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
		"config --scope session set notificationScope=all-runs --help",
		"connect --help",
		"reset --help",
		"test --help",
		"test your-userid --chat-type 1 --help",
		"config --scope global whoami --help",
	];
	// -h is no help option: it is refused like any unknown option, before anything runs.
	const refused = ["-h", "disconnect -h", "config whoami --wait 180 -h", "config --scope global edit -h"];
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
	assert.match(shown(ws.sent.at(-1)), /PRESERVED-NOTIFICATION/);
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
		"config set notificationScope=all-runs",
		"config --scope session set",
		"config --scope session set notificationScope=sometimes",
		"config --scope global set secret=leaked",
		"config unset notificationScope",
		"config --scope session set --mode text",
		"config --scope session set defaultChatId='x'",
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
	assertCard(push);
	assert.equal(noteOf(push), "📣 会话通知");
	assert.equal(notified.at(-1)!.text, "THIS-RUN");
});

test("config merges into the file as it is now, keeps the connection, and connect adopts the result", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	// A hand edit (or another window) adds an allowlist after this pi loaded its configuration.
	const edited = { ...JSON.parse(await readFile(CONFIG_FILE, "utf8")), allowedUserIds: ["boss"] };
	await writeFile(CONFIG_FILE, JSON.stringify(edited));
	await command("config --scope global set defaultChatId=boss", ctx);
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
		const pending = command("config --scope global whoami", ctx);
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
	const pending = command("config --scope session whoami", ctx);
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
		/设为默认推送目标：\/wecom-aibot config --scope <global\|session> set defaultChatId=colleague defaultChatType=1/,
	);
	assert.match(report, /未配置 allowedUserIds/);
});

for (const accept of [true, false]) {
	test(`config whoami offers to add someone the allowlist leaves out; ${accept ? "accepted" : "declined"}`, async (t) => {
		const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
		await writeFile(CONFIG_FILE, JSON.stringify({ ...config, allowedUserIds: ["test-user"] }));
		const asked: string[] = [];
		const notices = identityDialogs(t, async (...args: unknown[]) => {
			asked.push(String(args[0]));
			return accept;
		});
		const pending = command("config whoami", ctx);
		await drain();
		plain(notices.codes[0], { from: { userid: "colleague" } });
		await pending;
		assert.deepEqual(asked, ["把 colleague 加入 allowedUserIds？"]);
		assert.deepEqual(
			JSON.parse(await readFile(CONFIG_FILE, "utf8")).allowedUserIds,
			accept ? ["test-user", "colleague"] : ["test-user"],
		);
		assert.match(
			notices.at(-1)!,
			accept
				? /已把 colleague 加入 allowedUserIds；运行 \/wecom-aibot connect 后生效$/
				: /userid colleague 不在 allowedUserIds 中/,
		);
	});
}

test("config whoami says when the allowlist cannot be read, never that there is none, and offers nothing", async (t) => {
	const notices = identityDialogs(t, async () => assert.fail("nothing to confirm without a readable allowlist"));
	const pending = command("config whoami", ctx);
	await drain();
	// The file breaks while the code is waited for: the bot was read, the allowlist cannot be.
	const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
	await writeFile(CONFIG_FILE, JSON.stringify({ ...config, allowedUserIds: "test-user" }));
	plain(notices.codes[0], { from: { userid: "colleague" } });
	await pending;
	const report = notices.at(-1)!;
	assert.match(report, /^已识别单聊：chatid=colleague/m, "the identity is still reported");
	assert.match(report, /无法确认 allowedUserIds：.*allowedUserIds 无效/);
	assert.doesNotMatch(report, /未配置 allowedUserIds/);
});

test("a reconnect during the confirmation keeps a chat identified with the same bot", async (t) => {
	const notices = identityDialogs(t, async () => {
		await command("disconnect", ctx);
		await command("connect", ctx);
		return true;
	});
	const pending = command("config --scope global whoami", ctx);
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
	assert.match(notices.at(-1)!.message, /\/wecom-aibot config --scope global edit/);
	assert.equal(ws.sent.length, frameCount, "none of these may send or reply upstream");
});

test("config help explains whoami's code, the group mention and the wait", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	await command("config whoami --help", ctx);
	assert.match(notices[0], /^ {2}\[--scope <global\|session>\] whoami/m);
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
	await command("config --scope global edit", ctx);
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
	choices = [/^自动结束通知范围：/, /^all-runs：/];
	await command("config --scope global edit", ctx);
	assert.equal(menus.at(-2)?.title, "编辑全局配置");
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).notificationScope, "all-runs");
	choices = [/^自动结束通知范围：/, /^wecom-tasks：/];
	await command("config --scope session edit", ctx);
	assert.equal(menus.at(-2)?.title, "编辑当前 session 的覆盖项");
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")), {
		notificationScope: "wecom-tasks",
	});
	assert.equal(JSON.parse(await readFile(CONFIG_FILE, "utf8")).notificationScope, "all-runs");
	// The session override can be dropped from the same menu.
	choices = [/^自动结束通知范围：/, /^取消覆盖/];
	await command("config --scope session edit", ctx);
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")), {});
	// Esc, an empty Secret and a pasted ID with quotes cancel before anything is written.
	const before = await readFile(CONFIG_FILE, "utf8");
	choices = [];
	await command("config --scope global edit", ctx);
	choices = [/^机器人凭据：/];
	answers = ["", ""];
	await command("config --scope global edit", ctx);
	choices = [/^默认推送目标：/, /手动填写单聊/];
	answers = ['"user_one"'];
	await command("config --scope global edit", ctx);
	assert.match(notices.at(-2)!, /含引号或空格/);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
	assert.equal(notices.filter((notice) => /已取消，配置未修改/.test(notice)).length, 3);
	// Without an interactive UI there is nothing to edit with.
	Object.assign(ctx, { hasUI: false });
	await command("config --scope global edit", ctx);
	assert.match(notices.at(-1)!, /需要交互界面.*config --scope global set/);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
});

test("config show and config <layer> show say where each value comes from, never the Secret", async (t) => {
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	await command("config --scope session set controlPrompts=继续", ctx);
	await command("config show", ctx);
	const merged = notices.at(-1)!;
	assert.match(merged, /controlPrompts +「继续」（session）/);
	assert.match(merged, /notificationScope +wecom-tasks（内置默认值）/);
	assert.match(merged, /defaultChatId +default-user（global）/);
	assert.match(merged, /secret +已配置（global）/);
	assert.match(merged, /当前接入与以上配置一致/);
	await command("config --scope session show", ctx);
	assert.match(notices.at(-1)!, /当前 session 的覆盖项：\n {2}controlPrompts {2}「继续」\n文件：/);
	await command("config --scope global show", ctx);
	assert.match(notices.at(-1)!, /^全局配置/);
	for (const text of notices) assert.doesNotMatch(text, /test-secret/);
	// Nothing configured anywhere: the next step is named instead of a table of blanks alone.
	await command("disconnect", ctx);
	clearConfig();
	await command("config show", ctx);
	assert.match(notices.at(-1)!, /未配置：运行 \/wecom-aibot config --scope global edit/);
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
	choice = /^--scope session set /;
	await command("config --scope session", ctx);
	assert.deepEqual(
		menus.at(-1)?.options.map((option) => option.split(/ {2,}/)[0]),
		[
			"--scope session show",
			"--scope session edit",
			"--scope session set 字段=值 …",
			"--scope session unset 字段 …",
			"--scope session whoami",
		],
	);
	assert.equal(
		new Set(menus.at(-1)?.options.map((option) => visibleWidth(/^(\S.*?) {2,}\S/.exec(option)?.[0] ?? ""))).size,
		1,
		"the descriptions line up",
	);
	assert.deepEqual(editor, ["/wecom-aibot config --scope session set "]);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before, "choosing never writes by itself");
	// Without an interactive UI the subcommands are listed instead.
	Object.assign(ctx, { hasUI: false });
	await command("config --scope global", ctx);
	assert.match(notices.at(-1)!, /^\/wecom-aibot config 需要写明动作，例如 \/wecom-aibot config --scope global show/);
	assert.match(notices.at(-1)!, /--scope global edit/);
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
	await command("config --scope global set defaultChatId=new-user", ctx);
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
	assert.deepEqual(values("config --scope session set notificationScope="), [
		"config --scope session set notificationScope=wecom-tasks ",
		"config --scope session set notificationScope=all-runs ",
	]);
	assert.deepEqual(values("test x --"), ["test x --chat-type ", "test x --help"]);
	assert.deepEqual(values("config whoami --w"), ["config whoami --wait "]);
	assert.deepEqual(values("config --scope "), ["config --scope global ", "config --scope session "]);
	assert.equal(values("config edit "), null, "a write needs its target before the action");
	assert.deepEqual(values("config "), ["config --scope ", "config show ", "config whoami ", "config --help"]);
	assert.deepEqual(values("config show "), ["config show --help"]);
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
	assert.ok(sent[0].content[0].text.includes(`[attachments]\n文件：${saved}\n[/attachments]`));
	assert.equal(await readFile(saved, "utf8"), "%PDF-1.4 test");
	assert.match(await readFile(join(sandbox, ".pi-wecom-aibot-files", ".gitignore"), "utf8"), /^\*$/m);
});

/** A pi with a terminal: its control cards quote the last lines. */
async function tuiStart() {
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

test("every connect publishes a new control card in the default chat, while reconnects reuse it", async () => {
	const fixture = installTuiFixture(ctx);
	fixture.state.lines = ["CURRENT-SCREEN"];
	const card = initialControl.body.template_card;
	assert.ok(controlCardFor(card.task_id, "pi-session-1"));
	assert.deepEqual(card.source, { icon_url: PI_ICON_URL, desc: "空闲", desc_color: 0 });
	assert.equal(card.main_title.title, clamp(`📁 ${basename(sandbox)}`, 36));
	assert.equal(card.main_title.desc, "🤖 Model A · test-provider");
	assert.deepEqual(card.quote_area, { quote_text: "点「刷新卡片」读取画面" }, "no terminal, no document");
	assert.equal(card.sub_title_text, "🆔 session-id: pi-session-1", "the whole ID, spelled like pi --session-id");
	assert.deepEqual(
		card.button_selection,
		{
			question_key: "session",
			title: "会话",
			selected_id: sessionFingerprint("pi-session-1"),
			option_list: [{ id: sessionFingerprint("pi-session-1"), text: `${clamp(basename(sandbox), 10)} · on-1` }],
		},
		"the session dropdown: this pi is the only one online",
	);
	assert.deepEqual(
		buttons(initialControl),
		["refresh", "send", "model", "abort"],
		"no prompts configured: no 发提示词",
	);
	// Before any click, 窗口记录 says the card came with connect.
	assert.deepEqual(card.horizontal_content_list.length, 1);
	assert.equal(card.horizontal_content_list[0].keyname, "窗口记录");
	assert.match(card.horizontal_content_list[0].value, /^\d\d:\d\d 已接入$/);
	const controls = () => introductions(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg"));
	// A runtime reload, then connect: a new card, although this chat's delivery receipt says sent.
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	assert.equal(controls().length, 1, "connect publishes once the registration is ready");
	const fresh = controls()[0];
	assert.equal(fresh.body.chatid, initialControl.body.chatid, "in the default chat");
	assert.ok(controlCardFor(fresh.body.template_card.task_id, "pi-session-1"));
	assert.notEqual(fresh.body.template_card.task_id, card.task_id, "a new copy, not a resend of the old one");
	// connect while connected publishes at once.
	await command("connect", ctx);
	await drain();
	assert.equal(controls().length, 2);
	// The network drops and comes back: the same registration keeps the card it has.
	ws.close();
	clock.tick(1000);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	assert.equal(controls().length, 0, "a reconnect sends no card");
	// The older copies still belong to the session and answer with today's card.
	clickCard(initialControl, "refresh", "default-user");
	await drain();
	const update = ws.sent.find((frame) => frame.cmd === "aibot_respond_update_msg");
	assert.equal(update.body.template_card.task_id, card.task_id);
});

test("an earlier control card still refreshes the owning pi's live state after gateway replacement", async () => {
	await tuiStart(); // Replaces the gateway, while the pi session retains its delivery journal.
	idle = false;
	ctx.model = { ...ctx.model!, ...modelB };
	await emit("model_select", {});
	clock.tick(5_000);
	assert.equal(
		ws.sent.some((frame) => frame.cmd === "aibot_respond_update_msg"),
		false,
		"state changes do not proactively edit a card",
	);
	clickCard(initialControl, "refresh", "default-user");
	await drain();
	const update = ws.sent.find((frame) => frame.cmd === "aibot_respond_update_msg");
	assert.equal(update.body.template_card.task_id, initialControl.body.template_card.task_id);
	assert.equal(update.body.template_card.main_title.desc, "🤖 Model B · another-provider");
	assert.equal(update.body.template_card.source.desc, "执行中");
	assert.equal(update.body.template_card.quote_area.quote_text, "initial screen");
	assert.equal(update.body.template_card.quote_area.type, undefined, "no document, so no link");
	assert.match(update.body.template_card.horizontal_content_list.at(-1).value, /已刷新；未配置文档，只更新卡片$/);
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
	assert.equal(sent.length, 0, "refresh does not start an agent turn");
	idle = true;
	clickCard(initialControl, "refresh", "default-user");
	await drain();
	const next = ws.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg").at(-1);
	assert.equal(next.body.template_card.source.desc, "空闲");
});

test("an explicit card command publishes a new control copy in that chat, and the following task reuses it", async () => {
	plain(`/wecom-aibot --sessionid ${sessionId} card`, { chattype: "group", chatid: "control-group" });
	await drain();
	const first = ws.sent.find((frame) => isControlCardId(frame.body?.template_card?.task_id));
	assert.ok(first);
	assert.equal(first.body.chatid, "control-group");
	assert.equal(first.body.chat_type, 2);
	assert.equal(sent.length, 0);
	plain("not selected yet", { chattype: "group", chatid: "control-group" });
	await drain();
	assert.equal(sent.length, 0, "asking for a card does not silently select its session");
	plain(`/wecom-aibot --sessionid ${sessionId} card`, { chattype: "group", chatid: "control-group" });
	await drain();
	const copies = ws.sent.filter((frame) => isControlCardId(frame.body?.template_card?.task_id));
	assert.equal(copies.length, 2);
	assert.match(copies[1].body.template_card.horizontal_content_list[0].value, /^\d\d:\d\d 已补发控制卡$/);
	assert.notEqual(copies[0].body.template_card.task_id, copies[1].body.template_card.task_id);
	// Even the older copy remains operable: a button an earlier version drew refreshes it in today's layout.
	clickCard(first, "select");
	await drain();
	const redrawn = ws.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg").at(-1);
	assert.deepEqual(buttons(redrawn), ["refresh", "send", "model", "abort"]);
	assert.match(noteOf(redrawn), /^画面读取失败/, "a refresh, which here has no terminal to read");
	plain("still no target", { chattype: "group", chatid: "control-group" });
	await drain();
	assert.equal(sent.length, 0, "a control card never chooses a target");
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_send_msg" && isControlCardId(frame.body?.template_card?.task_id))
			.length,
		2,
	);
});

test("an uncertain manual control delivery is reported as unknown, never as definitely unsent or automatically repeated", async () => {
	const original = ws.onSend;
	ws.onSend = (frame) => {
		if (frame.cmd === "aibot_send_msg" && isControlCardId(frame.body?.template_card?.task_id))
			ws.receive({ headers: frame.headers, errmsg: "malformed acknowledgement" });
		else original?.(frame);
	};
	plain(`/wecom-aibot --sessionid ${sessionId} card`);
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.filter((frame) => isControlCardId(frame.body?.template_card?.task_id)).length, 1);
	const note = pushes.find((frame) => frame.body.msgtype === "markdown");
	assert.match(note.body.markdown.content, /控制卡发送结果未知/);
	assert.doesNotMatch(note.body.markdown.content, /未发出/);
});

test("the session list's 打开会话 publishes this session's control card as a new message; the list stays", async () => {
	plain("/wecom-aibot sessions");
	await drain();
	const list = ws.sent.find((frame) => frame.body?.template_card?.button_selection?.question_key === "pick");
	const keys = buttons(list);
	assert.deepEqual(
		keys.map((key) => key.replace(/@[0-9a-f]{64}$/, "")),
		["pick@show", "pick@refresh"],
	);
	ws.sent.length = 0;
	clickCard(list, keys[0]);
	await drain();
	const published = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(published.length, 1, "a new message");
	assertCard(published[0]);
	assert.notEqual(published[0].body.template_card.task_id, list.body.template_card.task_id);
	assert.equal(noteOf(published[0]), "已补发控制卡");
	const kept = ws.sent.find((frame) => frame.cmd === "aibot_respond_update_msg");
	assert.equal(kept.body.template_card.task_id, list.body.template_card.task_id, "the list itself stays");
	assert.equal(kept.body.template_card.button_selection.question_key, "pick");
	assert.match(noteOf(kept), /^已打开「.+」的控制卡$/);
	assert.equal(sent.length, 0, "nothing runs");
	// The card opened is this session's: its own buttons act on it.
	ws.sent.length = 0;
	clickCard(published[0], "refresh");
	await drain();
	assert.ok(ws.sent.some((frame) => frame.cmd === "aibot_respond_update_msg"));
});

test("the test card is the control card; its abort acts on the live session", async () => {
	await tuiStart();
	await command("test test-user", ctx);
	const card = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assertCard(card);
	assert.equal(noteOf(card), "🧪 部署测试：点任一按钮验证回调");
	assert.deepEqual(buttons(card), ["refresh", "send", "model", "abort"]);
	ws.sent.length = 0;
	clickCard(card, "refresh");
	await drain();
	const refreshed = ws.sent.find((frame) => frame.cmd === "aibot_respond_update_msg");
	assert.equal(refreshed.body.template_card.task_id, card.body.template_card.task_id, "the click came back");
	assert.match(noteOf(refreshed), /^已刷新/);
	// 中止 is two steps: nothing to stop while idle; while a run goes, only 确认中止 within 60 seconds stops it.
	const aborts: number[] = [];
	Object.assign(ctx, { abort: () => aborts.push(1) });
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	const entry = initialControl;
	const lastUpdate = () => ws.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg").at(-1);
	const note = () => lastUpdate().body.template_card.horizontal_content_list.at(-1).value;
	clickCard(entry, "abort");
	await drain();
	assert.equal(aborts.length, 0);
	assert.match(note(), /当前没有运行中的任务$/);
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"]);
	idle = false;
	clickCard(entry, "abort");
	await drain();
	assert.equal(aborts.length, 0, "the first press only asks");
	assert.deepEqual(buttons(lastUpdate()), ["abort-confirm", "abort-cancel"]);
	assert.equal(lastUpdate().body.template_card.source.desc, "等待确认中止");
	assert.equal(lastUpdate().body.template_card.button_selection, undefined);
	assert.equal(lastUpdate().body.userids, undefined, "a single chat has one copy");
	clickCard(entry, "abort-cancel");
	await drain();
	assert.equal(aborts.length, 0);
	assert.match(note(), /已取消中止$/);
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"]);
	clickCard(entry, "abort");
	await drain();
	clock.tick(60_000);
	clickCard(entry, "abort-confirm");
	await drain();
	assert.equal(aborts.length, 0, "a confirmation after 60 seconds stops nothing");
	assert.match(note(), /确认已过期，未中止$/);
	clickCard(entry, "abort");
	await drain();
	clickCard(entry, "abort-confirm");
	await drain();
	assert.equal(aborts.length, 1);
	assert.match(note(), /已请求中止当前运行$/);
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"]);
});

test("an automatic result is the task's card: its page carries the answer, its quote the terminal", async () => {
	const fixture = await tuiStart();
	fixture.state.lines = ["SCREEN-ANSWER", "tool output"];
	inbound("result-task");
	await drain();
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "FINAL-ANSWER" }] } });
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(replies().length, 0);
	const [card] = resultCards();
	assertResultCard(card, "✅ 完成：result-task");
	assert.equal(bodyOf(card), "FINAL-ANSWER");
});

test("wecom_send sends one card quoting the terminal as it is, never the notice's own content", async () => {
	const fixture = await tuiStart();
	fixture.state.lines = ["LIVE-TERMINAL"];
	await sendNotification({ chatid: "test-user", content: "EXPLICIT-CONTENT" });
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assertCard(pushes[0]);
	assert.equal(noteOf(pushes[0]), "📣 EXPLICIT-CONTENT");
	assert.equal(pushes[0].body.template_card.quote_area.quote_text, "LIVE-TERMINAL", "the card shows the window");
});

test("a scheduled notice is drawn once, when its run settles, and survives a reconnect frozen", async () => {
	const fixture = await tuiStart();
	idle = false;
	await sendNotification({ content: "AFTER-SETTLE", after_settle: true });
	// An automatic reconnect before the run ends sends nothing.
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
	// Settled while offline: the card of that moment is frozen and sent on recovery.
	ws.close();
	fixture.state.lines = ["ORIGINAL-SNAPSHOT"];
	idle = true;
	await emit("agent_settled", { aborted: false });
	fixture.state.lines = ["UNRELATED-LOCAL-SCREEN"];
	clock.tick(1000);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await drain();
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.deepEqual(
		pushes.map((frame) => frame.body.msgtype),
		["template_card"],
	);
	assert.equal(
		pushes[0].body.template_card.quote_area.quote_text,
		"ORIGINAL-SNAPSHOT",
		"a frozen notification never redraws a newer screen",
	);
});

test("help stays text while sessions sends one selection card", async () => {
	await tuiStart();
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
	assert.equal(replies.length, 1);
	assert.ok(replies.every((frame) => frame.body.msgtype === "stream" && frame.body.stream.finish === true));
	const pushes = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].body.template_card.button_selection.question_key, "pick", "the session list");
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
		if (content === "/wecom-aibot sessions") {
			const card = ws.sent
				.filter((frame) => frame.body?.template_card?.button_selection?.question_key === "pick")
				.at(-1);
			const option = card?.body.template_card.button_selection.option_list[0].text ?? "";
			return / · (执行中|空闲|状态未知)$/.exec(option)?.[1];
		}
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
	assert.match(shown(pushes[0]), /ONLY-AFTER-SETTLE/);
});

// ---------------------------------------------------------------- the control card's document page

const DOC_URL = "https://qyapi.weixin.qq.com/mcp/v2/bot/doc?apikey=test-api-key-0123456789";
const PAGE_URL = "https://doc.weixin.qq.com/smartpage/a1_doc?p=page-1";
const ICON_URL = "https://wdcdn.qpic.cn/MTY4ODg1/pi-logo-test";

/** The document MCP, answering over fetch like the live service (probed 2026-10). */
function docService(t: TestContext, fail: Record<string, number> = {}, hold?: Promise<void>) {
	const calls: { name: string; arguments: any }[] = [];
	const original = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
		if (String(input) !== DOC_URL) return original(input, init);
		const message = JSON.parse(init.body);
		const reply = (result: unknown, headers: Record<string, string> = {}) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
				status: 200,
				headers: { "content-type": "application/json", ...headers },
			});
		if (message.method === "initialize") return reply({ protocolVersion: "2025-06-18" }, { "mcp-session-id": "s-1" });
		if (message.id === undefined) return new Response(null, { status: 202 });
		const { name, arguments: args } = message.params;
		calls.push({ name, arguments: args });
		// A slow document service: making the document waits until the test lets it go.
		if (hold && name === "smartpage_create") await hold;
		const text = (body: Record<string, unknown>) =>
			reply({ content: [{ type: "text", text: JSON.stringify(body) }] });
		if (fail[name])
			return text({ errcode: fail[name], errmsg: "partial no authorization, hint: [x], from ip: 1.2.3.4" });
		if (name === "smartpage_create")
			return text({ errcode: 0, docid: "a1_doc", url: "https://doc.weixin.qq.com/smartpage/a1_doc" });
		if (name === "smartpage_pages_update")
			return text(args.create_page ? { errcode: 0, page_id: "page-1", page_url: PAGE_URL } : { errcode: 0 });
		if (name === "media_upload") return text({ errcode: 0, media_id: `media-${calls.length}` });
		if (name === "smartpage_images_upload") return text({ errcode: 0, url: ICON_URL });
		return text({ errcode: 0, status: "success" });
	});
	const names = () => calls.map((call) => call.name);
	// The page markdown only; the icon is the one image upload.
	const written = () =>
		calls
			.filter((call) => call.name === "media_upload" && call.arguments.type === "file")
			.map((call) => Buffer.from(call.arguments.base64_content, "base64").toString("utf8"));
	return { calls, names, written };
}

/**
 * connect with a document: the session's page is made (with the icon, rendered with WebAssembly on the real
 * clock) before its card goes out, then written. Waits for both; `connected` is that card.
 */
async function documentStart(
	doc: ReturnType<typeof docService>,
): Promise<{ fixture: ReturnType<typeof installTuiFixture>; connected: any }> {
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		docMcpUrl: DOC_URL,
	});
	const fixture = installTuiFixture(ctx);
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await until(
		() =>
			ws.sent.some((frame) => isControlCardId(frame.body?.template_card?.task_id)) &&
			doc.names().includes("smartpage_pages_overwrite"),
	);
	const connected = ws.sent.find((frame) => isControlCardId(frame.body?.template_card?.task_id));
	ws.sent.length = 0;
	initialControl = connected;
	return { fixture, connected };
}

/** Wait on the real clock, without moving the mocked one, for work that is not timers (WebAssembly, fetch). */
async function until(condition: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		assert.ok(performance.now() < deadline, "condition not reached");
		await new Promise<void>((resolve) => setImmediate(resolve));
		clock.tick(0);
	}
}

function lastUpdate(): any {
	return ws.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg").at(-1);
}

/**
 * A first refresh renders pi's logo with WebAssembly, real work the mocked clock does not cover. Wait on the
 * real clock without moving the mocked one: that would run the refresh's own 3.3 s budget out first.
 */
async function answered(): Promise<any> {
	await drain();
	const deadline = performance.now() + 4000;
	while (!lastUpdate() && performance.now() < deadline) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		clock.tick(0);
	}
	assert.ok(lastUpdate(), "the refresh is answered");
	return lastUpdate();
}

test("connect makes the session's page before its card, which links it; a refresh only rewrites it", async (t) => {
	const doc = docService(t);
	const { fixture, connected } = await documentStart(doc);
	assert.deepEqual(
		new Set(doc.names()),
		new Set([
			"smartpage_create",
			"doc_rules_update",
			"smartpage_pages_update",
			"doc_members_update",
			"media_upload",
			"smartpage_images_upload",
			"smartpage_pages_overwrite",
		]),
	);
	// The new document gets pi's logo, as PNG (WeCom draws no SVG icon), and the card uses that copy.
	const icon = doc.calls.find((call) => call.name === "media_upload" && call.arguments.type === "image")!;
	assert.equal(icon.arguments.file_name, "pi-logo.png");
	assert.equal(Buffer.from(icon.arguments.base64_content, "base64").subarray(1, 4).toString(), "PNG");
	assert.equal(doc.calls.find((call) => call.name === "smartpage_images_upload")!.arguments.docid, "a1_doc");
	assert.deepEqual(doc.calls.find((call) => call.name === "doc_rules_update")!.arguments, {
		docid: "a1_doc",
		enable_member_join_admin_check: false,
		corp_internal_join_auth: "apply",
		corp_external_join_auth: "deny",
	});
	assert.deepEqual(
		doc.calls.find((call) => call.name === "doc_members_update")!.arguments.add_member_list,
		{ items: [{ userid: "default-user", user_type: "user", user_auth: "read" }] },
		"the default chat's user may read it at once",
	);
	const first = connected.body.template_card;
	assert.deepEqual(first.source, { icon_url: ICON_URL, desc: "空闲", desc_color: 0 }, "the card has the icon");
	assert.equal(first.quote_area.type, 1);
	assert.equal(first.quote_area.url, PAGE_URL, "linked from the start");
	assert.equal(first.quote_area.quote_text, "initial screen", "the window as connect found it");
	const [page] = doc.written();
	assert.match(page, /^# .+ · pi-session-1\n/);
	assert.match(page, /\n## 最近回复\n\n（还没有对话）\n$/);
	assert.doesNotMatch(page, /```|initial screen/, "no code block, no terminal: the card has its last lines");
	// A refresh rewrites the same page: one document, one page, one grant, one icon.
	doc.calls.length = 0;
	fixture.state.lines = ["$ npm run check", "✔ 483 passed  0 failed", " ─ ─ ─ ─", "检查全部通过，改动未提交"];
	clickCard(initialControl, "refresh", "default-user");
	await answered();
	assert.deepEqual(doc.names(), ["media_upload", "smartpage_pages_overwrite"]);
	const card = lastUpdate().body.template_card;
	assert.equal(card.quote_area.url, PAGE_URL);
	assert.equal(card.quote_area.quote_text, "$ npm run check\n✔ 483 passed  0 failed\n检查全部通过，改动未提交");
	assert.equal(card.horizontal_content_list.length, 1, "one row: the latest operation; the quote is the link");
	assert.equal(card.horizontal_content_list[0].keyname, "窗口记录");
	assert.match(card.horizontal_content_list[0].value, /^\d\d:\d\d 已刷新（\d+\.\d 秒）$/);
	assert.doesNotMatch(doc.written()[0], /```|npm run check/, "the page is text: no screen in a code block");
	assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0, "a refresh sends no message");
	// A clicker the page does not know yet may read it.
	clickCard(initialControl, "refresh", "colleague");
	await answered();
	assert.deepEqual(
		doc.calls.filter((call) => call.name === "doc_members_update").at(-1)!.arguments.add_member_list.items[0].userid,
		"colleague",
	);
});

test("a published card rewrites the page at once: the last three rounds, newest first, and the notices, masked", async (t) => {
	const doc = docService(t);
	await documentStart(doc);
	const round = async (prompt: string, reply: string) => {
		await emit("message_end", { message: { role: "user", content: [{ type: "text", text: prompt }] } });
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: reply }] } });
	};
	await round("第一轮", "ONE");
	await round("第二轮", "TWO");
	await round("第三轮", "THREE");
	await round("第四轮", "FOUR has test-secret inside\n# 标题");
	await emit("message_end", {
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "send-1", name: "wecom_send", arguments: { content: "部署完成\n\n细节" } }],
		},
	});
	doc.calls.length = 0;
	await sendNotification({ chatid: "test-user", content: "部署完成\n\n细节" });
	await until(() => doc.names().includes("smartpage_pages_overwrite"));
	const page = doc.written().at(-1)!;
	const sections = page.split(/\n## /);
	assert.deepEqual(
		sections.slice(1).map((section) => section.split("\n")[0]),
		["最近回复", "最近通知"],
	);
	assert.deepEqual(
		[...sections[1].matchAll(/^### \d\d-\d\d \d\d:\d\d (.+)$/gm)].map((match) => match[1]),
		["第四轮", "第三轮", "第二轮"],
		"three rounds, newest first",
	);
	assert.match(sections[1], /FOUR has \*{11} inside\n#### 标题/, "secrets masked; a reply's heading goes down");
	assert.doesNotMatch(page, /test-secret|ONE/);
	assert.match(sections[2], /### \d\d-\d\d \d\d:\d\d 部署完成\n\n部署完成\n\n细节/);
});

test("while a round runs, its page says so instead of calling it a round without text", async (t) => {
	const doc = docService(t);
	await documentStart(doc);
	await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "跑一下测试" }] } });
	idle = false;
	doc.calls.length = 0;
	clickCard(initialControl, "refresh", "default-user");
	await answered();
	assert.match(doc.written().at(-1)!, /### \d\d-\d\d \d\d:\d\d 跑一下测试\n\n（执行中，还没有回复）\n/);
	assert.match(doc.written().at(-1)!, / · 执行中 · /);
});

test("a page not made within six seconds leaves connect's card without a link; the page is made for later cards", async (t) => {
	let release!: () => void;
	const doc = docService(t, {}, new Promise<void>((resolve) => (release = resolve)));
	writeLayer("global", {
		botId: "test-bot",
		secret: "test-secret",
		defaultChatId: "default-user",
		docMcpUrl: DOC_URL,
	});
	installTuiFixture(ctx);
	await emit("session_start");
	await command("connect", ctx);
	ws = FakeWebSocket.instances.at(-1)!;
	ws.open();
	ws.acknowledge();
	await until(() => doc.names().includes("smartpage_create"));
	const control = () => ws.sent.find((frame) => isControlCardId(frame.body?.template_card?.task_id));
	assert.equal(control(), undefined, "the card waits for its page a while");
	clock.tick(6_000);
	await until(() => control() !== undefined);
	assert.equal(control().body.template_card.quote_area.url, undefined, "sent without a link");
	release();
	// The card's own page write waits for the page's lock, retried every 50 ms.
	await until(() => {
		clock.tick(50);
		return doc.names().includes("smartpage_pages_overwrite");
	});
	clickCard(control(), "refresh", "default-user");
	await answered();
	assert.equal(lastUpdate().body.template_card.quote_area.url, PAGE_URL, "the page, made meanwhile, is linked");
});

test("a document that refuses the write turns the card red with the reason; the three lines still update and secrets stay masked", async (t) => {
	const doc = docService(t, { smartpage_pages_overwrite: 851008, smartpage_images_upload: 851008 });
	const { fixture } = await documentStart(doc);
	fixture.state.lines = ["token test-secret here", "deploy step two"];
	clickCard(initialControl, "refresh");
	await answered();
	const card = lastUpdate().body.template_card;
	assert.deepEqual(card.source, { icon_url: PI_ICON_URL, desc: "文档不可用", desc_color: 2 });
	assert.match(card.sub_title_text, /^🆔 session-id: pi-session-1；.*工作台 → 智能机器人 → 可使用权限/);
	assert.match(card.horizontal_content_list.at(-1).value, /文档写入失败/);
	assert.equal(card.quote_area.quote_text, "token *********** here\ndeploy step two");
	assert.doesNotMatch(JSON.stringify(ws.sent), /test-secret|test-api-key/);
	assert.doesNotMatch(doc.written().join("\n"), /test-secret/);
});

test("发送 runs the chosen prompt as this session's task, and its result comes back as a card in that chat", async (t) => {
	await documentStart(docService(t));
	await command("config --scope global set controlPrompts=继续", ctx);
	// 发提示词 only opens the prompts; 确认发送 sends the one chosen.
	clickCard(initialControl, "send", "default-user");
	await drain();
	assert.equal(sent.length, 0);
	const choosing = lastUpdate().body.template_card;
	assert.equal(choosing.button_selection.question_key, "prompt");
	assert.deepEqual(
		choosing.button_selection.option_list.map((option: { text: string }) => option.text),
		["继续"],
	);
	assert.deepEqual(buttons(lastUpdate()), ["send-confirm", "send-cancel"]);
	assert.match(noteOf(lastUpdate()), /^选好提示词后点「确认发送」$/);
	clickCard(initialControl, "send-cancel", "default-user");
	await drain();
	assert.equal(sent.length, 0);
	assert.match(noteOf(lastUpdate()), /^已取消，没有发送提示词$/);
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"]);
	clickCard(initialControl, "send", "default-user");
	await drain();
	clickCard(initialControl, "send-confirm", "default-user", { prompt: CONTINUE });
	await drain();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].content, [{ type: "text", text: "继续" }]);
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"], "back to the controls");
	assert.match(lastUpdate().body.template_card.horizontal_content_list.at(-1).value, /已发送「继续」$/);
	assert.equal(lastUpdate().body.template_card.source.desc, "执行中");
	ws.sent.length = 0;
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "CONTINUED-ANSWER" }] } });
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const result = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assert.equal(result.body.chatid, "default-user");
	assertResultCard(result, "✅ 完成：继续");
	assert.match(notified.at(-1)!.text, /CONTINUED-ANSWER/);
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_respond_msg").length,
		0,
		"a click has no status message",
	);
});

test("a WeCom task's run is told where its answer goes; a later terminal run only when it is reported", async () => {
	inbound("guided-task");
	await drain();
	assert.equal(sent.length, 1);
	assert.match(sent[0].content[0].text, /^\[wecom\|from:test-user\|chat:单聊\]\n/);
	assert.match(promptSections.wecom, /task sent from WeCom/);
	await emit("message_end", {
		message: { role: "assistant", content: [{ type: "text", text: '结果\n<!-- wecom_next ["下一步"] -->' }] },
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(replies().length, 0);
	const [card] = resultCards();
	assert.equal(bodyOf(card), "结果", "nothing sent to WeCom carries the comment");
	assert.doesNotMatch(JSON.stringify(card.body), /wecom_next/);
	clickCard(card, "send");
	await drain();
	assert.deepEqual(
		lastUpdate().body.template_card.button_selection.option_list.map((option: { text: string }) => option.text),
		["下一步"],
		"a WeCom task's card offers its answer's next steps too",
	);
	await emit("before_agent_start", { messageType: "user", prompt: "LOCAL" });
	assert.equal(promptSections.wecom, undefined, "a terminal run nobody reports gets nothing");
	await command("config --scope global set notificationScope=all-runs", ctx);
	await emit("before_agent_start", { messageType: "user", prompt: "LOCAL-REPORTED" });
	assert.match(promptSections.wecom, /published to the default chat/);
});

test("a card's answer offers its next steps first in that card's 提示词; the comment never reaches WeCom", async (t) => {
	await documentStart(docService(t));
	await command("config --scope global set controlPrompts=继续", ctx);
	clickCard(initialControl, "send-confirm", "default-user", { prompt: CONTINUE });
	await drain();
	assert.equal(sent.length, 1);
	assert.match(promptSections.wecom, /control card/);
	ws.sent.length = 0;
	await emit("message_end", {
		message: {
			role: "assistant",
			content: [{ type: "text", text: '已继续\n\n<!-- wecom_next ["运行测试", "继续"] -->' }],
		},
	});
	idle = true;
	await emit("agent_settled", { aborted: false });
	await drain();
	const result = ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assertResultCard(result, "✅ 完成：继续");
	assert.equal(notified.at(-1)!.text, "已继续");
	clickCard(result, "send", "default-user");
	await drain();
	assert.deepEqual(
		lastUpdate().body.template_card.button_selection.option_list.map((option: { text: string }) => option.text),
		["运行测试", "继续"],
		"the answer's steps first; one already in controlPrompts is listed once",
	);
	clickCard(result, "send-confirm", "default-user", { prompt: promptOptions(["运行测试"])[0].id });
	await drain();
	assert.deepEqual(sent.at(-1)!.content, [{ type: "text", text: "运行测试" }]);
});

test("中止任务 with tasks queued can stop this run and the queue; each cleared message is told it did not run", async () => {
	const aborts: number[] = [];
	Object.assign(ctx, { abort: () => aborts.push(1) });
	inbound("running-task");
	await drain();
	assert.equal(sent.length, 1);
	inbound("waiting-1");
	inbound("waiting-2");
	await drain();
	assert.equal(sent.length, 1, "the others wait");
	clickCard(initialControl, "abort", "default-user");
	await drain();
	assert.equal(lastUpdate().body.template_card.source.desc, "等待确认中止 · 排队 2");
	assert.deepEqual(buttons(lastUpdate()), ["abort-confirm", "abort-all", "abort-queue", "abort-cancel"]);
	clickCard(initialControl, "abort-all", "default-user");
	await drain();
	assert.equal(aborts.length, 1);
	assert.match(noteOf(lastUpdate()), /已请求中止当前运行。已清空排队的 2 条$/);
	const replies = ws.sent
		.filter((frame) => frame.cmd === "aibot_respond_msg")
		.map((frame) => String(frame.body?.stream?.content ?? ""));
	assert.equal(replies.filter((content) => /这条消息没有执行：已在控制卡上清空排队$/.test(content)).length, 2);
});

test("发送 while pi is busy queues the prompt and says how many come first; an unknown option is refused", async (t) => {
	await documentStart(docService(t));
	await command("config --scope global set controlPrompts=继续", ctx);
	idle = false;
	clickCard(initialControl, "send-confirm", "default-user", { prompt: CONTINUE });
	await drain();
	assert.equal(sent.length, 0);
	assert.match(lastUpdate().body.template_card.horizontal_content_list.at(-1).value, /已排队「继续」，前面 1 条$/);
	idle = true;
	await emit("agent_settled", { aborted: false });
	// A busy pi is polled again every 250 ms before the next task starts.
	clock.tick(250);
	await drain();
	assert.equal(sent.length, 1, "the queued prompt runs once pi is free");
	clickCard(initialControl, "send-confirm", "default-user", { prompt: "not-a-prompt" });
	await drain();
	assert.match(
		lastUpdate().body.template_card.horizontal_content_list.at(-1).value,
		/提示词已修改，请看刷新后的卡片重选$/,
	);
	assert.equal(sent.length, 1);
});

test("controlPrompts fills the dropdown; 发送 sends the whole prompt, and an option edited away since is refused", async (t) => {
	await documentStart(docService(t));
	const long = "运行 npm run check，失败就修复后再跑一遍";
	// config set needs no space in a prompt; config edit takes one per line, spaces included.
	const notices: string[] = [];
	t.mock.method(ctx.ui, "notify", (message: string) => notices.push(message));
	// Nothing configured: the card has no 发送, and an old card's 发送 says how to configure.
	clickCard(initialControl, "send", "default-user", { prompt: CONTINUE });
	await drain();
	assert.match(
		lastUpdate().body.template_card.horizontal_content_list.at(-1).value,
		/^\d\d:\d\d 没有提示词：先在 pi 里设置 controlPrompts$/,
	);
	assert.equal(sent.length, 0);
	await command("config --scope global set controlPrompts=继续", ctx);
	assert.match(notices.at(-1)!, /controlPrompts：无（内置默认值） → 「继续」（global）/);
	await command("config --scope session set controlPrompts=继续,总结进度", ctx);
	assert.match(
		notices.at(-1)!,
		/controlPrompts：「继续」（global） → 「继续」、「总结进度」（session）[\s\S]*设置已热更新/,
	);
	Object.assign(ctx, { hasUI: true });
	let choices = [/^控制卡提示词：/, /^编辑提示词/];
	const edited: string[] = [];
	Object.assign(ctx.ui, {
		async select(_title: string, options: string[]) {
			const wanted = choices.shift();
			return wanted && options.find((option) => wanted.test(option));
		},
		async editor(_title: string, prefill: string) {
			edited.push(prefill);
			return `继续\n\n  ${long}  \n`;
		},
	});
	await command("config --scope session edit", ctx);
	assert.deepEqual(edited, ["继续\n总结进度"], "the editor opens with one prompt per line");
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")).controlPrompts, [
		"继续",
		long,
	]);
	clickCard(initialControl, "send");
	await answered();
	const options = lastUpdate().body.template_card.button_selection.option_list;
	assert.deepEqual(
		options.map((option: { text: string }) => option.text),
		["继续", "运行 npm ru…"],
	);
	clickCard(initialControl, "send-confirm", "default-user", { prompt: options[1].id });
	await drain();
	assert.deepEqual(
		sent[0].content,
		[{ type: "text", text: long }],
		"the whole prompt, not the option's ten characters",
	);
	assert.match(lastUpdate().body.template_card.horizontal_content_list.at(-1).value, /已发送「运行 npm ru…」$/);
	// The card still offers the old prompt after it is removed: 发送 refuses it instead of guessing.
	choices = [/^控制卡提示词：/, /^取消覆盖/];
	await command("config --scope session edit", ctx);
	clickCard(initialControl, "send-confirm", "default-user", { prompt: options[1].id });
	await drain();
	assert.equal(sent.length, 1);
	assert.match(lastUpdate().body.template_card.horizontal_content_list.at(-1).value, /提示词已修改/);
	clickCard(initialControl, "send", "default-user");
	await drain();
	assert.deepEqual(
		lastUpdate().body.template_card.button_selection.option_list.map((option: { text: string }) => option.text),
		["继续"],
		"发提示词 shows the current list, inherited from global again",
	);
	// An emptied editor in a session means none here, whatever global offers.
	choices = [/^控制卡提示词：/];
	Object.assign(ctx.ui, { editor: async () => "" });
	await command("config --scope session edit", ctx);
	assert.deepEqual(JSON.parse(await readFile(layerFile({ session: sessionId }), "utf8")).controlPrompts, []);
	clickCard(initialControl, "refresh");
	await drain();
	assert.equal(lastUpdate().body.template_card.button_selection.question_key, "session");
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"]);
	clickCard(initialControl, "send", "default-user");
	await drain();
	assert.match(noteOf(lastUpdate()), /^没有提示词：先在 pi 里设置 controlPrompts$/);
});

test("最近回复 and 查看通知 on a card drawn before they were retired only refresh it, pushing nothing", async () => {
	const print = sessionFingerprint(sessionId);
	for (const retired of ["latest", "notice"]) {
		ws.sent.length = 0;
		clickCard(initialControl, `${retired}@${print}`);
		await drain();
		assert.match(noteOf(lastUpdate()), /^画面读取失败/, "a refresh, which here has no terminal to read");
		assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"]);
		assert.equal(ws.sent.filter((frame) => frame.cmd === "aibot_send_msg").length, 0);
	}
});

test("切换模型 lists pi's models, the one in use first; 确认切换 switches the session, and the card shows it", async () => {
	clickCard(initialControl, "model", "default-user");
	await drain();
	const choosing = lastUpdate().body.template_card;
	assert.equal(choosing.button_selection.question_key, "model");
	assert.deepEqual(
		choosing.button_selection.option_list.map((option: { text: string }) => option.text),
		["Model A", "Model B"],
	);
	assert.equal(choosing.button_selection.selected_id, choosing.button_selection.option_list[0].id);
	assert.deepEqual(buttons(lastUpdate()), ["model-confirm", "model-cancel"]);
	assert.match(noteOf(lastUpdate()), /^选好模型后点「确认切换」/);
	const modelB = choosing.button_selection.option_list[1].id;
	clickCard(initialControl, "model-confirm", "default-user", { model: modelB });
	await drain();
	assert.equal(ctx.model!.id, "model-b");
	assert.match(noteOf(lastUpdate()), /^已切换到 Model B$/);
	assert.equal(lastUpdate().body.template_card.main_title.desc, "🤖 Model B · another-provider");
	assert.deepEqual(buttons(lastUpdate()), ["refresh", "send", "model", "abort"], "back to the controls");
	// The one in use again: nothing changes.
	clickCard(initialControl, "model-confirm", "default-user", { model: modelB });
	await drain();
	assert.match(noteOf(lastUpdate()), /^模型没有改：仍是 Model B$/);
	clickCard(initialControl, "model-cancel", "default-user");
	await drain();
	assert.match(noteOf(lastUpdate()), /^已取消，模型没有改$/);
	assert.equal(ctx.model!.id, "model-b");
});

test("more than ten models: 下一页 turns the clicker's copy, and 确认切换 without a choice takes that page's first", async () => {
	const relays = Array.from({ length: 12 }, (_, index) => ({
		id: `relay-model-${index}`,
		name: `Relay ${index}`,
		provider: "relay",
	}));
	const registry = ctx.modelRegistry as any;
	registry.getAvailable = () => [modelA, modelB, ...relays];
	registry.find = (provider: string, id: string) =>
		[modelA, modelB, ...relays].find((model) => model.provider === provider && model.id === id);
	clickCard(initialControl, "model", "default-user");
	await drain();
	const first = lastUpdate().body.template_card;
	assert.equal(first.button_selection.title, "模型 1/2");
	assert.deepEqual(buttons(lastUpdate()), ["model-confirm", "model-cancel", "model-prev", "model-next"]);
	clickCard(initialControl, "model-next", "default-user");
	await drain();
	const second = lastUpdate().body.template_card;
	assert.equal(second.button_selection.title, "模型 2/2");
	assert.deepEqual(
		second.button_selection.option_list.map((option: { text: string }) => option.text),
		["Relay 8", "Relay 9", "Relay 10", "Relay 11"],
	);
	assert.match(noteOf(lastUpdate()), /^第 2\/2 页；选好模型后点「确认切换」$/);
	clickCard(initialControl, "model-confirm", "default-user");
	await drain();
	assert.equal(ctx.model!.id, "relay-model-8", "WeCom showed the page's first selected");
	assert.match(noteOf(lastUpdate()), /^已切换到 Relay 8$/);
	// The next 切换模型 starts from the first page again, and 下一页 wraps round.
	clickCard(initialControl, "model", "default-user");
	await drain();
	assert.equal(lastUpdate().body.template_card.button_selection.title, "模型 1/2");
	clickCard(initialControl, "model-prev", "default-user");
	await drain();
	assert.equal(lastUpdate().body.template_card.button_selection.title, "模型 2/2");
});

test("in a group only the member who pressed 中止 is asked to confirm, and only they can confirm", async () => {
	const aborts: number[] = [];
	Object.assign(ctx, { abort: () => aborts.push(1) });
	plain(`/wecom-aibot --sessionid ${sessionId} card`, { chattype: "group", chatid: "team" });
	await drain();
	const control = ws.sent.find(
		(frame) => frame.body?.chatid === "team" && isControlCardId(frame.body?.template_card?.task_id),
	);
	idle = false;
	clickCard(control, "abort", "alice");
	await drain();
	assert.deepEqual(lastUpdate().body.userids, ["alice"]);
	assert.deepEqual(buttons(lastUpdate()), ["abort-confirm", "abort-cancel"]);
	clickCard(control, "abort-confirm", "bob");
	await drain();
	assert.equal(aborts.length, 0);
	assert.match(lastUpdate().body.template_card.horizontal_content_list.at(-1).value, /只有发起中止的人能确认$/);
	clickCard(control, "abort-confirm", "alice");
	await drain();
	assert.equal(aborts.length, 1);
	assert.equal(lastUpdate().body.userids, undefined, "after the abort everyone's copy is current again");
});

test("a finished turn rewrites the page at most every 30 seconds after its last write, and never edits a card", async (t) => {
	const doc = docService(t);
	await documentStart(doc);
	doc.calls.length = 0;
	await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "第一轮" }] } });
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "AFTER-THE-TURN" }] } });
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.deepEqual(doc.names(), [], "connect has just written it");
	clock.tick(30_000);
	await emit("agent_settled", { aborted: false });
	await until(() => doc.names().includes("smartpage_pages_overwrite"));
	assert.deepEqual(doc.names(), ["media_upload", "smartpage_pages_overwrite"]);
	assert.match(doc.written()[0], /AFTER-THE-TURN/);
	await emit("agent_settled", { aborted: false });
	await drain();
	assert.equal(doc.names().length, 2, "a second turn within 30 seconds waits");
	clock.tick(30_000);
	await emit("agent_settled", { aborted: false });
	await until(() => doc.names().length === 4);
	assert.equal(
		ws.sent.filter((frame) => frame.cmd === "aibot_respond_update_msg").length,
		0,
		"a turn never edits a card",
	);
});

test("reset deletes the pages this machine created before the document address is forgotten", async (t) => {
	const doc = docService(t);
	await documentStart(doc);
	doc.calls.length = 0;
	await command("reset", ctx);
	assert.deepEqual(doc.calls, [
		{ name: "smartpage_pages_update", arguments: { docid: "a1_doc", delete_page: { page_id: "page-1" } } },
	]);
	const record = JSON.parse(await readFile(join(sandbox, "wecom-aibot", "session-doc.json"), "utf8"));
	assert.deepEqual(
		Object.values(record).map((entry: any) => entry.pages),
		[{}],
	);
});

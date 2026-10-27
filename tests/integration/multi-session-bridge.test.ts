import "../support/home-sandbox.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GatewayClient } from "../../src/extension/gateway-client.ts";
import { type GatewayServer, startGatewayServer } from "../../src/gateway/server.ts";
import { controlCardFor, isControlCardId, sessionFingerprint } from "../../src/shared/control-card.ts";
import { gatewayEndpoint } from "../../src/shared/gateway-protocol.ts";
import { FakeWebSocket } from "../support/fake-websocket.ts";

const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-multi-test-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../../src/extension/index.ts");
const { writeLayer, readLayer, CONFIG_FILE } = await import("../../src/extension/config.ts");
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let server: GatewayServer;
let harnesses: ReturnType<typeof piHarness>[];

async function until(predicate: () => boolean, description: string, timeout = 4000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(`timed out: ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function piHarness(id: string) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
	const state = {
		idle: true,
		sessionId: `session-${id}`,
		entries: [] as any[],
		sent: [] as any[],
		clients: [] as GatewayClient[],
	};
	const ctx = {
		hasUI: false,
		cwd: join(sandbox, `project-${id}`),
		isIdle: () => state.idle,
		model: { id: `model-${id}`, name: `Model ${id}`, provider: `provider-${id}` },
		sessionManager: {
			getSessionId: () => state.sessionId,
			getHeader: () => null,
			getBranch: () => state.entries,
			getEntries: () => state.entries,
			getLeafId: () => state.entries.at(-1)?.id ?? null,
		},
		ui: { notify() {}, confirm: async () => true },
	} as unknown as ExtensionContext;
	const pi = {
		on(type: string, handler: Handler) {
			handlers.set(type, [...(handlers.get(type) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(_name: string, options: { handler: typeof command }) {
			command = options.handler;
		},
		appendEntry(customType: string, data: unknown) {
			state.entries.push({ type: "custom", id: randomUUID(), customType, data });
		},
		sendUserMessage(content: any) {
			state.sent.push(content);
			state.idle = false;
			// pi echoes the prompt it starts through before_agent_start.
			void emit("before_agent_start", {
				messageType: "user",
				prompt: content
					.filter((part: any) => part.type === "text")
					.map((part: any) => part.text)
					.join("\n"),
				images: content.filter((part: any) => part.type === "image"),
			});
		},
	} as unknown as ExtensionAPI;
	async function emit(type: string, event: any = {}) {
		if (type === "message_end") state.entries.push({ type: "message", id: randomUUID(), message: event.message });
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	}
	extension(pi, {
		createClient(options) {
			const client = new GatewayClient({
				...options,
				launch() {
					throw new Error("test gateway must already exist");
				},
			});
			state.clients.push(client);
			return client;
		},
	});
	return {
		state,
		ctx,
		command: (text: string) => command(text, ctx),
		notification: (params: Record<string, unknown>) =>
			tools.get("wecom_send").execute("send", params, undefined, undefined, ctx),
		emit,
		ready: () => state.clients.at(-1)?.isReady() ?? false,
	};
}

function inbound(sessionId: string, text: string) {
	const id = randomUUID();
	FakeWebSocket.instances.at(-1)!.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid: "user" },
			chattype: "single",
			msgtype: "text",
			text: { content: text },
			quote: { msgtype: "text", text: { content: `session: ${sessionId}` } },
		},
	});
}

async function result(pi: ReturnType<typeof piHarness>, text: string) {
	await pi.emit("message_end", {
		message: {
			role: "assistant",
			provider: pi.ctx.model!.provider,
			model: pi.ctx.model!.id,
			content: [{ type: "text", text }],
		},
	});
	pi.state.idle = true;
	await pi.emit("agent_settled", { aborted: false });
}

async function pair(connected = true) {
	const a = piHarness("A");
	const b = piHarness("B");
	harnesses.push(a, b);
	await a.emit("session_start");
	await b.emit("session_start");
	assert.equal(a.state.clients.length + b.state.clients.length, 0, "neither session inherits a connection");
	if (connected) {
		await a.command("connect");
		await b.command("connect");
		await until(() => a.ready() && b.ready(), "two manual extension registrations");
		await until(
			() => FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_send_msg").length === 2,
			"both connection entries",
		);
		FakeWebSocket.instances[0].sent.length = 0;
	}
	return { a, b };
}

beforeEach(async () => {
	harnesses = [];
	FakeWebSocket.instances = [];
	const config = { botId: `multi-test-${randomUUID()}`, secret: "offline-test-secret", defaultChatId: "default-user" };
	writeLayer("global", config);
	server = (await startGatewayServer({
		credentials: config,
		endpoint: gatewayEndpoint(config.botId),
		idleTimeoutMs: 50,
		createWebSocket(url) {
			const ws = new FakeWebSocket(url);
			ws.onSend = (frame) => {
				if (
					[
						"aibot_subscribe",
						"aibot_send_msg",
						"aibot_respond_msg",
						"aibot_respond_update_msg",
						"aibot_respond_welcome_msg",
						"ping",
					].includes(frame.cmd)
				)
					ws.acknowledge(frame);
			};
			queueMicrotask(() => ws.open());
			return ws;
		},
	}))!;
});
afterEach(async () => {
	for (const pi of harnesses) await pi.emit("session_shutdown");
	server.close();
	await server.closed;
});
after(async () => {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	assert.equal(dirname(sandbox), tmpdir());
	await rm(sandbox, { recursive: true, force: true });
});

/** A published card is its own pi's control card: directory, model · provider, session, and why it came. */
function assertCard(frame: any, id: "A" | "B", note: string): void {
	const card = frame.body.template_card;
	assert.equal(frame.body.msgtype, "template_card");
	assert.ok(controlCardFor(card.task_id, `session-${id}`), card.task_id);
	assert.equal(card.main_title.title, `📁 project-${id}`);
	assert.equal(card.main_title.desc, `🤖 Model ${id} · provider-${id}`);
	assert.equal(card.sub_title_text, `🆔 session-id: session-${id}`);
	assert.equal(noteOf(frame), note);
}

function noteOf(frame: any): string {
	return frame.body.template_card.horizontal_content_list.at(-1).value.replace(/^\d\d:\d\d /, "");
}

test("/wecom-aibot connect registers only that session; repeating connect or disconnecting never changes shared config or other pi", async () => {
	const saved = await readFile(CONFIG_FILE, "utf8");
	const { a, b } = await pair(false);
	assert.equal(server.gateway.size, 0);
	await a.command("connect");
	await until(a.ready, "A started");
	assert.equal(server.gateway.size, 1);
	assert.equal(b.state.clients.length, 0);
	await b.command("connect");
	await until(b.ready, "B started");
	await a.command("connect");
	assert.equal(server.gateway.size, 2);
	assert.equal(FakeWebSocket.instances.length, 1);
	assert.equal(a.state.clients.length, 1);
	await a.command("disconnect");
	await until(() => server.gateway.size === 1, "only B remains");
	assert.equal(await readFile(CONFIG_FILE, "utf8"), saved);
	await b.notification({ chatid: "user", content: "B still connected" });
	await b.emit("session_shutdown");
	await server.closed;
	assert.equal(FakeWebSocket.instances[0].readyState, 3);
});

test("two real extension instances process separate tasks and publish their own result metadata", async () => {
	const { a, b } = await pair();
	inbound("session-A", "task A");
	inbound("session-B", "task B");
	await until(() => a.state.sent.length === 1 && b.state.sent.length === 1, "both tasks dispatched");
	assert.match(a.state.sent[0][0].text, /task A/);
	assert.match(b.state.sent[0][0].text, /task B/);
	await a.notification({ chatid: "user", after_settle: true });
	await b.notification({ chatid: "user", after_settle: true });
	await result(b, "RESULT-B");
	await result(a, "RESULT-A");
	const pushes = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.ok(
		pushes.every((frame) => isControlCardId(frame.body?.template_card?.task_id)),
		"pi publishes only control cards",
	);
	const intros = pushes.filter((frame) => noteOf(frame) === "已接入");
	assert.equal(intros.length, 2, "each pi introduces its control once in the new task chat");
	for (const id of ["A", "B"])
		assert.ok(intros.some((frame) => controlCardFor(frame.body.template_card.task_id, `session-${id}`)));
	const results = pushes.filter((frame) => !intros.includes(frame));
	assert.equal(results.length, 2);
	assertCard(results[0], "B", "✅ 本轮完成");
	assertCard(results[1], "A", "✅ 本轮完成");
	// Either card lists both sessions online, the one that sent it selected.
	for (const [frame, id] of [
		[results[0], "B"],
		[results[1], "A"],
	] as const) {
		const dropdown = frame.body.template_card.button_selection;
		assert.deepEqual(
			dropdown.option_list.map((option: { text: string }) => option.text),
			["project-A · on-A", "project-B · on-B"],
		);
		assert.equal(dropdown.selected_id, sessionFingerprint(`session-${id}`));
	}
	// Each result went out as its pi's card (a scheduled notification owns it): neither message has a reply.
	assert.equal(FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_respond_msg").length, 0);
});

test("group participants each choose their own message's session, reach separate real pi instances, and nothing is remembered", async () => {
	const { a, b } = await pair();
	const ws = FakeWebSocket.instances[0];
	/** The question card a message without a session gets, found by the message it quotes. */
	const question = async (text: string) => {
		await until(
			() => ws.sent.some((frame) => frame.body?.template_card?.quote_area?.quote_text === text),
			`question card for ${text}`,
		);
		return ws.sent.find((frame) => frame.body?.template_card?.quote_area?.quote_text === text).body.template_card;
	};
	const choose = (taskId: string, userid: string, sessionId: string) => {
		const id = randomUUID();
		ws.receive({
			cmd: "aibot_event_callback",
			headers: { req_id: id },
			body: {
				msgid: id,
				chattype: "group",
				chatid: "group-1",
				from: { userid },
				msgtype: "event",
				event: {
					eventtype: "template_card_event",
					template_card_event: {
						task_id: taskId,
						event_key: "send",
						selected_items: {
							selected_item: [
								{ question_key: "target", option_ids: { option_id: [sessionFingerprint(sessionId)] } },
							],
						},
					},
				},
			},
		});
	};
	chatMessage({ chattype: "group", chatid: "group-1", from: { userid: "alice" }, text: { content: "@bot task A" } });
	chatMessage({ chattype: "group", chatid: "group-1", from: { userid: "bob" }, text: { content: "@bot task B" } });
	const askA = await question("task A");
	const askB = await question("task B");
	assert.equal(a.state.sent.length + b.state.sent.length, 0, "nothing reaches a pi before its sender chooses");
	// Bob cannot send Alice's message anywhere.
	choose(askA.task_id, "bob", "session-B");
	assert.equal(a.state.sent.length + b.state.sent.length, 0);
	choose(askA.task_id, "alice", "session-A");
	choose(askB.task_id, "bob", "session-B");
	await until(() => a.state.sent.length === 1 && b.state.sent.length === 1, "chosen tasks delivered over IPC");
	assert.equal(a.state.sent[0][0].text, "task A");
	assert.equal(b.state.sent[0][0].text, "task B");
	await result(a, "ORIGINAL-A-RESULT");
	await result(b, "ORIGINAL-B-RESULT");
	await until(() => ws.sent.filter((frame) => frame.body?.stream?.finish === true).length === 2, "both results");
	const results = ws.sent.filter((frame) => frame.body?.stream?.finish === true);
	assert.ok(
		results.some(
			(frame) => /session-A/.test(frame.body.stream.content) && /ORIGINAL-A-RESULT/.test(frame.body.stream.content),
		),
		"each result replies to its own message",
	);
	assert.ok(
		results.some(
			(frame) => /session-B/.test(frame.body.stream.content) && /ORIGINAL-B-RESULT/.test(frame.body.stream.content),
		),
	);
	// Alice's next message is asked about again: her earlier choice is not remembered.
	chatMessage({ chattype: "group", chatid: "group-1", from: { userid: "alice" }, text: { content: "@bot now B" } });
	const again = await question("now B");
	assert.equal(a.state.sent.length + b.state.sent.length, 2, "not sent before she chooses");
	choose(again.task_id, "alice", "session-B");
	await until(() => b.state.sent.length === 2, "Alice's later task reaches B");
	assert.equal(a.state.sent.length, 1);
	assert.equal(b.state.sent[1][0].text, "now B");
});

test("each connect publishes a new card listing every session online then: one, then two, then three", async () => {
	const ws = () => FakeWebSocket.instances[0];
	const pis = ["A", "B", "C"].map((id) => piHarness(id));
	harnesses.push(...pis);
	const cards: any[] = [];
	for (const [index, pi] of pis.entries()) {
		await pi.emit("session_start");
		await pi.command("connect");
		await until(
			() => pi.ready() && ws().sent.filter((frame) => frame.cmd === "aibot_send_msg").length === index + 1,
			`card ${index + 1}`,
		);
		cards.push(
			ws()
				.sent.filter((frame) => frame.cmd === "aibot_send_msg")
				.at(-1).body.template_card,
		);
	}
	const listed = (card: any) => card.button_selection.option_list.map((option: { text: string }) => option.text);
	assert.deepEqual(listed(cards[0]), ["project-A · on-A"]);
	assert.deepEqual(listed(cards[1]), ["project-A · on-A", "project-B · on-B"]);
	assert.deepEqual(listed(cards[2]), ["project-A · on-A", "project-B · on-B", "project-C · on-C"]);
	// Each card shows, and has selected, the session that connected.
	for (const [index, id] of ["A", "B", "C"].entries()) {
		assert.ok(controlCardFor(cards[index].task_id, `session-${id}`));
		assert.equal(cards[index].main_title.title, `📁 project-${id}`);
		assert.equal(cards[index].button_selection.selected_id, sessionFingerprint(`session-${id}`));
	}
});

test("one control card shows any session online: choosing B on A's card has B redraw it, and A is never touched", async () => {
	const { a, b } = await pair();
	const ws = FakeWebSocket.instances[0];
	await a.command("connect");
	await until(() => ws.sent.some((frame) => frame.cmd === "aibot_send_msg"), "A publishes a new card");
	const card = ws.sent.find((frame) => frame.cmd === "aibot_send_msg").body.template_card;
	assert.ok(controlCardFor(card.task_id, "session-A"));
	assert.deepEqual(
		card.button_selection.option_list.map((option: { text: string }) => option.text),
		["project-A · on-A", "project-B · on-B"],
	);
	const aborts: string[] = [];
	Object.assign(a.ctx, { abort: () => aborts.push("A") });
	Object.assign(b.ctx, { abort: () => aborts.push("B") });
	a.state.idle = false;
	b.state.idle = false;
	const press = (key: string, session: string) => {
		const id = randomUUID();
		ws.receive({
			cmd: "aibot_event_callback",
			headers: { req_id: id },
			body: {
				msgid: id,
				chattype: "single",
				from: { userid: "user" },
				msgtype: "event",
				event: {
					eventtype: "template_card_event",
					template_card_event: {
						task_id: card.task_id,
						event_key: key,
						selected_items: {
							selected_item: [
								{ question_key: "session", option_ids: { option_id: [sessionFingerprint(session)] } },
							],
						},
					},
				},
			},
		});
		return id;
	};
	const updated = (id: string) =>
		until(
			() => ws.sent.some((frame) => frame.cmd === "aibot_respond_update_msg" && frame.headers.req_id === id),
			"the card is redrawn",
		).then(
			() =>
				ws.sent.find((frame) => frame.cmd === "aibot_respond_update_msg" && frame.headers.req_id === id).body
					.template_card,
		);
	// 中止任务 pressed on A's card with B chosen: B shows itself; neither run is asked to stop.
	const switched = await updated(press(`abort@${sessionFingerprint("session-A")}`, "session-B"));
	assert.equal(switched.task_id, card.task_id, "the same card");
	assert.equal(switched.main_title.title, "📁 project-B");
	assert.equal(switched.sub_title_text, "🆔 session-id: session-B");
	assert.equal(switched.source.desc, "执行中");
	assert.match(switched.horizontal_content_list.at(-1).value, /已切换到本会话/);
	assert.equal(switched.button_selection.selected_id, sessionFingerprint("session-B"));
	assert.ok(
		switched.button_list.every((button: { key: string }) =>
			button.key.endsWith(`@${sessionFingerprint("session-B")}`),
		),
	);
	assert.deepEqual(aborts, []);
	// Now the card shows B: its 中止任务 asks B, and B alone, to confirm.
	const confirming = await updated(press(`abort@${sessionFingerprint("session-B")}`, "session-B"));
	assert.equal(confirming.source.desc, "等待确认中止");
	assert.equal(confirming.main_title.title, "📁 project-B");
	await updated(press(`abort-confirm@${sessionFingerprint("session-B")}`, "session-B"));
	assert.deepEqual(aborts, ["B"]);
});

test("one pi exiting cannot clear another pi's pending notification or relabel its reconnect snapshot", async () => {
	const { a, b } = await pair();
	inbound("session-B", "remote B");
	await until(() => b.state.sent.length === 1, "B task dispatched");
	await b.notification({ chatid: "user", after_settle: true });
	FakeWebSocket.instances[0].close();
	await until(() => !b.ready(), "B sees disconnection");
	await result(b, "FROZEN-B-RESULT");
	await a.emit("session_shutdown");
	b.ctx.model = { ...b.ctx.model!, name: "Unrelated Model", id: "unrelated", provider: "unrelated" };
	b.ctx.cwd = join(sandbox, "unrelated-project");
	await result(b, "UNRELATED-LOCAL-TEXT");
	await until(
		() =>
			FakeWebSocket.instances.length === 2 &&
			FakeWebSocket.instances[1].sent.some((frame) => frame.cmd === "aibot_send_msg"),
		"B snapshot replayed",
	);
	const pushes = FakeWebSocket.instances[1].sent.filter((frame) => frame.cmd === "aibot_send_msg");
	assert.equal(pushes.length, 1);
	assertCard(pushes[0], "B", "✅ 本轮完成");
	assert.doesNotMatch(JSON.stringify(pushes[0].body), /UNRELATED|unrelated/);
	assert.equal(server.gateway.size, 1);
});

test("switching one pi's session invalidates its old route while the other pi continues", async () => {
	const { a, b } = await pair();
	inbound("session-A", "old task");
	await until(() => a.state.sent.length === 1, "old A task");
	a.state.sessionId = "session-A-new";
	a.state.entries = [];
	a.state.idle = true;
	await a.emit("session_start");
	await until(() => server.gateway.size === 1 && !a.ready(), "old A registration revoked");
	assert.equal(a.state.clients.length, 1, "new A requires an explicit connect");
	await a.command("connect");
	await until(a.ready, "A manually re-registered");
	assert.equal(server.gateway.size, 2);
	assert.equal(FakeWebSocket.instances.length, 1);
	inbound("session-A", "must not reach new A or B");
	inbound("session-A-new", "new A task");
	await until(() => a.state.sent.length === 2, "new A task");
	assert.match(a.state.sent[1][0].text, /new A task/);
	assert.equal(b.state.sent.length, 0);
	await b.notification({ chatid: "user", content: "B unaffected" });
	const push = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assertCard(push, "B", "📣 B unaffected");
});

test("a refused registration stops that pi's bridge, so status and connect see it as disconnected", async () => {
	await pair();
	const c = piHarness("C");
	harnesses.push(c);
	const notices: string[] = [];
	Object.assign(c.ctx, { hasUI: true });
	Object.assign(c.ctx.ui, { notify: (message: string) => notices.push(message) });
	// The same full session ID as A: the gateway refuses it, and the client gives up.
	c.state.sessionId = "session-A";
	await c.emit("session_start");
	await c.command("connect");
	await until(() => notices.some((notice) => notice.includes("另一个 pi 注册")), "duplicate refused");
	await c.command("status");
	assert.match(notices.at(-1)!, /^🛑 企业微信智能机器人：已停止（该完整 session ID 已由另一个 pi 注册/);
	assert.equal(server.gateway.size, 2);
	c.state.sessionId = "session-C";
	await c.emit("session_start");
	await c.command("connect");
	await until(c.ready, "C registered after switching its session");
	assert.equal(c.state.clients.length, 2);
	assert.equal(server.gateway.size, 3);
});

function chatMessage(body: Record<string, unknown>) {
	const id = randomUUID();
	FakeWebSocket.instances.at(-1)!.receive({
		cmd: "aibot_msg_callback",
		headers: { req_id: id },
		body: {
			msgid: id,
			from: { userid: "user" },
			chattype: "single",
			msgtype: "text",
			text: { content: "hello" },
			...body,
		},
	});
}

/**
 * Dialogs: config whoami's wait stays open until it closes itself, and `codes` collects the one-time codes it
 * shows; `answer` picks the cancel option for matching titles, `menu` a setup menu entry.
 */
function dialogs(
	pi: ReturnType<typeof piHarness>,
	options: { answer?: RegExp; inputs?: (string | undefined)[]; menu?: RegExp } = {},
) {
	const ui = {
		titles: [] as string[],
		prompts: [] as string[],
		notices: [] as string[],
		confirms: [] as string[],
		codes: [] as string[],
		waiting: undefined as Promise<void> | undefined,
	};
	let opened!: () => void;
	ui.waiting = new Promise<void>((resolve) => {
		opened = resolve;
	});
	Object.assign(pi.ctx, { hasUI: true });
	Object.assign(pi.ctx.ui, {
		notify: (message: string) => ui.notices.push(message),
		async confirm(title: string, message: string) {
			ui.confirms.push(`${title}\n${message}`);
			return true;
		},
		async input(title: string) {
			ui.prompts.push(title);
			return options.inputs?.shift();
		},
		select(title: string, choices: string[], opts?: { signal?: AbortSignal }) {
			ui.titles.push(title);
			const code = /把 (\d{6}) 发给机器人/.exec(title)?.[1];
			if (code) {
				ui.codes.push(code);
				opened();
			}
			if (title === "默认推送目标" && options.menu)
				return Promise.resolve(choices.find((choice) => options.menu!.test(choice)));
			if (options.answer?.test(title)) return Promise.resolve(choices[0]);
			return new Promise<undefined>((resolve) =>
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }),
			);
		},
	});
	return ui;
}

test("config whoami identifies the chat that sends the code, saves it after confirmation and routes nothing", async () => {
	const { a, b } = await pair();
	const ui = dialogs(a);
	const running = a.command("config --scope global whoami");
	await ui.waiting;
	chatMessage({
		from: { userid: "user_one" },
		chattype: "group",
		chatid: "group_chat",
		text: { content: `@bot ${ui.codes[0]}` },
	});
	await running;
	assert.deepEqual(ui.titles, [`在要识别的聊天里把 ${ui.codes[0]} 发给机器人（群聊需 @机器人），最多 300 秒`]);
	assert.match(ui.confirms[0], /chatid=group_chat　chat_type=2　userid=user_one/);
	assert.equal(readLayer("global")?.defaultChatId, "group_chat");
	assert.equal(readLayer("global")?.defaultChatType, 2);
	assert.match(ui.notices.at(-1)!, /^已保存全局配置：defaultChatId：.* → group_chat（global）/);
	assert.match(ui.notices.at(-1)!, /当前接入仍使用旧配置/);
	assert.match(
		ui.notices.at(-1)!,
		/allowedUserIds.*\["user_one"\]/,
		"without an allowlist, the identified userid is suggested",
	);
	assert.equal(a.state.sent.length + b.state.sent.length, 0, "the identifying message is not a pi task");
	const receipt = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_respond_msg").at(-1);
	assert.match(receipt.body.stream.content, /whoami 已识别当前群聊/);
	assert.match(ui.confirms[0], /保存不会断开当前接入/);
	assert.equal(a.ready(), true, "saving a target never disconnects");
	assert.equal(b.ready(), true);
	await a.command("connect");
	assert.equal(ui.confirms.length, 2, "connect confirms replacing the registration");
	await until(a.ready, "A reconnected with its new default");
	await a.notification({ content: "to the default" });
	const push = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_send_msg").at(-1);
	assert.equal(push.body.chatid, "group_chat");
	assert.equal(push.body.chat_type, 2);
});

test("offline config whoami identifies through a hidden temporary registration and never formally connects", async () => {
	const { a, b } = await pair();
	await a.command("disconnect");
	await until(() => server.gateway.size === 1, "A disconnected");
	const ui = dialogs(a);
	const running = a.command("config --scope global whoami");
	await ui.waiting;
	await until(() => server.gateway.size === 2, "temporary identity registration plus B");
	await assert.rejects(a.notification({ chatid: "user", content: "must not push" }), /未正式接入/);
	chatMessage({
		from: { userid: "user_one" },
		chattype: "group",
		chatid: "group_chat",
		text: { content: `@bot ${ui.codes[0]}` },
	});
	await running;
	assert.equal(ui.confirms.length, 1);
	assert.match(ui.confirms[0], /chatid=group_chat　chat_type=2　userid=user_one/);
	assert.match(ui.confirms[0], /保存后运行 \/wecom-aibot connect 正式接入/);
	assert.equal(readLayer("global")?.defaultChatId, "group_chat");
	assert.equal(readLayer("global")?.defaultChatType, 2);
	assert.match(ui.notices.at(-1)!, /^已保存全局配置：/);
	assert.match(ui.notices.at(-1)!, /配置不等于接入，需要时运行 \/wecom-aibot connect/);
	assert.equal(a.state.sent.length + b.state.sent.length, 0, "the identifying message is not a pi task");
	await until(() => server.gateway.size === 1, "temporary A registration disposed");
	assert.equal(a.ready(), false);
	assert.equal(b.ready(), true);
});

test("config whoami honours --wait; Esc keeps the configuration and the connection, and retires the code", async () => {
	const { a } = await pair();
	const ui = dialogs(a, { answer: /发给机器人/ });
	const before = await readFile(CONFIG_FILE, "utf8");
	await a.command("config --scope global whoami --wait 120");
	assert.match(ui.titles[0], /最多 120 秒$/, "the wait uses --wait");
	assert.match(ui.notices.at(-1)!, /已取消 whoami/);
	assert.equal(ui.confirms.length, 0);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
	assert.equal(a.ready(), true, "cancelling whoami keeps the formal registration");
	// The cancel reached the gateway before this acknowledged send: the old code identifies nothing now.
	await a.notification({ chatid: "user", content: "barrier" });
	chatMessage({ text: { content: ui.codes[0] } });
	inbound("session-A", "task after cancel");
	await until(() => a.state.sent.length === 1, "task routed after whoami was cancelled");
	const receipts = FakeWebSocket.instances[0].sent.filter((frame) => frame.cmd === "aibot_respond_msg");
	assert.ok(receipts.every((frame) => !/whoami 已识别/.test(frame.body.stream?.content ?? "")));
});

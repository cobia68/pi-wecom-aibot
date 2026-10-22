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
				if (["aibot_subscribe", "aibot_send_msg", "aibot_respond_msg", "ping"].includes(frame.cmd))
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
	assert.equal(pushes.length, 2);
	assert.match(
		pushes[0].body.markdown.content,
		/project-B.*\n🏷️ provider-B · Model B.*\n🆔 session: session-B\n\nRESULT-B$/,
	);
	assert.match(
		pushes[1].body.markdown.content,
		/project-A.*\n🏷️ provider-A · Model A.*\n🆔 session: session-A\n\nRESULT-A$/,
	);
	await until(
		() =>
			FakeWebSocket.instances[0].sent.filter(
				(frame) => frame.cmd === "aibot_respond_msg" && frame.body.stream.finish === true,
			).length === 2,
		"both status messages close",
	);
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
	assert.match(
		pushes[0].body.markdown.content,
		/project-B.*\n🏷️ provider-B · Model B.*\n🆔 session: session-B\n\nFROZEN-B-RESULT$/,
	);
	assert.doesNotMatch(pushes[0].body.markdown.content, /UNRELATED|unrelated/);
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
	assert.match(push.body.markdown.content, /session: session-B\n\nB unaffected$/);
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
	assert.match(notices.at(-1)!, /当前 pi：未连接/);
	assert.equal(server.gateway.size, 2);
	c.state.sessionId = "session-C";
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

/** Dialogs: whoami's wait stays open until it closes itself; `answer` picks the cancel option for matching titles, `menu` a setup menu entry. */
function dialogs(
	pi: ReturnType<typeof piHarness>,
	options: { answer?: RegExp; inputs?: (string | undefined)[]; menu?: RegExp } = {},
) {
	const ui = {
		titles: [] as string[],
		prompts: [] as string[],
		notices: [] as string[],
		confirms: [] as string[],
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
			if (/等待你/.test(title)) opened();
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

test("/wecom-aibot whoami identifies the sender's chat, saves it as the default after confirmation and routes nothing", async () => {
	const { a, b } = await pair();
	const ui = dialogs(a);
	const running = a.command("whoami");
	await ui.waiting;
	// An acknowledged send orders this test after the watch request on A's IPC channel, like a human's delay.
	await a.notification({ chatid: "user", content: "barrier" });
	chatMessage({ from: { userid: "user_one" }, chattype: "group", chatid: "group_chat", text: { content: "@bot hi" } });
	await running;
	assert.deepEqual(ui.titles, ["等待你给机器人发消息（群聊需 @机器人），最多 120 秒"]);
	assert.match(ui.confirms[0], /chatid=group_chat　chat_type=2　userid=user_one/);
	assert.equal(readLayer("global")?.defaultChatId, "group_chat");
	assert.equal(readLayer("global")?.defaultChatType, 2);
	assert.match(ui.notices.at(-1)!, /全局默认推送目标已保存：group_chat（群聊）。当前接入仍使用旧目标/);
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

test("offline whoami identifies through a hidden temporary registration and never formally connects", async () => {
	const { a, b } = await pair();
	await a.command("disconnect");
	await until(() => server.gateway.size === 1, "A disconnected");
	const ui = dialogs(a);
	const running = a.command("whoami");
	await ui.waiting;
	await b.notification({ chatid: "user", content: "barrier" });
	await until(() => server.gateway.size === 2, "temporary identity registration plus B");
	await assert.rejects(a.notification({ chatid: "user", content: "must not push" }), /未正式接入/);
	chatMessage({ from: { userid: "user_one" }, chattype: "group", chatid: "group_chat", text: { content: "@bot hi" } });
	await running;
	assert.equal(ui.confirms.length, 1);
	assert.match(ui.confirms[0], /chatid=group_chat　chat_type=2　userid=user_one/);
	assert.equal(readLayer("global")?.defaultChatId, "group_chat");
	assert.equal(readLayer("global")?.defaultChatType, 2);
	assert.match(ui.notices.at(-1)!, /全局默认推送目标已保存：group_chat（群聊）。尚未正式接入/);
	assert.equal(a.state.sent.length + b.state.sent.length, 0, "the identifying message is not a pi task");
	await until(() => server.gateway.size === 1, "temporary A registration disposed");
	assert.equal(a.ready(), false);
	assert.equal(b.ready(), true);
});

test("whoami honours --wait; Esc keeps the configuration and the connection, and releases the next message", async () => {
	const { a } = await pair();
	const ui = dialogs(a, { answer: /等待你/ });
	const before = await readFile(CONFIG_FILE, "utf8");
	await a.command("whoami --wait 300");
	assert.ok(ui.titles.includes("等待你给机器人发消息（群聊需 @机器人），最多 300 秒"), "the wait uses --wait");
	assert.match(ui.notices.at(-1)!, /已取消 whoami/);
	assert.equal(ui.confirms.length, 0);
	assert.equal(await readFile(CONFIG_FILE, "utf8"), before);
	assert.equal(a.ready(), true, "cancelling whoami keeps the formal registration");
	// The watch was released: A receives a new task.
	await a.notification({ chatid: "user", content: "barrier" });
	inbound("session-A", "task after cancel");
	await until(() => a.state.sent.length === 1, "task routed after whoami was cancelled");
});

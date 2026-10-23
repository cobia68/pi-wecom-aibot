import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatewayClientOptions } from "../../src/extension/gateway-client.ts";
import { DeliveryError } from "../../src/shared/delivery.ts";
import type { BridgeClient, ChatIdentity } from "../../src/shared/gateway-protocol.ts";
import type { GatewayNotification } from "../../src/shared/notification-types.ts";
import type { ChatRef } from "../../src/shared/wecom-protocol.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-wecom-connect-test-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
const { default: extension } = await import("../../src/extension/index.ts");
const { CONFIG_FILE, readLayer, writeLayer } = await import("../../src/extension/config.ts");
const config = { botId: "bot", secret: "secret", defaultChatId: "old-user", defaultChatType: 1 as const };
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let cleanup: (() => Promise<void>)[];

async function flush(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness() {
	const handlers = new Map<string, Handler[]>();
	const clients: ReturnType<typeof controlledClient>[] = [];
	const tools = new Map<string, any>();
	const notices: string[] = [];
	const confirms: string[] = [];
	let confirming: (message: string) => Promise<boolean> = async () => true;
	let cancelWaiting = false;
	let command!: (input: string, ctx: ExtensionContext) => Promise<void>;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		cwd: directory,
		isIdle: () => true,
		model: { id: "model", name: "Model", provider: "provider" },
		sessionManager: {
			getSessionId: () => "session-connect",
			getHeader: () => null,
			getBranch: () => [],
			getLeafId: () => null,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			async confirm(_title: string, message: string) {
				confirms.push(message);
				return confirming(message);
			},
			select(_title: string, _choices: string[], options: { signal: AbortSignal }) {
				if (cancelWaiting) return Promise.resolve(undefined);
				return new Promise<undefined>((resolve) =>
					options.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
				);
			},
		},
	} as unknown as ExtensionContext;
	function controlledClient(options: GatewayClientOptions) {
		let ready = false;
		let finishIdentity: ((error?: Error, value?: ChatIdentity) => void) | undefined;
		const pushes: { chat: ChatRef; notification: GatewayNotification }[] = [];
		const control = {
			options,
			pushes,
			stops: [] as string[],
			failure: undefined as Error | undefined,
			watching: () => finishIdentity !== undefined,
			identify(identity: ChatIdentity) {
				finishIdentity?.(undefined, identity);
			},
			publish(canSend = true) {
				ready = canSend;
				options.onStatus?.({
					state: canSend ? "subscribed" : "disconnected",
					sessions: options.identifyOnly ? 0 : 1,
				});
			},
			client: undefined as unknown as BridgeClient,
		};
		control.client = {
			start() {
				options.onState?.("connecting");
			},
			stop(reason = "stopped") {
				control.stops.push(reason);
				ready = false;
				finishIdentity?.(new Error(reason));
				options.onState?.("disconnected", reason);
			},
			isReady: () => ready,
			resume() {},
			updateSource() {},
			respond() {},
			taskStatus: () => ready,
			async notify(chat, notification) {
				pushes.push({ chat, notification });
				if (control.failure) throw control.failure;
			},
			watchIdentity(timeout, signal, onCode) {
				return new Promise((resolve, reject) => {
					const timer = setTimeout(
						() => finish(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
						timeout,
					);
					const abort = () => finish(Object.assign(new Error("cancelled"), { name: "AbortError" }));
					const finish = (error?: Error, identity?: ChatIdentity) => {
						finishIdentity = undefined;
						clearTimeout(timer);
						signal?.removeEventListener("abort", abort);
						if (error) reject(error);
						else resolve(identity!);
					};
					finishIdentity = finish;
					signal?.addEventListener("abort", abort, { once: true });
					onCode?.("123456");
				});
			},
		};
		return control;
	}
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(_name: string, options: { handler: typeof command }) {
			command = options.handler;
		},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		sendUserMessage() {
			assert.fail("configuration must not dispatch pi tasks");
		},
	} as unknown as ExtensionAPI;
	extension(pi, {
		createClient: (options) => {
			const client = controlledClient(options);
			clients.push(client);
			return client.client;
		},
	});
	async function emit(name: string) {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	}
	cleanup.push(() => emit("session_shutdown"));
	return {
		ctx,
		clients,
		notices,
		confirms,
		emit,
		command: (text: string) => command(text, ctx),
		confirmWith: (answer: (message: string) => Promise<boolean>) => {
			confirming = answer;
		},
		cancelWait: () => {
			cancelWaiting = true;
		},
		push: () => tools.get("wecom_send").execute("send", { content: "test" }, undefined, undefined, ctx),
	};
}

beforeEach(() => {
	cleanup = [];
	writeLayer("global", config);
});
afterEach(async () => {
	for (const stop of cleanup) await stop();
});
after(() => {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	rmSync(directory, { recursive: true, force: true });
});

async function connected(h: ReturnType<typeof harness>) {
	await h.emit("session_start");
	await h.command("connect");
	const c = h.clients[0];
	c.publish();
	await flush();
	return c;
}

test("connect requires a default target but never requires having identified one", async () => {
	writeLayer("global", { botId: "bot", secret: "secret" });
	const h = harness();
	await h.emit("session_start");
	await h.command("connect");
	assert.equal(h.clients.length, 0);
	assert.match(h.notices.at(-1)!, /默认推送目标.*config --scope <global\|session> whoami/);
	writeLayer("global", config);
	await h.command("connect");
	assert.equal(h.clients.length, 1, "a manually configured target is sufficient");
});

test("a connection entry waits for readiness and is sent once across repeated connect and automatic recovery", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("connect");
	const c = h.clients[0];
	assert.equal(c.pushes.length, 0);
	c.publish();
	await flush();
	assert.equal(c.pushes.length, 1);
	assert.equal(c.pushes[0].notification.kind, "connect");
	assert.equal(c.pushes[0].notification.source.sessionId, "session-connect");
	assert.equal(c.pushes[0].chat.chatId, "old-user");
	assert.match(c.pushes[0].notification.text, /引用本条消息/);
	await h.command("connect");
	c.publish(false);
	c.publish();
	await flush();
	assert.equal(c.pushes.length, 1);
	assert.equal(h.clients.length, 1);
});

for (const outcome of ["rejected", "unknown"] as const) {
	test(`a ${outcome} connection entry never disconnects the bridge or automatically resends`, async () => {
		const h = harness();
		await h.emit("session_start");
		await h.command("connect");
		const c = h.clients[0];
		c.failure = new DeliveryError("entry failed", outcome);
		c.publish();
		await flush();
		assert.equal(c.client.isReady(), true);
		assert.equal(c.stops.length, 0);
		c.failure = undefined;
		c.publish(false);
		c.publish();
		await flush();
		assert.equal(c.pushes.length, 1);
	});
}

test("a known-unsent connection entry is retained and delivered after recovery", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("connect");
	const c = h.clients[0];
	c.failure = new DeliveryError("offline", "not_sent");
	c.publish();
	await flush();
	c.failure = undefined;
	c.publish(false);
	c.publish();
	await flush();
	assert.equal(c.pushes.length, 2);
	assert.deepEqual(c.pushes[1], c.pushes[0], "retry uses the exact frozen notification");
});

test("config with a manual target saves configuration without creating a client or entry", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("config --scope global set defaultChatId=new-user");
	assert.equal(h.clients.length, 0);
	assert.equal(readLayer("global")?.defaultChatId, "new-user");
	assert.match(h.notices.at(-1)!, /配置不等于接入.*\/wecom-aibot connect/);
});

test("offline config whoami uses a temporary registration then closes it without sending an entry", async () => {
	writeLayer("global", { botId: "bot", secret: "secret" });
	const h = harness();
	await h.emit("session_start");
	const pending = h.command("config --scope global whoami");
	const c = h.clients[0];
	assert.equal(c.options.identifyOnly, true);
	c.publish();
	await flush();
	assert.equal(c.watching(), true);
	await h.command("connect");
	assert.equal(h.clients.length, 1);
	assert.match(h.notices.at(-1)!, /config whoami 正在识别聊天/);
	await assert.rejects(h.push(), /缺少 chatid|未正式接入/);
	c.identify({ chatId: "group", chatType: 2, userid: "user" });
	await pending;
	assert.equal(readLayer("global")?.defaultChatId, "group");
	assert.equal(c.stops.length, 1);
	assert.equal(c.pushes.length, 0);
	assert.equal(c.client.isReady(), false);
	await h.command("connect");
	assert.equal(h.clients.length, 2);
	assert.equal(h.clients[1].options.identifyOnly, false);
});

test("cancelling an offline config whoami closes its temporary connection without touching configuration", async () => {
	const h = harness();
	await h.emit("session_start");
	h.cancelWait();
	await h.command("config --scope global whoami");
	assert.equal(h.clients.length, 1);
	assert.equal(h.clients[0].stops.length, 1);
	assert.equal(readLayer("global")?.defaultChatId, "old-user");
	assert.match(h.notices.at(-1)!, /已取消 whoami/);
});

test("a target change during reconnect confirmation is not applied to the live session", async () => {
	const h = harness();
	const c = await connected(h);
	writeLayer("global", { ...config, defaultChatId: "new-user" });
	h.confirmWith(async () => {
		writeLayer("global", { ...config, defaultChatId: "changed-again" });
		return true;
	});
	await h.command("connect");
	assert.equal(c.stops.length, 0);
	assert.equal(h.clients.length, 1);
	await h.push();
	assert.equal(c.pushes.at(-1)!.chat.chatId, "old-user");
	assert.match(h.notices.at(-1)!, /确认期间再次改变/);
});

test("replacing the registration during the confirmation saves the target and never disconnects the replacement", async () => {
	const h = harness();
	const c = await connected(h);
	h.confirmWith(async () => {
		await h.command("disconnect");
		await h.command("connect");
		h.clients[1].publish();
		return true;
	});
	const pending = h.command("config --scope global whoami");
	await flush();
	c.identify({ chatId: "new-user", chatType: 1, userid: "user" });
	await pending;
	// The chat was identified with the same bot: the new registration does not make it stale.
	assert.equal(readLayer("global")?.defaultChatId, "new-user");
	assert.equal(h.clients[1].stops.length, 0);
	assert.equal(h.clients[1].client.isReady(), true);
});

test("config whoami timeout disposes a temporary connection and does not change configuration", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	await h.emit("session_start");
	const pending = h.command("config --scope global whoami --wait 10");
	const c = h.clients[0];
	c.publish();
	await flush();
	t.mock.timers.tick(10_000);
	await pending;
	assert.equal(c.stops.length, 1);
	assert.equal(readLayer("global")?.defaultChatId, "old-user");
	assert.match(h.notices.at(-1)!, /10 秒内没有收到验证码/);
});

for (const changed of [false, true]) {
	test(`config whoami ${changed ? "saves a changed target that waits for connect" : "with an unchanged target changes nothing"}`, async () => {
		const h = harness();
		const c = await connected(h);
		const pending = h.command("config --scope global whoami");
		await flush();
		c.identify({ chatId: changed ? "new-user" : "old-user", chatType: 1, userid: "user" });
		await pending;
		assert.equal(c.stops.length, 0, "saving a target never disconnects");
		assert.equal(readLayer("global")?.defaultChatId, changed ? "new-user" : "old-user");
		assert.equal(c.pushes.length, 1, "whoami never sends an extra entry");
		if (changed) {
			assert.match(h.confirms[0], /保存不会断开当前接入/);
			assert.match(h.notices.at(-1)!, /当前接入仍使用旧配置，运行 \/wecom-aibot connect 后生效/);
			assert.match(h.notices.at(-1)!, /未配置 allowedUserIds/, "the allowlist note joins the report");
			await h.push();
			assert.equal(c.pushes.at(-1)!.chat.chatId, "old-user", "the registration keeps its target until connect");
		} else {
			assert.deepEqual(h.confirms, []);
			assert.match(h.notices.at(-1)!, /这已经是全局的默认推送目标/);
		}
	});
}

test("declining a target change keeps the original target and live registration", async () => {
	const h = harness();
	const c = await connected(h);
	h.confirmWith(async () => false);
	const before = readFileSync(CONFIG_FILE, "utf8");
	const pending = h.command("config --scope global whoami");
	await flush();
	c.identify({ chatId: "new-user", chatType: 1, userid: "user" });
	await pending;
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), before);
	assert.equal(c.stops.length, 0);
	assert.equal(c.client.isReady(), true);
});

test("a failed target save keeps the old live registration", async () => {
	const h = harness();
	const c = await connected(h);
	h.confirmWith(async () => {
		writeLayer("global", { ...config, secret: "changed-during-confirmation" });
		return true;
	});
	const pending = h.command("config --scope global whoami");
	await flush();
	c.identify({ chatId: "new-user", chatType: 1, userid: "user" });
	await pending;
	assert.equal(c.stops.length, 0);
	assert.equal(c.client.isReady(), true);
	assert.equal(readLayer("global")?.defaultChatId, "old-user");
	assert.match(h.notices.at(-1)!, /配置已改变/);
});

test("a hand-edited target is not silently hot-reloaded when reconnection is declined", async () => {
	const h = harness();
	const c = await connected(h);
	writeLayer("global", { ...config, defaultChatId: "new-user" });
	h.confirmWith(async () => false);
	await h.command("connect");
	assert.equal(c.stops.length, 0);
	await h.push();
	assert.equal(c.pushes.at(-1)!.chat.chatId, "old-user");
	h.confirmWith(async () => true);
	await h.command("connect");
	assert.equal(c.stops.length, 1);
	assert.equal(h.clients.length, 2);
	h.clients[1].publish();
	await flush();
	assert.equal(h.clients[1].pushes[0].chat.chatId, "new-user");
});

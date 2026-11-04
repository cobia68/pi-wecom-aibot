import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatewayClientOptions } from "../../src/extension/gateway-client.ts";
import { controlKey } from "../../src/shared/control-card.ts";
import { DeliveryError } from "../../src/shared/delivery.ts";
import type { BridgeClient, ChatIdentity, PushItem } from "../../src/shared/gateway-protocol.ts";
import type { GatewayNotification } from "../../src/shared/notification-types.ts";
import type { ChatRef } from "../../src/shared/wecom-protocol.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-wecom-connect-test-"));
const previousDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
const { default: extension } = await import("../../src/extension/index.ts");
const { CONFIG_FILE, SESSIONS_DIR, layerFile, readLayer, writeLayer } = await import("../../src/extension/config.ts");
const config = { botId: "bot", secret: "secret", defaultChatId: "old-user", defaultChatType: 1 as const };
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let cleanup: (() => Promise<void>)[];

async function flush(): Promise<void> {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function harness(entries: unknown[] = []) {
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
			getBranch: () => entries,
			getEntries: () => entries,
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
		const controls: { chat: ChatRef; item: Extract<PushItem, { kind: "control" }> }[] = [];
		const control = {
			options,
			pushes,
			controls,
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
			async push(chat, item) {
				if (item.kind === "control") controls.push({ chat, item });
				if (control.failure) throw control.failure;
			},
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
		registerEntryRenderer() {},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
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
	async function emit(name: string, event: Record<string, unknown> = {}) {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	}
	cleanup.push(() => emit("session_shutdown"));
	return {
		ctx,
		entries,
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
	rmSync(SESSIONS_DIR, { recursive: true, force: true });
	rmSync(layerFile({ project: directory }), { force: true });
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

for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
	test(`autoConnect opts a ${reason} session in, without waiting for readiness or inheriting a connection`, async () => {
		writeLayer("global", { ...config, autoConnect: true, allowedUserIds: ["trusted-user"] });
		const saved = readFileSync(CONFIG_FILE, "utf8");
		const h = harness();
		assert.equal(h.clients.length, 0, "loading the extension alone never opens a connection");
		await h.emit("session_start", { reason });
		assert.equal(h.clients.length, 1);
		const c = h.clients[0];
		assert.equal(c.options.identifyOnly, false);
		assert.deepEqual(c.options.config.allowedUserIds, ["trusted-user"]);
		assert.equal(c.controls.length, 0, "session startup does not wait for the network");
		c.publish();
		await flush();
		assert.equal(c.controls.length, 1);
		assert.equal(c.controls[0].chat.chatId, "old-user");
		c.publish(false);
		c.publish();
		await flush();
		assert.equal(c.controls.length, 1, "network recovery does not repeat the startup card");
		assert.deepEqual(h.confirms, [], "the saved opt-in needs no interactive confirmation");
		assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved);
	});
}

test("autoConnect=false still permits manual connect, and queries or agent events never opt in", async () => {
	writeLayer("global", { ...config, autoConnect: false });
	const h = harness();
	await h.emit("session_start");
	await h.command("status");
	await h.command("config show");
	await h.emit("model_select");
	await h.emit("agent_start");
	assert.equal(h.clients.length, 0);
	await h.command("connect");
	assert.equal(h.clients.length, 1);
});

for (const [global, project, session, expected] of [
	[true, false, undefined, false],
	[false, true, undefined, true],
	[false, true, false, false],
	[true, false, true, true],
] as const) {
	test(`autoConnect startup resolves global=${global}, project=${project}, session=${session} to ${expected}`, async () => {
		writeLayer("global", { ...config, autoConnect: global });
		writeLayer({ project: directory }, { autoConnect: project });
		if (session !== undefined) writeLayer({ session: "session-connect" }, { autoConnect: session });
		const h = harness();
		await h.emit("session_start");
		assert.equal(h.clients.length, expected ? 1 : 0);
	});
}

for (const autoConnect of [false, true]) {
	test(`an untrusted project's autoConnect cannot override the global ${autoConnect}`, async () => {
		writeLayer("global", { ...config, autoConnect });
		writeLayer({ project: directory }, { autoConnect: !autoConnect });
		const h = harness();
		Object.assign(h.ctx, { isProjectTrusted: () => false });
		await h.emit("session_start");
		assert.equal(h.clients.length, autoConnect ? 1 : 0);
	});

	test(`a fork snapshots autoConnect=${autoConnect} from its parent, including on a later resume`, async () => {
		writeLayer("global", { ...config, autoConnect: !autoConnect });
		writeLayer({ session: "parent-connect" }, { autoConnect });
		const parentSession = join(directory, "parent.jsonl");
		writeFileSync(parentSession, `${JSON.stringify({ type: "session", id: "parent-connect" })}\n`);
		const h = harness();
		Object.assign(h.ctx.sessionManager, { getHeader: () => ({ parentSession }) });
		await h.emit("session_start", { reason: "fork" });
		assert.equal(h.clients.length, autoConnect ? 1 : 0);
		assert.deepEqual(readLayer({ session: "session-connect" }), { autoConnect });
		writeLayer({ session: "parent-connect" }, { autoConnect: !autoConnect });
		await h.emit("session_shutdown");
		const restored = harness([...h.entries]);
		Object.assign(restored.ctx.sessionManager, { getHeader: () => ({ parentSession }) });
		await restored.emit("session_start", { reason: "resume" });
		assert.equal(restored.clients.length, autoConnect ? 1 : 0, "a resume does not copy the parent again");
	});
}

for (const [name, raw, problem] of [
	["missing credentials", JSON.stringify({ autoConnect: true }), /尚未配置机器人凭据/],
	["missing target", JSON.stringify({ botId: "bot", secret: "secret", autoConnect: true }), /默认推送目标未配置/],
	["invalid boolean", JSON.stringify({ ...config, autoConnect: "true" }), /autoConnect 无效/],
	["broken JSON", "{ broken", /不是有效的 JSON/],
] as const) {
	test(`autoConnect never registers with ${name}; repairing configuration still waits for connect`, async () => {
		writeFileSync(CONFIG_FILE, raw);
		const h = harness();
		await h.emit("session_start");
		assert.equal(h.clients.length, 0);
		assert.match(h.notices.at(-1)!, problem);
		writeLayer("global", { ...config, autoConnect: true });
		await h.command("status");
		assert.equal(h.clients.length, 0, "configuration reads are not startup attempts");
		await h.command("connect");
		assert.equal(h.clients.length, 1);
	});
}

test("manual disconnect wins over autoConnect until connect or the next session startup", async () => {
	writeLayer("global", { ...config, autoConnect: true });
	const saved = readFileSync(CONFIG_FILE, "utf8");
	const h = harness();
	await h.emit("session_start");
	const c = h.clients[0];
	c.publish();
	await flush();
	await h.command("disconnect");
	assert.deepEqual(c.stops, ["disconnected by user"]);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved, "disconnect never persists an opt-out");
	for (const event of ["model_select", "agent_start", "agent_settled"]) await h.emit(event);
	await h.command("config set autoConnect=false");
	await h.command("config set autoConnect=true");
	await h.command("status");
	c.publish();
	await flush();
	assert.equal(h.clients.length, 1, "neither config saves nor late callbacks revive a disconnected session");
	assert.equal(c.controls.length, 1);
	await assert.rejects(h.push(), /缺少 chatid|未正式接入/);
	await h.command("connect");
	assert.equal(h.clients.length, 2, "manual connect can resume immediately");
	await h.command("disconnect");
	await h.emit("session_shutdown", { reason: "reload" });
	const reloaded = harness([...h.entries]);
	await reloaded.emit("session_start", { reason: "reload" });
	assert.equal(reloaded.clients.length, 1, "reload reevaluates the saved opt-in, not the previous connection state");
});

test("changing autoConnect does not disconnect a live session or change network recovery", async () => {
	const h = harness();
	const c = await connected(h);
	for (const autoConnect of [true, false]) {
		await h.command(`config set autoConnect=${autoConnect}`);
		assert.match(h.notices.at(-1)!, /autoConnect.*下次会话启动.*当前接入状态不变/);
		assert.doesNotMatch(h.notices.at(-1)!, /热更新|待重新接入/);
	}
	c.publish(false);
	c.publish();
	await flush();
	assert.equal(h.clients.length, 1);
	assert.deepEqual(c.stops, []);
	assert.equal(c.controls.length, 1);
	await h.push();
	assert.equal(c.pushes.at(-1)!.chat.chatId, "old-user");
});

test("autoConnect does not restart a failed registration outside session startup", async () => {
	writeLayer("global", { ...config, autoConnect: true });
	const h = harness();
	await h.emit("session_start");
	h.clients[0].options.onError?.("registration rejected");
	await h.emit("model_select");
	await h.command("status");
	assert.equal(h.clients.length, 1);
	assert.match(h.notices.at(-1)!, /已停止.*registration rejected/);
	await h.command("connect");
	assert.equal(h.clients.length, 2);
});

test("a replacement session uses its own autoConnect override rather than the old registration", async () => {
	writeLayer("global", { ...config, autoConnect: true });
	writeLayer({ session: "replacement" }, { autoConnect: false });
	const h = harness();
	await h.emit("session_start");
	const c = h.clients[0];
	c.publish();
	await h.emit("session_shutdown", { reason: "new" });
	Object.assign(h.ctx.sessionManager, { getSessionId: () => "replacement" });
	await h.emit("session_start", { reason: "new" });
	assert.deepEqual(c.stops, ["session shutdown"]);
	assert.equal(h.clients.length, 1);
	await h.command("connect");
	assert.equal(h.clients.length, 2);
});

test("config edit offers autoConnect in every scope and can remove an explicit override without connecting", async () => {
	const h = harness();
	await h.emit("session_start");
	const picks: RegExp[] = [];
	Object.assign(h.ctx.ui, {
		async select(_title: string, choices: string[]) {
			const wanted = picks.shift();
			const picked = wanted && choices.find((choice) => wanted.test(choice));
			assert.ok(picked, `missing choice ${wanted}: ${choices.join(" | ")}`);
			return picked;
		},
	});
	for (const [scope, autoConnect] of [
		["global", true],
		["project", false],
		["session", true],
	] as const) {
		picks.push(/^自动接入：/, new RegExp(`^${autoConnect}：`));
		await h.command(`config --scope ${scope} edit`);
		const target =
			scope === "global" ? "global" : scope === "project" ? { project: directory } : { session: "session-connect" };
		assert.equal(readLayer(target)?.autoConnect, autoConnect);
		assert.match(h.notices.at(-1)!, /autoConnect.*下次会话启动/);
	}
	picks.push(/^自动接入：/, /^取消覆盖/);
	await h.command("config --scope session edit");
	assert.equal(readLayer({ session: "session-connect" })?.autoConnect, undefined);
	await h.command("config show");
	assert.match(h.notices.at(-1)!, /autoConnect\s+false（项目级）/);
	assert.equal(h.clients.length, 0);
});

test("config show uses character order without reordering saved keys or user lists", async () => {
	writeLayer("global", {
		...config,
		notificationScope: "all-runs",
		controlPrompts: ["z", "a"],
		allowedUserIds: ["z-user", "a-user"],
		autoConnect: false,
	});
	writeLayer({ project: directory }, { notificationScope: "wecom-tasks", autoConnect: false });
	writeLayer({ session: "session-connect" }, { defaultChatId: "session-user", contentDisplay: "inline" });
	const files = [CONFIG_FILE, layerFile({ project: directory }), layerFile({ session: "session-connect" })];
	const saved = files.map((file) => readFileSync(file, "utf8"));
	const h = harness();
	await h.emit("session_start");
	for (const command of [
		"config show",
		"config --scope global show",
		"config --scope project show",
		"config --scope session show",
	]) {
		await h.command(command);
		const names = [...h.notices.at(-1)!.matchAll(/^ {2}([a-zA-Z]+) {2,}/gm)].map((match) => match[1]);
		assert.ok(names.length >= 2);
		assert.deepEqual(names, [...names].sort(), command);
	}
	await h.command("config show");
	assert.match(h.notices.at(-1)!, /controlPrompts\s+「z」、「a」/);
	assert.match(h.notices.at(-1)!, /allowedUserIds\s+z-user、a-user/);
	assert.deepEqual(
		files.map((file) => readFileSync(file, "utf8")),
		saved,
	);
	assert.equal(h.clients.length, 0);
});

test("config edit sorts field groups by their first identifier while credentials and the target remain paired", async () => {
	const h = harness();
	await h.emit("session_start");
	let menu: string[] = [];
	Object.assign(h.ctx.ui, {
		async select(_title: string, choices: string[]) {
			menu = choices;
			return undefined;
		},
	});
	for (const scope of ["global", "project", "session"]) {
		await h.command(`config --scope ${scope} edit`);
		assert.deepEqual(
			menu.map((item) => item.split("：")[0]),
			[
				"自动接入",
				"机器人凭据",
				"正文展示方式",
				"控制卡提示词",
				"默认推送目标",
				...(scope === "global" ? ["会话文档"] : []),
				"自动结束通知范围",
			],
		);
		assert.match(menu[1], /BotID.*Secret/);
		assert.match(menu[4], /old-user.*1（单聊）/);
	}
	assert.equal(h.clients.length, 0);
});

test("connect requires a default target but never requires having identified one", async () => {
	writeLayer("global", { botId: "bot", secret: "secret" });
	const h = harness();
	await h.emit("session_start");
	await h.command("connect");
	assert.equal(h.clients.length, 0);
	assert.match(h.notices.at(-1)!, /默认推送目标.*config --scope <global\|project\|session> whoami/);
	writeLayer("global", config);
	await h.command("connect");
	assert.equal(h.clients.length, 1, "a manually configured target is sufficient");
});

test("a session control waits for readiness, is reused by automatic recovery, and is sent again by every connect", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("connect");
	const c = h.clients[0];
	assert.equal(c.controls.length, 0);
	c.publish();
	await flush();
	assert.equal(c.controls.length, 1);
	const card = c.controls[0].item.card;
	assert.equal(card.label, "空闲");
	assert.equal(card.quote, "点「刷新卡片」读取画面", "no terminal to read and no document");
	assert.equal(card.subtitle, "🆔 session-id: session-connect");
	assert.deepEqual(
		card.actions.map((action) => action.key),
		["refresh", "send", "model", "abort"].map((action) => controlKey(action as "refresh", "session-connect")),
		"no prompts configured; each key names the session",
	);
	assert.equal(c.controls[0].chat.chatId, "old-user");
	c.publish(false);
	c.publish();
	await flush();
	assert.equal(c.controls.length, 1, "automatic recovery reuses the card");
	await h.command("connect");
	await flush();
	assert.equal(c.controls.length, 2, "every connect publishes a new one");
	assert.notEqual(c.controls[1].item.cardId, c.controls[0].item.cardId);
	assert.equal(h.clients.length, 1);
});

for (const outcome of ["rejected", "unknown"] as const) {
	test(`a ${outcome} control card never disconnects the bridge or automatically resends`, async () => {
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
		assert.equal(c.controls.length, 1);
	});
}

test("a known-unsent control card is retained and delivered after recovery", async () => {
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
	assert.equal(c.controls.length, 2);
	assert.equal(c.controls[1].item.cardId, c.controls[0].item.cardId, "a definitely unwritten card retains its ID");
	assert.equal(c.controls[1].item.card.quote, c.controls[0].item.card.quote);
});

test("control receipts never restore connection consent, and each connect after disconnect or restore sends a new card", async () => {
	const h = harness();
	const first = await connected(h);
	assert.equal(first.controls.length, 1);
	await h.command("disconnect");
	await h.command("connect");
	h.clients[1].publish();
	await flush();
	assert.equal(h.clients[1].controls.length, 1, "connect after disconnect publishes a new card");
	assert.notEqual(h.clients[1].controls[0].item.cardId, first.controls[0].item.cardId);
	await h.emit("session_shutdown");
	const restored = harness([...h.entries]);
	await restored.emit("session_start");
	assert.equal(restored.clients.length, 0, "a receipt is not consent to reconnect");
	await restored.command("connect");
	restored.clients[0].publish();
	await flush();
	assert.equal(restored.clients[0].controls.length, 1);
	restored.clients[0].publish(false);
	restored.clients[0].publish();
	await flush();
	assert.equal(restored.clients[0].controls.length, 1, "automatic recovery reuses the card just sent");
});

test("a fork carrying its parent's journal creates its own independent control card", async () => {
	const parent = harness();
	const connectedParent = await connected(parent);
	const fork = harness([...parent.entries]);
	Object.assign(fork.ctx.sessionManager, { getSessionId: () => "session-fork" });
	const connectedFork = await connected(fork);
	assert.equal(connectedFork.controls.length, 1);
	assert.equal(connectedFork.controls[0].item.card.subtitle, "🆔 session-id: session-fork");
	assert.notEqual(connectedFork.controls[0].item.cardId, connectedParent.controls[0].item.cardId);
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
	assert.equal(c.controls.length, 0);
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
		assert.equal(c.controls.length, 1, "whoami never sends an extra control card");
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
	assert.equal(h.clients[1].controls[0].chat.chatId, "new-user");
});

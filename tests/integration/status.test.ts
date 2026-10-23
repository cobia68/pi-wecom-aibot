import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GatewayClientOptions } from "../../src/extension/gateway-client.ts";
import { FLASH_MS } from "../../src/extension/status.ts";
import type { BridgeClient, GatewayStatus } from "../../src/shared/gateway-protocol.ts";
import type { WeComState } from "../../src/shared/wecom-protocol.ts";
import { fixtureTheme, fixtureThemes } from "../support/tui-fixture.ts";

const sandbox = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-status-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../../src/extension/index.ts");
const { CONFIG_FILE, writeLayer, clearConfig } = await import("../../src/extension/config.ts");
const config = { botId: "private-bot-id", secret: "private-secret", defaultChatId: "private-user" };
const key = "wecom-aibot";
const theme = fixtureTheme("dark");
const label = (color: "success" | "warning" | "error") => theme.fg(color, "wecom-aibot");
type Handler = (event: any, ctx: ExtensionContext) => unknown;
let instances: { emit(name: string, event?: Record<string, unknown>): Promise<void> }[];

/** A controllable IPC seam: status metadata precedes state callbacks, just as in GatewayClient. */
function connection(options: GatewayClientOptions) {
	let ready = false;
	let state: WeComState = "disconnected";
	let detail: string | undefined;
	const stopped: (string | undefined)[] = [];
	const client: BridgeClient = {
		start() {
			state = "connecting";
			options.onState?.(state);
		},
		stop(reason) {
			stopped.push(reason);
			ready = false;
			state = "disconnected";
			detail = reason;
			options.onState?.(state, detail);
		},
		isReady: () => ready,
		updateSource() {},
		respond() {},
		resume() {},
		taskStatus: () => ready,
		async notify() {
			if (!ready) throw new Error("not connected");
		},
		async watchIdentity() {
			throw new Error("identity is not used by status tests");
		},
	};
	return {
		client,
		stopped,
		publish(status: GatewayStatus, canSend = status.state === "subscribed") {
			ready = canSend;
			options.onStatus?.(status);
			if (state === status.state && detail === status.detail) return;
			state = status.state;
			detail = status.detail;
			options.onState?.(state, detail);
		},
		fail(message: string) {
			ready = false;
			options.onError?.(message);
		},
	};
}

function harness(mode: ExtensionContext["mode"] = "tui") {
	const handlers = new Map<string, Handler[]>();
	const clients: ReturnType<typeof connection>[] = [];
	const statuses = new Map<string, string>([["another-extension", "Other status"]]);
	const changes: (string | undefined)[] = [];
	const notices: string[] = [];
	/** Dialogs: each select records its menu and takes the next queued pick (none = Esc); confirm takes the next answer. */
	const dialogs = {
		menus: [] as { title: string; options: string[] }[],
		picks: [] as (RegExp | undefined)[],
		confirms: 0,
		answers: [] as boolean[],
	};
	const state = { sessionId: `session-${instances.length}` };
	let command!: (input: string, ctx: ExtensionContext) => Promise<void>;
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: sandbox,
		isIdle: () => true,
		model: { id: "model", name: "Model", provider: "provider" },
		sessionManager: {
			getSessionId: () => state.sessionId,
			getHeader: () => null,
			getBranch: () => [],
			getLeafId: () => null,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			confirm: async () => {
				dialogs.confirms++;
				return dialogs.answers.shift() ?? true;
			},
			select: async (title: string, options: string[]) => {
				dialogs.menus.push({ title, options });
				const pick = dialogs.picks.shift();
				return pick && options.find((option) => pick.test(option));
			},
			getAllThemes: fixtureThemes,
			setWidget() {},
			setStatus(statusKey: string, text: string | undefined) {
				assert.equal(statusKey, key, "the extension owns only its status entry");
				changes.push(text);
				if (text === undefined) statuses.delete(statusKey);
				else statuses.set(statusKey, text);
			},
			setFooter() {
				assert.fail("must not replace the user's footer");
			},
			theme,
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			return () => {};
		},
		registerCommand(_name: string, options: { handler: typeof command }) {
			command = options.handler;
		},
		registerTool() {},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	extension(pi, {
		createClient(options) {
			const control = connection(options);
			clients.push(control);
			return control.client;
		},
	});
	const result = {
		ctx,
		state,
		clients,
		statuses,
		changes,
		notices,
		dialogs,
		command: (input: string) => command(input, ctx),
		async emit(name: string, event: Record<string, unknown> = {}) {
			for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
		},
	};
	instances.push(result);
	return result;
}

async function connect(h: ReturnType<typeof harness>) {
	await h.emit("session_start");
	await h.command("connect");
	assert.equal(h.clients.length, 1);
	return h.clients[0];
}

beforeEach(() => {
	instances = [];
	writeLayer("global", config);
});
afterEach(async () => {
	for (const instance of instances) await instance.emit("session_shutdown");
});
after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	assert.equal(dirname(sandbox), tmpdir());
	await rm(sandbox, { recursive: true, force: true });
});

test("a stored configuration never opts a session into receiving tasks; querying never connects", async () => {
	const saved = readFileSync(CONFIG_FILE, "utf8");
	const h = harness();
	assert.equal(h.clients.length, 0);
	await h.emit("session_start");
	assert.deepEqual(h.notices, [], "startup must not announce a connection");
	await h.command("status");
	await h.command("--help");
	await h.emit("model_select");
	await h.emit("agent_start");
	assert.equal(h.clients.length, 0, "the configuration cannot opt a session into receiving tasks");
	assert.deepEqual(h.changes, []);
	assert.match(h.notices[0], /^⚪ 企业微信智能机器人：未接入，每个 session 需运行 \/wecom-aibot connect\n/);
	assert.doesNotMatch(h.notices[0], /自动连接：开|已启动/);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved);
});

test("manual connect is silent and invisible until both registration and subscription are usable", async () => {
	const saved = readFileSync(CONFIG_FILE, "utf8");
	const h = harness();
	const client = await connect(h);
	assert.deepEqual(h.changes, [], "beginning registration must not show the footer label");
	assert.deepEqual(h.notices, [], "no static registering notice belongs in the transcript");
	client.publish({ state: "connected", sessions: 1 });
	assert.deepEqual(h.changes, [], "an open upstream socket is not ready");
	client.publish({ state: "subscribed", sessions: 1 }, false);
	assert.deepEqual(h.changes, [], "an unusable transport must not appear connected");
	client.publish({ state: "connecting", sessions: 1 });
	client.publish({ state: "subscribed", sessions: 1 });
	assert.deepEqual(h.changes, [label("success")]);
	assert.deepEqual(h.notices, [], "success is represented only in the footer");
	await h.command("connect");
	assert.equal(h.clients.length, 1, "repeated connect must retain the same registration");
	assert.deepEqual(h.changes, [label("success")]);
	assert.deepEqual(h.notices, [], "already connected must not announce that it is registering");
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved, "connect is session-local, not a configuration edit");
});

test("the footer stays empty when unconfigured; connect explains that configuration is needed", async () => {
	clearConfig();
	const h = harness();
	await h.emit("session_start");
	await h.command("--help");
	await h.command("connect");
	assert.equal(h.clients.length, 0);
	assert.deepEqual(h.changes, []);
	assert.match(h.notices.at(-1)!, /尚未配置.*\/wecom-aibot config edit --scope global/);
});

test("a saved connection change keeps the name green and adds a pending reconnection until connect", async () => {
	const h = harness();
	const client = await connect(h);
	client.publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
	await h.command("config set --scope global defaultChatId=new-user");
	assert.equal(h.statuses.get(key), `${label("success")}${theme.fg("warning", "（待重新接入）")}`);
	assert.equal(client.stopped.length, 0, "saving never disconnects");
	// A setting is no connection change: nothing waits for connect.
	await h.command("config set --scope global defaultChatId=private-user");
	await h.command("config set --scope session screenshotTheme=light");
	assert.equal(h.statuses.get(key), label("success"));
	await h.command("config set --scope global defaultChatId=new-user");
	await h.command("connect");
	assert.equal(h.clients.length, 2, "connect adopts the saved target with a new registration");
	h.clients[1].publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
});

test("metadata never changes the footer name or leaks connection details", async () => {
	const h = harness();
	const client = await connect(h);
	client.publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
	const count = h.changes.length;
	client.publish({ state: "subscribed", sessions: 99, detail: "private-secret\n\x1b[2Jprivate-chat" });
	await h.emit("model_select");
	assert.equal(h.changes.length, count);
	for (const text of h.changes) if (text !== undefined) assert.equal(stripVTControlCharacters(text), "wecom-aibot");
	assert.doesNotMatch(h.changes.join("\n"), /private|session-|\x1b\[2J/);
	client.publish({ state: "subscribed", sessions: 99 }, false);
	assert.equal(h.statuses.get(key), label("warning"), "an unusable transport must not appear green");
});

test("connection events change green to yellow or red, then back to green after recovery", async () => {
	const h = harness();
	const client = await connect(h);
	client.publish({ state: "subscribed", sessions: 1 });
	client.publish({ state: "disconnected", sessions: 1, detail: "outage" });
	assert.equal(h.statuses.get(key), label("warning"));
	client.publish({ state: "disconnected", sessions: 1, detail: "outage", stopped: true });
	assert.equal(h.statuses.get(key), label("error"), "the state callback need not run when only stopped changes");
	await h.command("connect");
	assert.equal(h.clients.length, 1, "resuming an upstream must not replace the local bridge");
	client.publish({ state: "connecting", sessions: 1 });
	assert.equal(h.statuses.get(key), label("warning"));
	client.publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
});

test("a refused first subscription explains the failure without installing a connection label", async () => {
	const h = harness();
	const client = await connect(h);
	client.publish({ state: "disconnected", sessions: 1, stopped: true, detail: "subscribe refused" });
	assert.deepEqual(h.changes, []);
	assert.ok(h.notices.some((message) => /subscribe refused.*\/wecom-aibot connect/.test(message)));
	await h.command("connect");
	client.publish({ state: "connecting", sessions: 1 });
	client.publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
	assert.ok(h.notices.every((message) => !/已通过共享网关|已恢复|正在向共享网关注册/.test(message)));
});

test("status names each connection state with its own icon, driven by the real session wiring", async () => {
	const h = harness();
	const client = await connect(h);
	const headline = async () => {
		await h.command("status");
		return h.notices.at(-1)!.split("\n")[0];
	};
	assert.equal(await headline(), "⏳ 企业微信智能机器人：正在连接");
	// Refused before any subscription: the footer has no label yet, the status still says why.
	client.publish({ state: "disconnected", sessions: 1, stopped: true, detail: "subscribe refused" });
	assert.equal(await headline(), "❌ 企业微信智能机器人：已停止（subscribe refused），运行 /wecom-aibot connect 恢复");
	await h.command("connect");
	client.publish({ state: "subscribed", sessions: 2 });
	assert.equal(await headline(), "✅ 企业微信智能机器人：已接入");
	assert.ok(h.notices.at(-1)!.split("\n").includes("  共享网关  2 个 pi 已注册"));
	client.publish({ state: "disconnected", sessions: 2, detail: "outage" });
	assert.equal(await headline(), "⏳ 企业微信智能机器人：正在重连（outage）");
	await h.command("disconnect");
	assert.equal(
		await headline(),
		"⚪ 企业微信智能机器人：未接入（已由用户断开），每个 session 需运行 /wecom-aibot connect",
	);
	await h.command("connect");
	h.clients[1].fail("registration rejected");
	assert.equal(
		await headline(),
		"❌ 企业微信智能机器人：已停止（registration rejected），运行 /wecom-aibot connect 恢复",
	);
});

test("a bare /wecom-aibot opens the subcommand menu under the connection state; Esc runs nothing", async () => {
	const saved = readFileSync(CONFIG_FILE, "utf8");
	const h = harness();
	await h.emit("session_start");
	await h.command("");
	assert.equal(h.dialogs.menus.length, 1);
	const [menu] = h.dialogs.menus;
	assert.equal(menu.title, "⚪ 企业微信智能机器人：未接入");
	assert.deepEqual(
		menu.options.map((option) => option.split(/ {2,}/)[0]),
		["status", "config", "connect", "disconnect", "test", "log", "reset", "--help"],
	);
	assert.deepEqual(h.notices, [], "Esc says nothing");
	assert.equal(h.clients.length, 0, "opening the menu never connects");
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved);
});

test("a menu choice runs exactly like the typed subcommand, confirmations included", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("status");
	const typed = h.notices.at(-1);
	h.dialogs.picks.push(/^status /);
	await h.command("");
	assert.equal(h.notices.at(-1), typed, "the same report as /wecom-aibot status");
	h.dialogs.picks.push(/^connect /);
	await h.command("");
	assert.equal(h.clients.length, 1, "connect from the menu registers like the typed command");
	h.clients[0].publish({ state: "subscribed", sessions: 1 });
	await h.command("");
	assert.equal(h.dialogs.menus.at(-1)?.title, "✅ 企业微信智能机器人：已接入");
	// config opens its own chooser; Esc there changes nothing.
	h.dialogs.picks.push(/^config /);
	await h.command("");
	assert.equal(h.dialogs.menus.at(-1)?.title, "企业微信配置");
	h.dialogs.picks.push(/^--help /);
	await h.command("");
	assert.match(h.notices.at(-1)!, /^企业微信智能机器人 — \/wecom-aibot 命令帮助/);
	// reset still asks: declining keeps the file, confirming deletes it.
	h.dialogs.picks.push(/^reset /);
	h.dialogs.answers.push(false);
	await h.command("");
	assert.equal(h.dialogs.confirms, 1);
	assert.ok(existsSync(CONFIG_FILE));
	h.dialogs.picks.push(/^reset /);
	await h.command("");
	assert.equal(h.dialogs.confirms, 2);
	assert.equal(existsSync(CONFIG_FILE), false);
});

test("without an interactive UI a bare /wecom-aibot lists the subcommands instead of opening a menu", async () => {
	const h = harness("print");
	await h.emit("session_start");
	await h.command("");
	assert.equal(h.dialogs.menus.length, 0);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /^\/wecom-aibot 需要写明子命令，例如 \/wecom-aibot status：\n {2}status {2,}查看/);
	assert.match(h.notices[0], /^ {2}--help {2,}显示帮助$/m);
	assert.equal(h.clients.length, 0);
});

test("an initial connection taking over 30 seconds reports once, without stale progress or a recovery notice", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	const client = await connect(h);
	t.mock.timers.tick(29_999);
	assert.deepEqual(h.notices, []);
	t.mock.timers.tick(1);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /30 秒.*\/wecom-aibot status.*\/wecom-aibot log/);
	assert.deepEqual(h.changes, []);
	client.publish({ state: "connecting", sessions: 0, detail: "retrying" });
	t.mock.timers.tick(30_000);
	assert.equal(h.notices.length, 1, "retries must not produce one warning each");
	client.publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
	assert.equal(h.notices.length, 1, "first success belongs only in the footer");
});

test("disconnect clears only this entry; late callbacks cannot overwrite a reconnected bridge", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const saved = readFileSync(CONFIG_FILE, "utf8");
	const h = harness();
	const old = await connect(h);
	old.publish({ state: "subscribed", sessions: 1 });
	await h.command("disconnect");
	assert.equal(h.statuses.get(key), label("error"), "a disconnect is shown in the error colour before it goes");
	t.mock.timers.tick(FLASH_MS);
	assert.equal(h.statuses.has(key), false);
	assert.equal(h.statuses.get("another-extension"), "Other status");
	assert.equal(old.stopped.length, 1);
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved, "disconnect must not change shared configuration");
	const count = h.changes.length;
	await h.command("status");
	await h.emit("model_select");
	old.publish({ state: "subscribed", sessions: 3, detail: "late" });
	old.fail("late registration failure");
	assert.equal(h.changes.length, count);
	await h.command("connect");
	assert.equal(h.statuses.has(key), false);
	old.publish({ state: "disconnected", sessions: 0, stopped: true });
	assert.equal(h.statuses.has(key), false);
	h.clients[1].publish({ state: "subscribed", sessions: 1 });
	assert.equal(h.statuses.get(key), label("success"));
});

for (const reason of ["new", "resume", "fork", "reload"] as const) {
	test(`session ${reason} drops the old registration and requires an explicit new connect`, async () => {
		const h = harness();
		const old = await connect(h);
		old.publish({ state: "subscribed", sessions: 1 });
		await h.emit("session_shutdown", { reason });
		h.state.sessionId = "replacement-session";
		await h.emit("session_start", { reason });
		assert.equal(old.stopped.length, 1);
		assert.equal(h.clients.length, 1, "a replacement must not create a client automatically");
		assert.equal(h.statuses.has(key), false);
		old.publish({ state: "subscribed", sessions: 1, detail: "late" });
		assert.equal(h.statuses.has(key), false);
		await h.command("connect");
		assert.equal(h.clients.length, 2);
		assert.equal(h.statuses.has(key), false, "connection readiness cannot be inherited");
		h.clients[1].publish({ state: "subscribed", sessions: 1 });
		assert.equal(h.statuses.get(key), label("success"));
	});
}

test("a changed session ID revokes the old registration even before a lifecycle event arrives", async () => {
	const h = harness();
	const old = await connect(h);
	old.publish({ state: "subscribed", sessions: 1 });
	h.state.sessionId = "unexpected-new-session";
	await h.emit("model_select");
	assert.equal(h.statuses.has(key), false);
	assert.equal(old.stopped.length, 1, "hiding an old registration is not sufficient; it must be revoked");
	await h.command("status");
	assert.match(h.notices.at(-1)!, /^⚪ 企业微信智能机器人：未接入（目标会话已切换）/);
});

for (const end of ["reset", "session_shutdown", "fatal"] as const) {
	test(`${end} removes the status and an ended session cannot silently reconnect`, async () => {
		const h = harness();
		const client = await connect(h);
		client.publish({ state: "subscribed", sessions: 1 });
		assert.equal(h.statuses.get(key), label("success"));
		if (end === "reset") await h.command("reset");
		else if (end === "fatal") client.fail("registration rejected");
		else await h.emit("session_shutdown", { reason: "quit" });
		assert.equal(client.stopped.length, 1);
		assert.equal(h.statuses.has(key), false);
		const count = h.changes.length;
		client.publish({ state: "subscribed", sessions: 1, detail: "late" });
		assert.equal(h.changes.length, count);
		if (end === "fatal") assert.ok(h.notices.some((message) => message.includes("registration rejected")));
		await h.emit("session_start");
		assert.equal(h.clients.length, 1);
		assert.equal(h.statuses.has(key), false);
	});
}

for (const mode of ["rpc", "json", "print"] as const) {
	test(`${mode} mode requires manual connect and never produces terminal status updates`, async () => {
		const h = harness(mode);
		const client = await connect(h);
		client.publish({ state: "subscribed", sessions: 1 });
		assert.equal(client.client.isReady(), true);
		await h.command("disconnect");
		assert.deepEqual(h.changes, []);
	});
}

test("connecting, disconnecting or exiting one pi cannot opt another pi in or out", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const saved = readFileSync(CONFIG_FILE, "utf8");
	const a = harness();
	const b = harness();
	await a.emit("session_start");
	await b.emit("session_start");
	await a.command("connect");
	a.clients[0].publish({ state: "subscribed", sessions: 1 });
	assert.equal(b.clients.length, 0, "another pi must remain disconnected until its own command");
	await b.command("connect");
	b.clients[0].publish({ state: "subscribed", sessions: 2 });
	await a.command("disconnect");
	t.mock.timers.tick(FLASH_MS);
	assert.equal(a.statuses.has(key), false);
	assert.equal(b.statuses.get(key), label("success"));
	await a.emit("session_shutdown");
	const c = harness();
	await c.emit("session_start");
	assert.equal(c.clients.length, 0);
	assert.equal(b.statuses.get(key), label("success"));
	assert.equal(readFileSync(CONFIG_FILE, "utf8"), saved);
});

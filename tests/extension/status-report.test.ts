import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CONFIG_FILE, type Layer, mergeLayers } from "../../src/extension/config.ts";
import {
	headline,
	type ReportedBridge,
	type StatusSnapshot,
	statusReport,
	statusTitle,
} from "../../src/extension/status-report.ts";

const GLOBAL: Layer = {
	botId: "aibf1234567890mO",
	secret: "private-secret",
	defaultChatId: "private-user",
	defaultChatType: 1,
	notificationMode: "screenshot",
};
const SOURCE = {
	sessionId: "01a16197-cae8-75c6-baef-042069d29d51",
	provider: "cline",
	modelName: "deepseek",
	directoryName: "pi-wecom-aibot",
};
const OVERRIDES = "/agent/wecom-aibot/sessions/01a16197-cae8-75c6-baef-042069d29d51.json";

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		resolved: mergeLayers(GLOBAL, undefined),
		pendingReconnect: false,
		source: SOURCE,
		overrideFile: OVERRIDES,
		...overrides,
	};
}

function bridge(overrides: Partial<ReportedBridge> = {}): ReportedBridge {
	return {
		identifyOnly: false,
		connection: {
			botId: "aibf1234567890mO",
			secret: "private-secret",
			target: { chatId: "private-user", chatType: 1 },
		},
		state: "connecting",
		detail: undefined,
		ready: false,
		stopped: false,
		connectionStatus: undefined,
		gatewaySessions: 1,
		queued: 0,
		busy: false,
		pendingNotifications: 0,
		...overrides,
	};
}

/** Where a table row's value begins, in terminal cells. */
function valueColumn(line: string): number {
	const match = /^( {2}\S+ +)/.exec(line);
	assert.ok(match, `not a table row: ${line}`);
	return visibleWidth(match[1]);
}

test("a session that has not connected reads as one headline and one aligned table", () => {
	const text = statusReport(snapshot());
	assert.equal(
		text,
		[
			"⚪ 企业微信智能机器人：未接入，每个 session 需运行 /wecom-aibot connect",
			"",
			"  机器人    aibf****mO（Secret 已配置）",
			"  默认推送  private-user（单聊）",
			"",
			"  session   01a16197-cae8-75c6-baef-042069d29d51",
			"  模型      cline · deepseek",
			"  工作目录  pi-wecom-aibot",
			"",
			"  通知方式  screenshot（global）",
			"  通知范围  wecom-tasks（内置默认值）",
			"  截图主题  跟随 pi 当前主题（内置默认值）",
			"",
			`  配置文件  ${CONFIG_FILE}`,
			"  会话覆盖  无",
		].join("\n"),
	);
	assert.doesNotMatch(text, /private-secret/);
});

test("a registration adds the gateway and task rows and shows what it uses, not what the files say", () => {
	const text = statusReport(
		snapshot({
			resolved: mergeLayers({ ...GLOBAL, defaultChatId: "new-user" }, undefined),
			pendingReconnect: true,
			bridge: bridge({
				state: "subscribed",
				ready: true,
				connectionStatus: "online",
				gatewaySessions: 3,
				queued: 2,
				busy: true,
				pendingNotifications: 1,
			}),
		}),
	);
	const lines = text.split("\n");
	assert.equal(lines[0], "✅ 企业微信智能机器人：已接入");
	assert.equal(lines[1], "待重新接入：配置文件中的凭据、默认目标或白名单已改变，运行 /wecom-aibot connect 后生效");
	assert.deepEqual(lines.slice(3, 7), [
		"  机器人    aibf****mO（Secret 已配置）",
		"  默认推送  private-user（单聊）",
		"  共享网关  3 个 pi 已注册",
		"  任务      执行中，排队 2，待发通知 1",
	]);
	const rows = lines.filter((line) => line.startsWith("  "));
	assert.ok(rows.length >= 12);
	for (const row of rows) assert.equal(valueColumn(row), 12, row);
	assert.doesNotMatch(text, /new-user|private-secret/);
});

test("each connection state has its own icon, and the headline names the next step only when one is needed", () => {
	const noTarget = mergeLayers({ botId: "bot-id-1234", secret: "s" }, undefined);
	const cases: [string, Partial<StatusSnapshot>, string][] = [
		["fresh session", {}, "⚪ 企业微信智能机器人：未接入，每个 session 需运行 /wecom-aibot connect"],
		[
			"user disconnect",
			{ stopReason: "disconnected by user" },
			"⚪ 企业微信智能机器人：未接入（已由用户断开），每个 session 需运行 /wecom-aibot connect",
		],
		[
			"no credentials",
			{ resolved: mergeLayers(undefined, undefined), stopReason: "reset" },
			"⚪ 企业微信智能机器人：未接入（配置已删除），先运行 /wecom-aibot config edit --scope global 填写凭据",
		],
		[
			"no target",
			{ resolved: noTarget },
			"⚪ 企业微信智能机器人：未接入，先运行 /wecom-aibot config whoami --scope global 识别默认推送目标",
		],
		["files unusable", { resolved: undefined }, "⚪ 企业微信智能机器人：未接入"],
		[
			"first connection",
			{ bridge: bridge({ detail: "正在注册本机共享网关" }) },
			"⏳ 企业微信智能机器人：正在连接（正在注册本机共享网关）",
		],
		[
			"socket open, not subscribed",
			{ bridge: bridge({ state: "connected" }) },
			"⏳ 企业微信智能机器人：正在连接（已连上企业微信，等待订阅）",
		],
		[
			"subscribed, transport unusable",
			{ bridge: bridge({ state: "subscribed" }) },
			"⏳ 企业微信智能机器人：正在连接（已订阅，本机通道未就绪）",
		],
		[
			"outage",
			{
				bridge: bridge({
					state: "disconnected",
					connectionStatus: "reconnecting",
					detail: "本机共享网关连接已断开",
				}),
			},
			"⏳ 企业微信智能机器人：正在重连（本机共享网关连接已断开）",
		],
		[
			"whoami",
			{ bridge: bridge({ identifyOnly: true, state: "subscribed", ready: true }) },
			"⏳ 企业微信智能机器人：whoami 临时识别中（未正式接入）",
		],
		[
			"connected",
			{ bridge: bridge({ state: "subscribed", ready: true, connectionStatus: "online" }) },
			"✅ 企业微信智能机器人：已接入",
		],
		[
			"refused subscription",
			{ bridge: bridge({ state: "disconnected", stopped: true, detail: "subscribe failed: 40001" }) },
			"❌ 企业微信智能机器人：已停止（subscribe failed: 40001），运行 /wecom-aibot connect 恢复",
		],
		[
			"taken over: the reason already names the command",
			{
				bridge: bridge({
					state: "disconnected",
					stopped: true,
					connectionStatus: "blocked",
					detail: "机器人连接已被其他机器或旧客户端接管；可在任一 pi 执行 /wecom-aibot connect 恢复",
				}),
			},
			"❌ 企业微信智能机器人：已停止（机器人连接已被其他机器或旧客户端接管；可在任一 pi 执行 /wecom-aibot connect 恢复）",
		],
		[
			"fatal registration failure",
			{ stopReason: "该完整 session ID 已由另一个 pi 注册，请在当前窗口新建或切换会话。" },
			"❌ 企业微信智能机器人：已停止（该完整 session ID 已由另一个 pi 注册，请在当前窗口新建或切换会话），运行 /wecom-aibot connect 恢复",
		],
	];
	for (const [name, overrides, expected] of cases) {
		const { icon, text } = headline(snapshot(overrides));
		assert.equal(`${icon} ${text}`, expected, name);
		assert.equal(statusReport(snapshot(overrides)).split("\n")[0], expected, name);
	}
});

test("files that cannot be used keep the session, the paths and no guessed settings", () => {
	const lines = statusReport(snapshot({ resolved: undefined })).split("\n");
	assert.ok(lines.includes("  机器人    配置无法使用（见上一条提示）"));
	assert.ok(lines.includes("  session   01a16197-cae8-75c6-baef-042069d29d51"));
	assert.ok(lines.includes(`  会话覆盖  ${OVERRIDES}`), "the file to check is named");
	assert.ok(!lines.some((line) => /默认推送|通知方式|通知范围|截图主题/.test(line)));
	const unstarted = statusReport(snapshot({ overrideFile: undefined }));
	assert.doesNotMatch(unstarted, /会话覆盖/);
});

test("settings name the layer they come from, and the override row names the overridden fields", () => {
	const resolved = mergeLayers(GLOBAL, { screenshotTheme: "light", defaultChatId: "group-id", defaultChatType: 2 });
	const lines = statusReport(snapshot({ resolved })).split("\n");
	assert.ok(lines.includes("  默认推送  group-id（群聊）"));
	assert.ok(lines.includes("  截图主题  light（session）"));
	assert.ok(lines.includes("  通知方式  screenshot（global）"));
	assert.ok(lines.includes("  会话覆盖  defaultChatId、defaultChatType、screenshotTheme"));
});

test("the menu title keeps the icon and the state, without the reason or the next step", () => {
	const cases: [Pick<StatusSnapshot, "bridge" | "stopReason">, string][] = [
		[{}, "⚪ 企业微信智能机器人：未接入"],
		[{ stopReason: "disconnected by user" }, "⚪ 企业微信智能机器人：未接入"],
		[{ stopReason: "registration rejected" }, "❌ 企业微信智能机器人：已停止"],
		[{ bridge: bridge({ detail: "正在注册本机共享网关" }) }, "⏳ 企业微信智能机器人：正在连接"],
		[{ bridge: bridge({ state: "subscribed", ready: true }) }, "✅ 企业微信智能机器人：已接入"],
		[{ bridge: bridge({ stopped: true, detail: "subscribe failed" }) }, "❌ 企业微信智能机器人：已停止"],
	];
	for (const [snapshot, title] of cases) assert.equal(statusTitle(snapshot), title);
});

test("an upstream diagnostic stays on the headline line without terminal control", () => {
	const text = statusReport(
		snapshot({
			bridge: bridge({
				state: "disconnected",
				connectionStatus: "reconnecting",
				detail: "outage\n\x1b[2Jsecond\tline。",
			}),
		}),
	);
	assert.equal(text.split("\n")[0], "⏳ 企业微信智能机器人：正在重连（outage second line）");
	assert.equal(stripVTControlCharacters(text), text);
	assert.doesNotMatch(text, /\x1b|\t/);
});

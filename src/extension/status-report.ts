/**
 * What `/wecom-aibot status` reports: one headline whose icon tells the connection state, then the
 * details in one aligned table. pi shows the whole notice in its dim colour, so the icon is its only
 * colour; each icon also has its own shape, so the meaning holds without colour. The four
 * icons are all East Asian wide, so the state never shifts the text after it by a column.
 */
import { stripVTControlCharacters } from "node:util";
import type { WeComState } from "../shared/wecom-protocol.ts";
import type { BridgeSession } from "./bridge-session.ts";
import { CONFIG_FILE, connectionOf, FIELDS, type Resolved } from "./config.ts";
import { describe, display, table } from "./config-command.ts";

export type ReportedBridge = Pick<
	BridgeSession,
	| "identifyOnly"
	| "connection"
	| "state"
	| "detail"
	| "ready"
	| "stopped"
	| "connectionStatus"
	| "gatewaySessions"
	| "queued"
	| "busy"
	| "pendingNotifications"
>;

export interface StatusSnapshot {
	/** This session's registration, formal or a whoami identification. */
	bridge?: ReportedBridge;
	/** Why the last registration of this session ended; undefined when it never had one. */
	stopReason?: string;
	/** What the files say now; undefined when they cannot be used (already reported). */
	resolved?: Resolved;
	pendingReconnect: boolean;
	source: { sessionId: string; provider: string; modelName: string; directoryName: string };
	/** This session's override file; undefined before pi started a session. */
	overrideFile?: string;
}

/**
 * 🔌 plugged in, ⏳ on its way, 🛑 stopped and waiting for the user, 💤 not connected. All four are
 * East Asian wide, so every headline keeps the text at the same column whichever state it reports.
 */
export type StatusIcon = "🔌" | "⏳" | "🛑" | "💤";

/** The reasons this extension stops a registration itself; any other reason is a failure from below. */
const STOP_REASONS: Record<string, string> = {
	"disconnected by user": "已由用户断开",
	"identity completed": "whoami 识别完成",
	reset: "配置已删除",
	"session changed": "会话已切换",
	"session or configuration changed": "会话或配置已更改",
	"session shutdown": "pi 已退出",
	"target session changed": "目标会话已切换",
};

const WAITING: Partial<Record<WeComState, string>> = {
	connected: "已连上企业微信，等待订阅",
	subscribed: "已订阅，本机通道未就绪",
};

const RESUME = "运行 /wecom-aibot connect 恢复";
const TITLE = "企业微信智能机器人";

interface State {
	icon: StatusIcon;
	state: string;
	reason?: string;
	next?: string;
}

export function headline(snapshot: StatusSnapshot): { icon: StatusIcon; text: string } {
	const { icon, state, reason, next } = classify(snapshot);
	return { icon, text: `${TITLE}：${state}${reason ? `（${reason}）` : ""}${next ? `，${next}` : ""}` };
}

export function statusTitle(snapshot: Pick<StatusSnapshot, "bridge" | "stopReason">): string {
	const { icon, state } = classify(snapshot);
	return `${icon} ${TITLE}：${state}`;
}

function classify({ bridge, stopReason, resolved }: Pick<StatusSnapshot, "bridge" | "stopReason" | "resolved">): State {
	if (!bridge) {
		if (stopReason && !Object.hasOwn(STOP_REASONS, stopReason)) {
			const reason = oneLine(stopReason);
			return {
				icon: "🛑",
				state: "已停止",
				reason,
				next: reason.includes("/wecom-aibot connect") ? undefined : RESUME,
			};
		}
		return { icon: "💤", state: "未接入", reason: stopReason && STOP_REASONS[stopReason], next: nextStep(resolved) };
	}
	if (bridge.identifyOnly) return { icon: "⏳", state: "whoami 临时识别中（未正式接入）" };
	if (bridge.ready) return { icon: "🔌", state: "已接入" };
	const detail = bridge.detail ? oneLine(bridge.detail) : undefined;
	if (bridge.stopped)
		return {
			icon: "🛑",
			state: "已停止",
			reason: detail,
			next: detail?.includes("/wecom-aibot connect") ? undefined : RESUME,
		};
	return {
		icon: "⏳",
		state: bridge.connectionStatus === "reconnecting" ? "正在重连" : "正在连接",
		reason: detail ?? WAITING[bridge.state],
	};
}

function oneLine(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\x00-\x1f\x7f\s]+/g, " ")
		.trim()
		.replace(/[。.]$/, "");
}

function nextStep(resolved: Resolved | undefined): string | undefined {
	if (!resolved) return undefined;
	const connection = connectionOf(resolved);
	if (!connection) return "先运行 /wecom-aibot config --scope global edit 填写凭据";
	if (!connection.target) return "先运行 /wecom-aibot config --scope global whoami 识别默认推送目标";
	return "每个 session 需运行 /wecom-aibot connect";
}

/** The bot and target in use: the registration's own while connected, otherwise what connect would use. */
function connectionRows({ bridge, resolved }: StatusSnapshot): [string, string][] {
	const connection = bridge && !bridge.identifyOnly ? bridge.connection : resolved && connectionOf(resolved);
	if (!connection) return [["机器人", resolved ? "未配置" : "配置无法使用（见上一条提示）"]];
	const { target } = connection;
	const rows: [string, string][] = [
		["机器人", `${display("botId", connection.botId)}（Secret ${display("secret", connection.secret)}）`],
		["默认推送", target ? `${target.chatId}（${target.chatType === 2 ? "群聊" : "单聊"}）` : "未配置"],
	];
	if (bridge) rows.push(["共享网关", `${bridge.gatewaySessions} 个 pi 已注册`]);
	if (bridge && !bridge.identifyOnly)
		rows.push([
			"任务",
			`${bridge.busy ? "执行中" : "空闲"}，排队 ${bridge.queued}，待发通知 ${bridge.pendingNotifications}`,
		]);
	return rows;
}

function sessionRows({ source }: StatusSnapshot): [string, string][] {
	return [
		["session", source.sessionId],
		["模型", `${source.provider} · ${source.modelName}`],
		["工作目录", source.directoryName],
	];
}

function settingRows({ resolved }: StatusSnapshot): [string, string][] {
	if (!resolved) return [];
	return [
		["通知范围", describe(resolved, "notificationScope")],
		["提示词", describe(resolved, "controlPrompts")],
		["会话文档", describe(resolved, "docMcpUrl")],
	];
}

function fileRows({ resolved, overrideFile }: StatusSnapshot): [string, string][] {
	const rows: [string, string][] = [["配置文件", CONFIG_FILE]];
	if (overrideFile === undefined) return rows;
	if (!resolved) rows.push(["会话覆盖", overrideFile]);
	else {
		const overridden = FIELDS.filter((spec) => resolved.sources[spec.name] === "session").map((spec) => spec.name);
		rows.push(["会话覆盖", overridden.length ? overridden.join("、") : "无"]);
	}
	return rows;
}

export function statusReport(snapshot: StatusSnapshot): string {
	const { icon, text } = headline(snapshot);
	return [
		`${icon} ${text}`,
		...(snapshot.pendingReconnect
			? ["待重新接入：配置文件中的凭据、默认目标或白名单已改变，运行 /wecom-aibot connect 后生效"]
			: []),
		"",
		...table(connectionRows(snapshot), sessionRows(snapshot), settingRows(snapshot), fileRows(snapshot)),
	].join("\n");
}

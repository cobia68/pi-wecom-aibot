/** How the gateway's cards show sessions: dropdown options, rows, and a control card's completed dropdown. */
import { type CardFact, type CardModel, clamp } from "../shared/card.ts";
import { SESSION_QUESTION, sessionFingerprint, sessionLabel, sessionOption } from "../shared/control-card.ts";
import { markdownValue } from "../shared/notification.ts";
import type { SessionSource } from "../shared/notification-types.ts";
import { sessionCommand } from "./command.ts";

/** WeCom's dropdown takes ten options. */
const MAX_OPTIONS = 10;
const TEXT_LIMIT = 112;
const ROW_FOLDER = 16;
const ROW_VALUE = 40;

/** A session with its state, when its pi answered in time. */
export interface SessionState {
	source: SessionSource;
	busy?: boolean;
}

/** A session the gateway can list; `active` orders who was used most recently. */
export interface ListedSession {
	source: SessionSource;
	active: number;
}

function stateLabel(busy: boolean | undefined): string {
	if (busy === undefined) return "状态未知";
	return busy ? "执行中" : "空闲";
}

/** 「· 目录 · 供应商 · 模型 · 忙闲」, one Markdown line. */
function sessionSummary({ source, busy }: SessionState): string {
	const value = (text: string) => markdownValue(text, 60);
	return `· ${value(source.directoryName)} · ${value(source.provider)} · ${value(source.modelName)} · ${stateLabel(busy)}`;
}

/** One session as text, with the commands that use it ready to copy. */
export function sessionText(session: SessionState): string {
	const id = session.source.sessionId;
	return [
		sessionSummary(session),
		"",
		sessionCommand(id, "send"),
		sessionCommand(id, "card"),
		sessionCommand(id, "cancel"),
	].join("\n");
}

/** The online sessions as text, for a chat that gets no card; `prefix` says why they are listed. */
export function sessionsText(sessions: readonly SessionState[], prefix?: string): string {
	const lines = prefix ? [prefix] : [];
	if (!sessions.length)
		return [...lines, "当前没有可用的在线会话。请先在 pi 中运行 /wecom-aibot connect"].join("\n\n");
	lines.push(`当前有 ${sessions.length} 个在线会话：`);
	for (const session of sessions) {
		const entry = `${sessionSummary(session)}\n  session: ${session.source.sessionId}`;
		if (Buffer.byteLength(lines.join("\n\n") + entry, "utf8") > 18_000) {
			lines.push("（其余会话未显示，可先断开一些 pi）");
			break;
		}
		lines.push(entry);
	}
	lines.push(`把任务发给其中一个：\n${sessionCommand("<上面的 session ID>", "send", "你的任务")}`);
	return lines.join("\n\n");
}

/** 「文件夹 · ID 末 4 位 · 忙闲」: a long folder is cut first, so the ID and the state stay. */
export function stateOptions(sessions: readonly SessionState[]): { id: string; text: string }[] {
	return sessions.map(({ source, busy }) => ({
		id: sessionFingerprint(source.sessionId),
		text: `${sessionLabel(source.sessionId, source.directoryName)} · ${stateLabel(busy)}`,
	}));
}

/** 忙闲 | 「文件夹 · ID 末 4 位 · 模型」: a row holds the longer text, the model cut first. */
export function sessionRow({ source, busy }: SessionState): CardFact {
	const label = sessionLabel(source.sessionId, source.directoryName, ROW_FOLDER);
	return { key: stateLabel(busy), value: clamp(`${label} · ${source.modelName}`, ROW_VALUE) };
}

/**
 * pi draws its control card's dropdown with its own session alone; the gateway adds the others online. The
 * session shown stays first and selected, even offline. Beyond ten, the others used most recently are listed.
 */
export function withSessions(model: CardModel, online: readonly ListedSession[]): CardModel {
	const selection = model.selection;
	if (selection?.key !== SESSION_QUESTION) return model;
	const shown = selection.selected ?? selection.options[0]?.id;
	const own = selection.options.find((option) => option.id === shown);
	if (!shown || !own) return model;
	const others = online.filter((item) => sessionFingerprint(item.source.sessionId) !== shown);
	const kept = new Set(
		[...others]
			.sort((a, b) => b.active - a.active)
			.slice(0, MAX_OPTIONS - 1)
			.map((item) => item.source.sessionId),
	);
	const listed = online.filter(
		(item) => sessionFingerprint(item.source.sessionId) === shown || kept.has(item.source.sessionId),
	);
	const options = listed.map((item) => sessionOption(item.source.sessionId, item.source.directoryName));
	if (!options.some((option) => option.id === shown)) options.unshift(own);
	const hidden = others.length - kept.size;
	return {
		...model,
		selection: { ...selection, options, selected: shown },
		...(hidden > 0
			? {
					subtitle: clamp(
						`${model.subtitle ?? ""}；另有 ${hidden} 个会话，发 /wecom-aibot sessions 查看`,
						TEXT_LIMIT,
					),
				}
			: {}),
	};
}

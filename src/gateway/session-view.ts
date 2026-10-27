/** How the gateway's cards show sessions: dropdown options, rows, and a control card's completed dropdown. */
import { type CardFact, type CardModel, clamp } from "../shared/card.ts";
import { SESSION_QUESTION, sessionFingerprint, sessionLabel, sessionOption } from "../shared/control-card.ts";
import type { SessionSource } from "../shared/notification-types.ts";

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

export function stateLabel(busy: boolean | undefined): string {
	if (busy === undefined) return "状态未知";
	return busy ? "执行中" : "空闲";
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

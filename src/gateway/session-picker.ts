/**
 * The online sessions as a card: one row each, a dropdown of the same ones, and a control card's buttons that
 * act on the one chosen. No session is singled out: the dropdown starts at the first row, as WeCom draws it.
 */
import { type CardAction, type CardModel, clock } from "../shared/card.ts";
import { CONTROL_KEYS, type ControlAction, controlCardId, sessionFingerprint } from "../shared/control-card.ts";
import { type SessionState, sessionRow, stateOptions } from "./session-view.ts";

export const PICKER_QUESTION = "pick";
/** WeCom draws six rows; the sixth is a click's note. */
export const PICKER_PAGE = 5;

/** Always four, two rows of two (three in a row are cut); several pages turn with the second row. */
const ACTIONS: readonly (Omit<CardAction, "key"> & { action: ControlAction })[] = [
	{ action: CONTROL_KEYS.show, text: "查看会话", style: 1 },
	{ action: CONTROL_KEYS.send, text: "发提示词", style: 2 },
	{ action: CONTROL_KEYS.model, text: "切换模型", style: 2 },
	{ action: CONTROL_KEYS.abort, text: "中止任务", style: 3 },
];
const ACTION_KEY = /^pick@([a-z-]{1,32})(?:@([0-9a-f]{64}))?$/;
const PAGE_KEY = /^pick@(?:prev|next)@(\d{1,3})$/;

/** `fingerprint`: the page's first row, which a click without the dropdown's choice means; absent on older lists. */
export type PickerAction =
	| { kind: "act"; action: ControlAction; fingerprint?: string }
	| { kind: "page"; page: number };

export function pickerAction(key: string): PickerAction | undefined {
	const page = PAGE_KEY.exec(key);
	if (page) return { kind: "page", page: Number(page[1]) };
	const match = ACTION_KEY.exec(key);
	const action = ACTIONS.find((item) => item.action === match?.[1])?.action;
	if (!match || !action) return undefined;
	return { kind: "act", action, ...(match[2] ? { fingerprint: match[2] } : {}) };
}

export function pageOf(sessions: readonly SessionState[], fingerprint: string | undefined): number {
	const index = sessions.findIndex((item) => sessionFingerprint(item.source.sessionId) === fingerprint);
	return index < 0 ? 0 : Math.floor(index / PICKER_PAGE);
}

/** One page, clamped; the task ID is a control card's, since the card becomes one once a button is pressed. */
export function sessionPicker(
	sessions: readonly SessionState[],
	requestedPage = 0,
	at = new Date(),
): { cardId: string; card: CardModel } | undefined {
	if (!sessions.length) return undefined;
	const pages = Math.ceil(sessions.length / PICKER_PAGE);
	const page = Math.min(pages - 1, Math.max(0, Math.trunc(requestedPage) || 0));
	const shown = sessions.slice(page * PICKER_PAGE, (page + 1) * PICKER_PAGE);
	const first = sessionFingerprint(shown[0].source.sessionId);
	const actions: CardAction[] = (pages > 1 ? ACTIONS.slice(0, 2) : ACTIONS).map(({ action, ...button }) => ({
		...button,
		key: `pick@${action}@${first}`,
	}));
	if (pages > 1)
		actions.push(
			{ key: `pick@prev@${(page + pages - 1) % pages}`, text: "上一页", style: 2 },
			{ key: `pick@next@${(page + 1) % pages}`, text: "下一页", style: 2 },
		);
	const card: CardModel = {
		label: "在线会话",
		tone: "neutral",
		title: `${sessions.length} 个在线会话`,
		desc: `${pages > 1 ? `第 ${page + 1}/${pages} 页 · ` : ""}${clock(at)} 的状态`,
		subtitle: "下拉框选会话，再点按钮，卡片换成它的控制卡；直接发消息时，机器人会问发给哪个会话",
		facts: shown.map(sessionRow),
		selection: {
			key: PICKER_QUESTION,
			title: pages > 1 ? `会话 ${page + 1}/${pages}` : "会话",
			options: stateOptions(shown),
			selected: first,
		},
		actions,
	};
	return { cardId: controlCardId(shown[0].source.sessionId), card };
}

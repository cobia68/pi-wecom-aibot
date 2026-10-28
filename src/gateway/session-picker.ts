/**
 * The online sessions as a card: one row each, a dropdown of the same ones, and 打开会话, which publishes
 * the chosen session's control card as a new message. The list stays, so one list opens many sessions; every
 * action is done on the control card. No session is singled out: the dropdown starts at the first row.
 */
import { type CardAction, type CardModel, clock } from "../shared/card.ts";
import { CONTROL_KEYS, controlCardId, sessionFingerprint } from "../shared/control-card.ts";
import { type SessionState, sessionRow, stateOptions } from "./session-view.ts";

export const PICKER_QUESTION = "pick";
/** WeCom draws six rows; the sixth is a click's note. */
export const PICKER_PAGE = 5;

/** The list's own button: the states again, the dropdown kept. */
const REFRESH = "refresh";
const ACTION_KEY = new RegExp(`^pick@(${CONTROL_KEYS.show}|${REFRESH})@([0-9a-f]{64})$`);
const PAGE_KEY = /^pick@(?:prev|next)@(\d{1,3})$/;

/** `fingerprint`: the session the dropdown showed when drawn, which a click without its choice means. */
export type PickerAction = { kind: "open" | "refresh"; fingerprint: string } | { kind: "page"; page: number };

export function pickerAction(key: string): PickerAction | undefined {
	const page = PAGE_KEY.exec(key);
	if (page) return { kind: "page", page: Number(page[1]) };
	const match = ACTION_KEY.exec(key);
	if (!match) return undefined;
	return { kind: match[1] === REFRESH ? "refresh" : "open", fingerprint: match[2] };
}

export function pageOf(sessions: readonly SessionState[], fingerprint: string | undefined): number {
	const index = sessions.findIndex((item) => sessionFingerprint(item.source.sessionId) === fingerprint);
	return index < 0 ? 0 : Math.floor(index / PICKER_PAGE);
}

/**
 * One page, clamped; `selected` keeps the dropdown on a session of that page, else it shows the first row. The
 * task ID has a control card's form, naming the first row's session: the gateway routes the list's clicks by it.
 */
export function sessionPicker(
	sessions: readonly SessionState[],
	requestedPage = 0,
	at = new Date(),
	selected?: string,
): { cardId: string; card: CardModel } | undefined {
	if (!sessions.length) return undefined;
	const pages = Math.ceil(sessions.length / PICKER_PAGE);
	const page = Math.min(pages - 1, Math.max(0, Math.trunc(requestedPage) || 0));
	const shown = sessions.slice(page * PICKER_PAGE, (page + 1) * PICKER_PAGE);
	const prints = shown.map((item) => sessionFingerprint(item.source.sessionId));
	const chosen = selected && prints.includes(selected) ? selected : prints[0];
	// Four characters each: a phone did not show five whole.
	const actions: CardAction[] = [
		{ key: `pick@${CONTROL_KEYS.show}@${chosen}`, text: "打开会话", style: 1 },
		{ key: `pick@${REFRESH}@${chosen}`, text: "刷新列表", style: 2 },
	];
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
		subtitle: "下拉框选会话，点「打开会话」发出它的控制卡，列表留着接着用；直接发消息时，机器人会问发给哪个会话",
		facts: shown.map(sessionRow),
		selection: {
			key: PICKER_QUESTION,
			title: pages > 1 ? `会话 ${page + 1}/${pages}` : "会话",
			options: stateOptions(shown),
			selected: chosen,
		},
		actions,
	};
	return { cardId: controlCardId(shown[0].source.sessionId), card };
}

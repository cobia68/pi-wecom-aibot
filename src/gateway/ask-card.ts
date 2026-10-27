/** A message that names no session waits for one click on its question card; nothing outlives it. */
import { randomBytes } from "node:crypto";
import { type CardModel, plainText } from "../shared/card.ts";
import { sessionHead } from "../shared/control-card.ts";
import type { SessionSource } from "../shared/notification-types.ts";
import type { InboundMessage } from "../shared/wecom-protocol.ts";
import { type SessionState, sessionRow, stateOptions } from "./session-view.ts";

/** WeCom's attachment links last 5 minutes; the choice must leave pi time to download them. */
export const ASK_MS = 4 * 60_000;
export const ASK_CHOICES = 10;
/** WeCom draws six rows; the sixth is a click's note. */
export const ASK_ROWS = 5;
export const ASK_QUESTION = "target";
export const SETTLED_ROW = "发送记录";

export interface AskedMessage {
	/** The message's callback req_id: its reply, the result, still uses it. */
	reqId: string;
	message: InboundMessage;
	/** The dropdown's sessions, as fingerprints; a click without a choice means the first. */
	choices: string[];
	expiresAt: number;
	timer: ReturnType<typeof setTimeout>;
}

export type AskAction = { kind: "send" } | { kind: "cancel" } | { kind: "done" };

/** Sent to a session, or closed unsent (cancelled, expired, replaced, its session gone). */
export type AskOutcome = { kind: "sent"; source: SessionSource } | { kind: "closed" };

export function askCardId(): string {
	return `q@${randomBytes(6).toString("hex")}`;
}

export function askAction(cardId: string, key: string): AskAction | undefined {
	if (!/^q@[0-9a-f]{12}$/.test(cardId)) return undefined;
	if (key === "send" || key === "cancel" || key === "done") return { kind: key };
	return undefined;
}

/** Which pi takes the message: rows and a dropdown of the sessions, in the order they connected. */
export function askCard(message: InboundMessage, choices: readonly SessionState[], reason?: string): CardModel {
	const shown = choices.slice(0, ASK_CHOICES);
	const more = choices.length - shown.length;
	return {
		label: "pi-wecom-aibot",
		tone: "neutral",
		title: "这条消息发给哪个会话？",
		desc: `${choices.length} 个在线 · 4 分钟内有效`,
		quote: preview(message),
		subtitle: [
			reason,
			"选好会话后点「确认发送」；只对这一条消息有效，下一条再问",
			message.chat.chatType === 2 ? "只有发送者能选" : undefined,
			shown.length > ASK_ROWS ? `正文列前 ${ASK_ROWS} 个，下拉框列前 ${shown.length} 个` : undefined,
			more > 0 ? `另有 ${more} 个会话未列出，可用 --session-id 指定` : undefined,
		]
			.filter(Boolean)
			.join("；"),
		facts: shown.slice(0, ASK_ROWS).map(sessionRow),
		selection: { key: ASK_QUESTION, title: "会话", options: stateOptions(shown) },
		actions: [
			{ key: "send", text: "确认发送", style: 1 },
			{ key: "cancel", text: "取消发送", style: 2 },
		],
	};
}

/** The decided card: a sent one names its session as its control card does; nothing on it sends again. */
export function settledCard(card: CardModel, outcome: AskOutcome): CardModel {
	const common = {
		...(card.quote === undefined ? {} : { quote: card.quote }),
		facts: [],
		actions: [{ key: "done", text: "已处理", style: 4 as const }],
		noteKey: SETTLED_ROW,
	};
	if (outcome.kind === "sent") return { label: "已发送", tone: "success", ...sessionHead(outcome.source), ...common };
	return { label: "未发送", tone: "neutral", title: "这条消息没有发出", subtitle: "需要的话重新发送", ...common };
}

export function isSettled(card: CardModel): boolean {
	return card.actions.length === 1 && card.actions[0].key === "done";
}

function preview(message: InboundMessage): string {
	const text = plainText(message.text).trim();
	const media = message.attachments.length ? `［${message.attachments.length} 个附件］` : "";
	const lines = text.split("\n").filter((line) => line.trim());
	return [...lines.slice(0, 2), ...(lines.length > 2 ? ["…"] : []), media].filter(Boolean).join("\n") || "（空消息）";
}

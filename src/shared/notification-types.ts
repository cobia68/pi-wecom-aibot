/** A session's identity, and the notification snapshots pi and the gateway share. */
import type { CardModel } from "./card.ts";

export interface SessionSource {
	readonly sessionId: string;
	readonly provider: string;
	readonly modelName: string;
	readonly directoryName: string;
}

/**
 * result: a run's automatic answer; notice: wecom_send; test: /wecom-aibot test.
 * pi sends each as its session's control card (control). Without a card, or when WeCom refuses it, only
 * inline may send the text as Markdown; documentOnly notifications fail rather than expose the body.
 */
export type NotificationKind = "result" | "notice" | "test";

/** A notification snapshot; the gateway sends its control card, with Markdown fallback only for inline. */
export interface GatewayNotification {
	kind: NotificationKind;
	source: SessionSource;
	/** Markdown body; a card shows a plain-text excerpt of it. */
	text: string;
	/** The headline; the Markdown fallback opens with it in bold. */
	title?: string;
	aborted?: boolean;
	/** linked is document-only: a missing/refused card must never expose its body as a Markdown fallback. */
	documentOnly?: boolean;
	/**
	 * The notification as its session's control card (a new copy: a finished run's in its done state). text
	 * stays the body: the card's page shows it, or an inline card's Markdown fallback carries it.
	 */
	control?: { cardId: string; card: CardModel };
}

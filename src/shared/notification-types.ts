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
 * pi sends each as its session's control card (control). Without a card, or when WeCom refuses it, the gateway
 * sends the text as Markdown.
 */
export type NotificationKind = "result" | "notice" | "test";

/** A notification snapshot; the gateway renders it as its session's control card, or as Markdown. */
export interface GatewayNotification {
	kind: NotificationKind;
	source: SessionSource;
	/** Markdown body; a card shows a plain-text excerpt of it. */
	text: string;
	/** The headline; the Markdown fallback opens with it in bold. */
	title?: string;
	aborted?: boolean;
	/**
	 * The notification as its session's control card (a new copy: a finished run's in its done state). text
	 * stays the body: the card's page shows it, a refused card's Markdown carries it.
	 */
	control?: { cardId: string; card: CardModel };
}

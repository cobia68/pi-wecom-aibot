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
 * pi sends each as its session's control card (control), or a task's own stream ends with it. Without a card,
 * or when WeCom refuses it, the gateway sends the text as Markdown.
 */
export type NotificationKind = "result" | "notice" | "test";

/** A notification snapshot; the gateway renders it as a card, or as the end of its task's stream. */
export interface GatewayNotification {
	kind: NotificationKind;
	source: SessionSource;
	/** Markdown body; a card shows a plain-text excerpt of it. */
	text: string;
	/** The card's headline; the gateway falls back to a title for the kind. */
	title?: string;
	/** Exact inbound task whose status this notification may finish; never inferred from chat alone. */
	taskId?: string;
	aborted?: boolean;
	/**
	 * The notification as its session's control card (a new copy: a finished run's in its done state); the
	 * gateway sends it instead of its own card. text stays the body: a task's stream and a refused card use it.
	 */
	control?: { cardId: string; card: CardModel };
}

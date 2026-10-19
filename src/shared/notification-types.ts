/** Plain notification metadata and snapshots shared by pi and the gateway. */
export interface NotificationSource {
	readonly sessionId: string;
	readonly provider: string;
	readonly modelName: string;
	readonly directoryName: string;
}

export type NotificationKind = "notification" | "completion" | "reply" | "test" | "welcome";

/** A notification snapshot; the gateway adds the source header and applies WeCom's byte limit. */
export interface GatewayNotification {
	kind: "notification" | "completion" | "reply" | "test";
	source: NotificationSource;
	text: string;
	/** text is a tail excerpt: truncate from the front, never fail. */
	excerpt?: boolean;
	aborted?: boolean;
}

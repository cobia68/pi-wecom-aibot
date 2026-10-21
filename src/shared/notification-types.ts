/** Plain notification metadata and snapshots shared by pi and the gateway. */
export interface NotificationSource {
	readonly sessionId: string;
	readonly provider: string;
	readonly modelName: string;
	readonly directoryName: string;
}

export type NotificationKind = "notification" | "completion" | "reply" | "test" | "connect";

/** A notification snapshot; the gateway adds the source header and applies WeCom's byte limit. */
/** A file the gateway uploads and sends as a native WeCom image message. */
export interface GatewayImage {
	mime: "image/png";
	filename: string;
	/** Absolute path readable by the shared gateway on this machine. */
	path: string;
}

export interface GatewayNotification {
	kind: NotificationKind;
	source: NotificationSource;
	text: string;
	/** Exact inbound task whose status this notification may finish; never inferred from chat alone. */
	taskId?: string;
	/** text is a tail excerpt: truncate from the front, never fail. */
	excerpt?: boolean;
	aborted?: boolean;
	/** Why image mode fell back to text; rendered with the body, never hidden by truncation. */
	imageFailure?: string;
	/** When set, the gateway sends this image instead of the Markdown body; text remains the fallback. */
	image?: GatewayImage;
}

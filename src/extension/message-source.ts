/**
 * Who sent a WeCom message, shown in pi's terminal above it. A custom session entry: pi draws it and keeps it
 * with the session, but never sends it to the model, so the prompt is only what the user wrote.
 */

import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Written into session files: never renamed. */
export const MESSAGE_SOURCE_ENTRY = "wecom-aibot-message-source";

/** The chat's ID is never recorded, as it was never shown. */
export interface MessageSource {
	userid: string;
	chatType: 1 | 2;
}

export function sourceLine(source: MessageSource): string {
	return `[wecom|from:${field(source.userid)}|chat:${source.chatType === 2 ? "群聊" : "单聊"}]`;
}

/** One dim line, aligned with the message below it; anything else under this type is left undrawn. */
export const renderMessageSource: EntryRenderer = (entry, _options, theme) =>
	isMessageSource(entry.data) ? new Text(theme.fg("dim", sourceLine(entry.data)), 1, 0) : undefined;

function isMessageSource(value: unknown): value is MessageSource {
	const data = value as Partial<MessageSource> | null | undefined;
	return typeof data?.userid === "string" && (data.chatType === 1 || data.chatType === 2);
}

/** A userid as a header value: no line break, delimiter or terminal control can end or restyle the line. */
function field(value: string): string {
	return value.replace(/[\s\p{Cc}|\]]+/gu, "_");
}

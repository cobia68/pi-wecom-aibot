/** pi-owned session data, read here: its identity, replies and page activity; only plain snapshots cross IPC. */
import { posix, win32 } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { NO_REPLY_TEXT } from "../shared/notification.ts";
import type { SessionSource } from "../shared/notification-types.ts";

type ModelIdentity = Pick<Model<Api>, "id" | "name" | "provider">;
type ReplyModel = Partial<Pick<AssistantMessage, "model" | "provider">>;
interface SourceContext {
	cwd: string;
	sessionManager: { getSessionId(): string };
	model?: ModelIdentity;
	modelRegistry?: { find(provider: string, modelId: string): ModelIdentity | undefined };
}

/** Resolve provider and model together so identical model IDs at different providers stay distinct. */
export function captureModelIdentity(
	ctx: Pick<SourceContext, "model" | "modelRegistry">,
	reply?: ReplyModel,
): Pick<SessionSource, "provider" | "modelName"> {
	const provider = reply?.provider || (reply?.model ? undefined : ctx.model?.provider);
	let model = ctx.model;
	if (reply?.model) {
		model =
			model?.id === reply.model && model.provider === provider
				? model
				: provider
					? ctx.modelRegistry?.find(provider, reply.model)
					: undefined;
	} else if (provider && model?.provider !== provider) {
		model = undefined;
	}
	return {
		provider: provider || (reply?.model ? "未知供应商" : "未选择供应商"),
		modelName: model?.name?.trim() || reply?.model || model?.id || "未选择模型",
	};
}

/** Capture primitive values now; a later model switch or reconnect cannot relabel this source. */
export function captureSessionSource(ctx: SourceContext, reply?: ReplyModel): SessionSource {
	const path = /\\|^[A-Za-z]:/.test(ctx.cwd) ? win32 : posix;
	const directory = ctx.cwd ? path.normalize(ctx.cwd) : "";
	const root = path.parse(directory).root;
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		...captureModelIdentity(ctx, reply),
		directoryName: root && directory === root ? "根目录" : path.basename(directory) || "未知目录",
	};
}

/** Copy visible output and any recorded error verbatim, without inferring task success. */
export function assistantReplyText(message: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">): string {
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
	if (message.stopReason !== "error") return text;
	const error = message.errorMessage?.trim();
	return [text, error ? `错误信息：${error}` : ""].filter(Boolean).join("\n\n") || NO_REPLY_TEXT;
}

/** Read visible text together with its producing model and entry, never tool output or reasoning. */
export function latestAssistantReply(
	entries: readonly SessionEntry[],
	afterEntryId?: string | null,
): ({ text: string; entryId: string } & ReplyModel) | undefined {
	let start = 0;
	if (afterEntryId) {
		const index = entries.findIndex((entry) => entry.id === afterEntryId);
		if (index < 0) throw new Error("pi 会话分支已改变，已取消本轮通知");
		start = index + 1;
	}
	for (let index = entries.length - 1; index >= start; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = assistantReplyText(entry.message);
		if (text) return { text, entryId: entry.id, model: entry.message.model, provider: entry.message.provider };
	}
	return undefined;
}

/** How many rounds, and how many wecom_send notices, a session's page shows. */
export const PAGE_ROUNDS = 3;

export interface PageRound {
	/** When the round's prompt was given. */
	at: Date;
	/** The prompt's text: what the round answers. */
	prompt: string;
	/** The round's last visible reply, or NO_REPLY_TEXT while it has none. */
	reply: string;
}

export interface PageNotice {
	at: Date;
	/** wecom_send's explicit content; a notice without one is its round's reply. */
	content: string;
}

/**
 * What a session's page shows besides its screen: the last rounds, newest first, and the wecom_send notices
 * with explicit content (a call that failed is left out). Read from the session branch, so a pi restart or
 * another window loses nothing; the page keeps no copy of its own.
 */
export function pageActivity(entries: readonly SessionEntry[]): { rounds: PageRound[]; notices: PageNotice[] } {
	const rounds: PageRound[] = [];
	const notices: PageNotice[] = [];
	const failed = new Set<string>();
	let reply: string | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (rounds.length >= PAGE_ROUNDS && notices.length >= PAGE_ROUNDS) break;
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (message.isError) failed.add(message.toolCallId);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (notices.length >= PAGE_ROUNDS) break;
				const content =
					block.type === "toolCall" && block.name === "wecom_send" ? block.arguments.content : undefined;
				if (typeof content === "string" && content.trim() && !failed.has((block as { id: string }).id))
					notices.push({ at: new Date(entry.timestamp), content });
			}
			reply ??= assistantReplyText(message) || undefined;
		} else if (message.role === "user") {
			if (rounds.length < PAGE_ROUNDS)
				rounds.push({
					at: new Date(entry.timestamp),
					prompt: promptText(message.content),
					reply: reply ?? NO_REPLY_TEXT,
				});
			reply = undefined;
		}
	}
	return { rounds, notices };
}

function promptText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	const text = content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	return text || (content.some((part) => part.type === "image") ? "［图片］" : "");
}

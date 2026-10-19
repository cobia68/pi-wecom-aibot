/** Read pi-owned session data here; only primitive notification snapshots cross IPC. */
import { posix, win32 } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { NO_REPLY_TEXT } from "../shared/notification.ts";
import type { NotificationSource } from "../shared/notification-types.ts";

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
	ctx: Pick<SourceContext, "model" | "modelRegistry">, reply?: ReplyModel,
): Pick<NotificationSource, "provider" | "modelName"> {
	const provider = reply?.provider || (reply?.model ? undefined : ctx.model?.provider);
	let model = ctx.model;
	if (reply?.model) {
		model = model?.id === reply.model && model.provider === provider
			? model
			: provider ? ctx.modelRegistry?.find(provider, reply.model) : undefined;
	} else if (provider && model?.provider !== provider) {
		model = undefined;
	}
	return {
		provider: provider || (reply?.model ? "未知供应商" : "未选择供应商"),
		modelName: model?.name?.trim() || reply?.model || model?.id || "未选择模型",
	};
}

/** Capture primitive values now; a later model switch or reconnect cannot relabel this source. */
export function captureNotificationSource(ctx: SourceContext, reply?: ReplyModel): NotificationSource {
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
	const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n").trim();
	if (message.stopReason !== "error") return text;
	const error = message.errorMessage?.trim();
	return [text, error ? `错误信息：${error}` : ""].filter(Boolean).join("\n\n") || NO_REPLY_TEXT;
}

/** Read visible text together with its producing model, never tool output or reasoning. */
export function latestAssistantReply(
	entries: readonly SessionEntry[], afterEntryId?: string | null,
): ({ text: string } & ReplyModel) | undefined {
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
		if (text) return { text, model: entry.message.model, provider: entry.message.provider };
	}
	return undefined;
}

/** The wecom_send tool: pi sends a notice to WeCom as this session's control card. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstLine } from "../shared/card.ts";
import { notificationPayload } from "../shared/notification.ts";
import { sentences } from "../shared/text.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import type { BridgeSession } from "./bridge-session.ts";
import { splitNextSteps, withoutNextSteps } from "./next-steps.ts";
import { type CompletionRequest, completionTitle } from "./notification-outbox.ts";
import { captureModelIdentity, captureSessionSource, latestAssistantReply } from "./session-data.ts";

/** What the tool reads from the extension at each call. */
export interface WecomSendHost {
	bridge(): BridgeSession | undefined;
	/** The session pi last reported, for a call that brings no context of its own. */
	context(): ExtensionContext | undefined;
	/** The chat the current WeCom task came from; undefined for a local run. */
	sourceChat(): ChatRef | undefined;
	/** Where this run's entries start: an omitted content is read from this run only. */
	runStart(): string | null;
	/** An explicit target, else the task's source chat, else the adopted default. */
	destination(chatId?: string, chatType?: 1 | 2, source?: ChatRef): ChatRef;
}

/** A notice's headline in the card's 窗口记录. */
const HEADLINE = 36;

export function registerWecomSend(pi: ExtensionAPI, host: WecomSendHost): void {
	pi.registerTool({
		name: "wecom_send",
		label: "WeCom Send",
		description:
			"Send a notification through the WeCom (企业微信) smart robot, as this session's control card. " +
			"The card shows the headline and the terminal's last lines; tapping the card's quote opens the session's page, which shows the whole Markdown body (or, for an omitted content, that reply). " +
			"The plugin adds the pi session, provider, model and working directory's final folder name; do not repeat them in content. " +
			"The first line of content becomes the headline, so lead with the conclusion. " +
			"Use userid for single chat, chatid for group chat, or omit chatid to reply to the chat that sent the current WeCom task (local runs use the configured default target). " +
			"The user must have messaged the robot before. " +
			"Omit content to send pi's latest visible reply from the current run; to resend an earlier answer, pass it as content. " +
			"For a completion notification, set after_settle=true, omit content, then continue the task and produce its final answer. " +
			"session_id validates the current session; it does not switch or resume another session. " +
			'To offer next steps on the card, end content with <!-- wecom_next ["prompt", ...] --> (at most 10); it is removed before sending.',
		parameters: Type.Object({
			chatid: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Target userid or group chatid. Omit to use the source chat of the current WeCom task, or configured defaultChatId for local runs.",
				}),
			),
			chat_type: Type.Optional(
				Type.Union([Type.Literal(1), Type.Literal(2)], {
					description: "1 = single chat, 2 = group chat. Default 1.",
				}),
			),
			session_id: Type.Optional(
				Type.String({ minLength: 1, description: "Current pi session ID. Omit to read it automatically." }),
			),
			content: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Markdown body; its first line is the card's headline. Omit to send pi's latest reply of this run.",
				}),
			),
			after_settle: Type.Optional(
				Type.Boolean({ description: "Wait for this run's final answer before sending. Default false." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, toolCtx) {
			signal?.throwIfAborted();
			if (params.content !== undefined && !params.content.trim()) throw new Error("content 不能为空");
			const target = host.destination(params.chatid, params.chat_type, host.sourceChat());
			const ctx = toolCtx ?? host.context();
			if (!ctx) throw new Error("pi 会话尚未启动");
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.session_id !== undefined && params.session_id !== sessionId) {
				throw new Error(`session_id 与当前 pi 会话不匹配（当前：${sessionId}）`);
			}
			const current = host.bridge();
			if (!current?.ready || current.identifyOnly)
				throw new Error("企业微信智能机器人未正式接入，请先运行 /wecom-aibot connect");
			const content = params.content;
			const request: CompletionRequest = {
				...target,
				source: captureSessionSource(ctx),
				content,
				...(content !== undefined ? { title: firstLine(withoutNextSteps(content), HEADLINE) ?? "会话通知" } : {}),
				afterEntryId: ctx.sessionManager.getLeafId(),
			};
			const details = {
				chatid: request.chatId,
				chat_type: request.chatType,
				session_id: sessionId,
				directory_name: request.source.directoryName,
			};
			if (params.after_settle && !ctx.isIdle()) {
				current.schedule(request);
				return {
					content: [
						{ type: "text", text: "已安排在本轮 pi 结束后发送通知，尚未投递。请正常完成任务并输出最终回复" },
					],
					details: { ...details, status: "queued" },
				};
			}
			// Only this run's replies: a tool call without text must not resend the previous run's answer.
			const answer =
				content === undefined ? latestAssistantReply(ctx.sessionManager.getBranch(), host.runStart()) : undefined;
			const raw = content ?? answer?.text;
			if (raw === undefined)
				throw new Error(
					"本轮还没有可摘录的文本回复；请用 content 指定正文，或设置 after_settle=true 在本轮结束后发送最终回复",
				);
			if (answer) request.source = { ...request.source, ...captureModelIdentity(ctx, answer) };
			// The card offers the body's next steps; the body sent to WeCom no longer has their comment.
			const body = splitNextSteps(raw);
			if (!body.text) throw new Error("content 只有下一步注释，没有正文");
			await current.notify(
				{ chatId: request.chatId, chatType: request.chatType },
				notificationPayload("notice", request.source, body.text, {
					title: request.title ?? (params.after_settle ? completionTitle(false) : "会话通知"),
				}),
				{ ctx, signal, steps: body.steps },
			);
			return {
				// The model wrote the comment: it is told what of it the card did not take.
				content: [{ type: "text", text: sentences(`已发送到 ${request.chatId}`, body.problem) }],
				details: {
					...details,
					provider: request.source.provider,
					model_name: request.source.modelName,
					status: "sent",
				},
			};
		},
	});
}

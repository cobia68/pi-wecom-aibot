/**
 * The notifications one registration owes. Only a known not-sent result is retained and retried; a rejection
 * is reported for user action, and an unknown ACK outcome is never pushed twice.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliveryFailure } from "../shared/delivery.ts";
import { NO_REPLY_TEXT, notificationPayload } from "../shared/notification.ts";
import type { GatewayNotification, SessionSource } from "../shared/notification-types.ts";
import { errorMessage } from "../shared/text.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import { splitNextSteps } from "./next-steps.ts";
import { captureModelIdentity, latestAssistantReply } from "./session-data.ts";

const MAX_QUEUE_SIZE = 50;

/** How a run ended, for the done state of the control card its result is sent as. */
export type RunOutcome = "done" | "aborted" | "failed";

/** A wecom_send with after_settle or the result of a finished run; control cards have their own lifecycle. */
export interface CompletionRequest {
	chatId: string;
	chatType: 1 | 2;
	source: SessionSource;
	/** Explicit wecom_send content: the card's headline is its first line, its page shows it all. */
	content?: string;
	/** The frozen automatic reply. */
	result?: string;
	/** The card's headline. */
	title?: string;
	aborted?: boolean;
	/** pi never ran the task: the card's state is 未执行. */
	failed?: boolean;
	afterEntryId: string | null;
}

export interface OutboxHost {
	isReady(): boolean;
	/** Counts subscriptions; a changed value during an attempt means a recovery must be re-checked. */
	subscription(): number;
	context(): ExtensionContext | undefined;
	send(chat: ChatRef, notification: GatewayNotification): Promise<void>;
	/**
	 * The notification as a new copy of the session's control card, `note` in its 窗口记录, its page showing
	 * the body; undefined (or a throw) leaves the gateway to send the body as Markdown.
	 */
	controlCard(
		ctx: ExtensionContext,
		outcome: RunOutcome,
		note: string,
		source?: SessionSource,
		steps?: readonly string[],
	): GatewayNotification["control"];
	log(line: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

type Phase =
	| { kind: "pending" }
	/** The payload is frozen; a reconnect sends exactly this. */
	| { kind: "ready"; notification: GatewayNotification }
	| { kind: "delivering"; notification: GatewayNotification; promise: Promise<void> };

interface Entry {
	request: CompletionRequest;
	phase: Phase;
}

export class NotificationOutbox {
	private readonly waiting = new Map<string, Entry>();
	/** Handed over at a ready connection: ready again after a known not-sent result, or delivering. */
	private readonly handedOver = new Set<Entry>();
	private disposed = false;

	constructor(private readonly host: OutboxHost) {}

	get size(): number {
		return this.waiting.size + this.handedOver.size;
	}

	schedule(request: CompletionRequest): void {
		const key = keyOf(request);
		if (!this.waiting.has(key) && this.size >= MAX_QUEUE_SIZE) throw new Error("待发送通知过多，请稍后重试");
		this.waiting.set(key, { request, phase: { kind: "pending" } });
	}

	/** A scheduled notification to the same conversation owns the final delivery; handed-over entries never absorb it. */
	queueResult(request: CompletionRequest): void {
		const key = keyOf(request);
		if (this.waiting.has(key)) return;
		this.waiting.set(key, { request, phase: { kind: "pending" } });
	}

	async prepare(ctx: ExtensionContext, aborted: boolean, boundary: "settled" | "ready" = "settled"): Promise<void> {
		if (this.disposed) return;
		for (const [key, entry] of this.waiting) {
			if (entry.phase.kind !== "pending") continue;
			try {
				const request = entry.request;
				// A readiness change is not the end of a run: scheduled completions still wait for agent_settled.
				if (boundary === "ready" && request.result === undefined) continue;
				if (request.source.sessionId !== ctx.sessionManager.getSessionId()) {
					this.cancel(key, entry, new Error("pi session_id 已改变，已取消通知"));
					continue;
				}
				const answer =
					request.content === undefined && request.result === undefined
						? latestAssistantReply(ctx.sessionManager.getBranch(), request.afterEntryId)
						: undefined;
				if (answer) request.source = { ...request.source, ...captureModelIdentity(ctx, answer) };
				const ended = request.aborted ?? aborted;
				// An extracted completion is titled by how its run ended, known only now.
				const title = request.title ?? (request.content === undefined ? completionTitle(ended) : undefined);
				// A result never carries content, so it always has a title here.
				const kind = request.result !== undefined ? "result" : "notice";
				// The card offers the body's next steps; nothing sent carries their comment.
				const body = splitNextSteps(request.content ?? request.result ?? answer?.text ?? NO_REPLY_TEXT);
				if (body.problem) this.host.log(body.problem);
				// The session's control card, drawn now while the terminal shows how the run ended.
				const control = this.controlCard(
					ctx,
					request.failed ? "failed" : ended ? "aborted" : "done",
					kind === "result" ? (title as string) : noteOf({ kind, title }),
					request.source,
					body.steps,
				);
				const notification = notificationPayload(kind, request.source, body.text || NO_REPLY_TEXT, {
					title,
					aborted: ended,
					...(control ? { control } : {}),
				});
				entry.phase = { kind: "ready", notification };
			} catch (error) {
				this.cancel(key, entry, error);
			}
		}
		await this.flush();
	}

	async flush(): Promise<void> {
		if (this.disposed) return;
		// Transfer only when ready: queueResult must still find a completion prepared offline, or the run gets two cards.
		if (this.host.isReady())
			for (const [key, entry] of this.waiting) {
				if (entry.phase.kind !== "ready") continue;
				this.waiting.delete(key);
				this.handedOver.add(entry);
			}
		const attempts: Promise<void>[] = [];
		for (const entry of this.handedOver) {
			if (entry.phase.kind === "delivering") {
				attempts.push(entry.phase.promise);
				continue;
			}
			if (!this.host.isReady() || entry.phase.kind !== "ready") continue;
			const notification = entry.phase.notification;
			const subscription = this.host.subscription();
			let retained = false;
			const attempt = this.host
				.send({ chatId: entry.request.chatId, chatType: entry.request.chatType }, notification)
				.then(() => {
					this.handedOver.delete(entry);
					if (!this.disposed)
						this.host.log(`notification delivered for session ${entry.request.source.sessionId}`);
				})
				.catch((error: unknown) => {
					if (this.disposed) return;
					const outcome = deliveryFailure(error);
					if (outcome === "not_sent") {
						retained = this.handedOver.has(entry);
						if (retained) this.host.log(`notification not sent; retained for reconnect: ${errorMessage(error)}`);
						return;
					}
					this.handedOver.delete(entry);
					this.host.log(`notification failed (${outcome}): ${errorMessage(error)}`);
					this.host.notify(
						`企微通知${outcome === "rejected" ? "被拒绝" : "未确认送达"}：${errorMessage(error)}`,
						"warning",
					);
				})
				.finally(() => {
					if (this.handedOver.has(entry) && entry.phase.kind === "delivering")
						entry.phase = { kind: "ready", notification };
					// A resubscribe during this attempt already passed it by; retry here or that recovery is lost.
					if (retained && !this.disposed && this.host.subscription() !== subscription && this.host.isReady()) {
						void this.flush().catch((error: unknown) =>
							this.host.log(`notification retry failed: ${errorMessage(error)}`),
						);
					}
				});
			entry.phase = { kind: "delivering", notification, promise: attempt };
			attempts.push(attempt);
		}
		await Promise.all(attempts);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.waiting.clear();
		this.handedOver.clear();
	}

	private controlCard(
		ctx: ExtensionContext,
		outcome: RunOutcome,
		note: string,
		source: SessionSource,
		steps: readonly string[],
	): GatewayNotification["control"] {
		try {
			return this.host.controlCard(ctx, outcome, note, source, steps);
		} catch (error) {
			this.host.log(`sent as Markdown: the control card could not be drawn: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private cancel(key: string, entry: Entry, error: unknown): void {
		if (this.disposed || this.waiting.get(key) !== entry) return;
		this.waiting.delete(key);
		this.host.log(`notification cancelled: ${errorMessage(error)}`);
		this.host.notify(`企微通知已取消：${errorMessage(error)}`, "warning");
	}
}

/** 窗口记录 of a published notice: its headline, marked as a notice unless it leads with its own emoji. */
export function noteOf(notification: Pick<GatewayNotification, "kind" | "title">): string {
	if (notification.kind === "test") return "🧪 部署测试：点任一按钮验证回调";
	const title = notification.title ?? "会话通知";
	return /^\p{Extended_Pictographic}/u.test(title) ? title : `📣 ${title}`;
}

/** The headline of a run's answer when nobody named one. */
export function completionTitle(aborted: boolean): string {
	return aborted ? "⛔ 本轮已中止" : "✅ 本轮完成";
}

function keyOf(request: Pick<CompletionRequest, "source" | "chatId" | "chatType">): string {
	return JSON.stringify([request.source.sessionId, request.chatType, request.chatId]);
}

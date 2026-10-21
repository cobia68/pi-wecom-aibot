/**
 * The notifications one registration owes. An entry moves through explicit phases, so "may still be
 * prepared", "frozen and waiting for a connection" and "handed to the gateway, ACK pending" are never
 * inferred from a combination of optional fields.
 *
 * Delivery certainty is the point of this module: only a known not-sent result is retained and retried;
 * a rejection is reported, and an unknown ACK outcome is never pushed twice.
 */
import { rmSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliveryFailure } from "../shared/delivery.ts";
import { NO_REPLY_TEXT, notificationPayload, notificationProblem } from "../shared/notification.ts";
import type { GatewayNotification, NotificationSource } from "../shared/notification-types.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import type { WeComConfig } from "./config.ts";
import { captureModelIdentity, latestAssistantReply } from "./notification-source.ts";

const MAX_QUEUE_SIZE = 50;

/** A wecom_send with after_settle, or the result of a finished task: content is read when the run ends. */
export interface CompletionRequest {
	/** The connection entry has its own outbox key; it cannot replace a task's final notification. */
	kind?: "connect";
	taskId?: string;
	chatId: string;
	chatType: 1 | 2;
	source: NotificationSource;
	content?: string;
	/** The frozen automatic reply; content holds explicit wecom_send bodies or a connection entry. */
	result?: string;
	aborted?: boolean;
	/** A failure explanation, never a screen capture: it can show what the user is doing locally. */
	textOnly?: boolean;
	tailParagraphs?: number;
	afterEntryId: string | null;
}

/** What the outbox needs from the session that owns it. */
export interface OutboxHost {
	isReady(): boolean;
	/** Counts subscriptions; a changed value during an attempt means a recovery must be re-checked. */
	subscription(): number;
	sendMode(): WeComConfig["sendMode"];
	context(): ExtensionContext | undefined;
	/** Render this notification as a screen image; failures return the Markdown fallback. */
	prepareImage(
		notification: GatewayNotification,
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<GatewayNotification>;
	send(chat: ChatRef, notification: GatewayNotification): Promise<void>;
	log(line: string): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Aborted when the session is disposed. */
	signal: AbortSignal;
}

/** Where an entry is in its life; only these transitions exist. */
type Phase =
	/** Scheduled or created from a finished task; nothing is frozen yet. */
	| { kind: "pending" }
	/** An image is being rendered; settle and reconnect must not start a second capture. */
	| { kind: "preparing"; promise: Promise<void> }
	/** The payload is frozen; a reconnect sends exactly this. */
	| { kind: "ready"; notification: GatewayNotification }
	/** Handed to the gateway; concurrent settle/reconnect events share this attempt. */
	| { kind: "delivering"; notification: GatewayNotification; promise: Promise<void> };

interface Entry {
	request: CompletionRequest;
	phase: Phase;
}

export class NotificationOutbox {
	/** Prepared but not yet handed over: pending, preparing or ready. */
	private readonly waiting = new Map<string, Entry>();
	/** Handed over at a ready connection: ready again after a known not-sent result, or delivering. */
	private readonly handedOver = new Set<Entry>();
	private disposed = false;

	constructor(private readonly host: OutboxHost) {}

	get size(): number {
		return this.waiting.size + this.handedOver.size;
	}

	/** Send when the run ends; the latest call for the same conversation wins. */
	schedule(request: CompletionRequest): void {
		const key = keyOf(request);
		if (!this.waiting.has(key) && this.size >= MAX_QUEUE_SIZE) throw new Error("待发送通知过多，请稍后重试");
		this.waiting.set(key, { request, phase: { kind: "pending" } });
	}

	/**
	 * A finished task's result. A scheduled notification to the same conversation owns the final
	 * delivery, and previous runs' attempted deliveries cannot swallow this newer result.
	 */
	queueResult(request: CompletionRequest): void {
		const key = keyOf(request);
		const scheduled = this.waiting.get(key);
		if (scheduled) {
			scheduled.request.taskId = request.taskId;
			if (scheduled.phase.kind === "ready")
				scheduled.phase.notification = { ...scheduled.phase.notification, taskId: request.taskId };
			return;
		}
		this.waiting.set(key, { request, phase: { kind: "pending" } });
	}

	/** Freeze every waiting result, render images where the mode asks for one, then deliver what is ready. */
	async prepare(ctx: ExtensionContext, aborted: boolean, boundary: "settled" | "ready" = "settled"): Promise<void> {
		if (this.disposed) return;
		const images: Promise<void>[] = [];
		for (const [key, entry] of this.waiting) {
			if (entry.phase.kind === "ready") continue;
			if (entry.phase.kind === "preparing") {
				images.push(entry.phase.promise);
				continue;
			}
			try {
				const request = entry.request;
				if (request.kind === "connect" && !this.host.isReady()) continue;
				// A readiness change is not the end of a run: scheduled completions still wait for agent_settled.
				if (boundary === "ready" && request.kind !== "connect" && request.result === undefined) continue;
				if (request.source.sessionId !== ctx.sessionManager.getSessionId())
					throw new Error("pi session_id 已改变，已取消通知");
				const answer =
					request.content === undefined && request.result === undefined
						? latestAssistantReply(ctx.sessionManager.getBranch(), request.afterEntryId)
						: undefined;
				if (answer) request.source = { ...request.source, ...captureModelIdentity(ctx, answer) };
				// Autonomous replies keep the tail like a normal reply; scheduled excerpts use completion rules.
				const ready = notificationPayload(
					request.kind ?? (request.result !== undefined ? "reply" : "completion"),
					request.source,
					request.content ?? request.result ?? answer?.text ?? NO_REPLY_TEXT,
					{
						tailParagraphs: request.tailParagraphs,
						aborted: request.kind === "connect" ? false : (request.aborted ?? aborted),
						taskId: request.taskId,
					},
				);
				// Validate the Markdown fallback before any image side effects; the gateway renders it once.
				const problem = notificationProblem(ready.source, ready.text, ready);
				if (problem) throw new Error(problem);
				// All notifications follow the same mode; failure explanations must never leak a local screen.
				if (request.textOnly || this.host.sendMode() !== "image") {
					entry.phase = { kind: "ready", notification: ready };
					continue;
				}
				const prepare = this.host
					.prepareImage(ready, ctx, this.host.signal)
					.then((prepared) => {
						if (this.disposed || this.waiting.get(key) !== entry) {
							this.removeImage(prepared);
							return;
						}
						entry.phase = {
							kind: "ready",
							notification: { ...prepared, ...(request.taskId ? { taskId: request.taskId } : {}) },
						};
					})
					.catch((error: unknown) => this.cancel(key, entry, error));
				entry.phase = { kind: "preparing", promise: prepare };
				images.push(prepare);
			} catch (error) {
				this.cancel(key, entry, error);
			}
		}
		// Text notifications start their writes synchronously; images flush once their files are ready.
		const flush = this.flush();
		if (images.length) await Promise.all(images).then(() => this.flush());
		else await flush;
	}

	/** Transfer ready entries at a live connection and deliver them, one attempt per entry at a time. */
	async flush(): Promise<void> {
		if (this.disposed) return;
		// Transfer only at a ready connection: queueResult first needs to see any completion prepared
		// while offline, so it does not create an extra automatic reply for that same run.
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
			// Content stays frozen through the ACK; a newer run has an independent entry.
			const notification = entry.phase.notification;
			const subscription = this.host.subscription();
			let retained = false;
			const attempt = this.host
				.send({ chatId: entry.request.chatId, chatType: entry.request.chatType }, notification)
				.then(() => {
					this.handedOver.delete(entry);
					this.removeImage(notification);
					if (!this.disposed)
						this.host.log(`notification delivered for session ${entry.request.source.sessionId}`);
				})
				.catch((error: unknown) => {
					if (this.disposed) return;
					const outcome = deliveryFailure(error);
					if (outcome === "not_sent") {
						retained = this.handedOver.has(entry);
						if (retained) this.host.log(`notification not sent; retained for reconnect: ${errMsg(error)}`);
						return;
					}
					this.handedOver.delete(entry);
					this.removeImage(notification);
					// A rejection needs user action; an unknown ACK outcome must never trigger an automatic duplicate.
					this.host.log(`notification failed (${outcome}): ${errMsg(error)}`);
					this.host.notify(
						`企微通知${outcome === "rejected" ? "被拒绝" : "未确认送达"}：${errMsg(error)}`,
						"warning",
					);
				})
				.finally(() => {
					if (this.handedOver.has(entry) && entry.phase.kind === "delivering")
						entry.phase = { kind: "ready", notification };
					// The subscribed event may have already visited this in-flight attempt. Do not miss that recovery.
					if (retained && !this.disposed && this.host.subscription() !== subscription && this.host.isReady()) {
						void this.flush().catch((error: unknown) =>
							this.host.log(`notification retry failed: ${errMsg(error)}`),
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
		for (const entry of this.waiting.values()) this.removeImage(imageOf(entry));
		for (const entry of this.handedOver) this.removeImage(imageOf(entry));
		this.waiting.clear();
		this.handedOver.clear();
	}

	private cancel(key: string, entry: Entry, error: unknown): void {
		if (this.disposed || this.waiting.get(key) !== entry) return;
		this.waiting.delete(key);
		this.host.log(`notification cancelled: ${errMsg(error)}`);
		this.host.notify(`企微通知已取消：${errMsg(error)}`, "warning");
	}

	/** A rendered notification can show the screen, so a file that cannot be deleted is reported, not ignored. */
	private removeImage(notification: GatewayNotification | undefined): void {
		removeNotificationImage(notification, (line) => this.host.log(line));
	}
}

/** Delete a notification's temporary PNG; used for direct sends as well as queued ones. */
export function removeNotificationImage(
	notification: GatewayNotification | undefined,
	log: (line: string) => void,
): void {
	const path = notification?.image?.path;
	if (!path) return;
	try {
		rmSync(path, { force: true });
	} catch (error) {
		log(`could not delete notification image ${path}: ${errMsg(error)}`);
	}
}

function imageOf(entry: Entry): GatewayNotification | undefined {
	return entry.phase.kind === "ready" || entry.phase.kind === "delivering" ? entry.phase.notification : undefined;
}

function keyOf(request: Pick<CompletionRequest, "source" | "chatId" | "chatType" | "kind">): string {
	return JSON.stringify([request.source.sessionId, request.chatType, request.chatId, request.kind ?? "result"]);
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

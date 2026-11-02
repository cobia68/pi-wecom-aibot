/**
 * This session's document page. A card waits for its own write (within a budget), never trusts an old URL
 * alone. Writes are serialized; refreshes and automatic writes waiting together share the latest snapshot.
 * A timed-out write may finish later, but the card already sent with a text quote stays a text quote.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_REPLY_TEXT } from "../shared/notification.ts";
import type { GatewayNotification, SessionSource } from "../shared/notification-types.ts";
import { errorMessage } from "../shared/text.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import type { ContentDisplay } from "./config.ts";
import { captureSessionSource, pageActivity } from "./session-data.ts";
import { pageMarkdown, type SessionDoc } from "./session-doc.ts";

/** Includes first-use document/page/icon creation; no slow service may indefinitely delay a notification. */
const PAGE_WAIT_MS = 6_000;
/** Leaves the gateway enough time to update a clicked card inside WeCom's five seconds. */
const REFRESH_BUDGET_MS = 3_300;
const AUTO_WRITE_MS = 30_000;

type PageDocument = Pick<SessionDoc, "write" | "pageUrl" | "iconUrl">;

export interface SessionPageHost {
	sessionId: string;
	/** The session is formally connected and not disposed. */
	live(): boolean;
	context(): ExtensionContext | undefined;
	contentDisplay(): ContentDisplay;
	doc(): PageDocument | undefined;
	running(): boolean;
	maskText(text: string): string;
	log(line: string): void;
}

type PageResult = { ok: true; url: string } | { ok: false; error: string };

interface PendingWrite {
	doc: PageDocument;
	source: SessionSource;
	markdown: string;
	viewer?: string;
	done: Promise<PageResult>;
	/** Undefined while pending: even an existing page is not known to contain this snapshot yet. */
	result?: PageResult;
}

export class SessionPage {
	private writing: Promise<unknown> = Promise.resolve();
	private next: PendingWrite | undefined;
	private latest: PendingWrite | undefined;
	private lastWrite = Number.NEGATIVE_INFINITY;

	constructor(private readonly host: SessionPageHost) {}

	get problem(): boolean {
		return this.latest?.doc === this.document() && this.latest?.result?.ok === false;
	}

	/** A successful write in this registration, still backed by a readable local record and the same config. */
	url(): string | undefined {
		const latest = this.latest;
		const doc = this.document();
		return doc && latest?.doc === doc && latest.result?.ok && doc.pageUrl(this.host.sessionId) === latest.result.url
			? latest.result.url
			: undefined;
	}

	icon(): string | undefined {
		return this.document()?.iconUrl();
	}

	/** Each publication owns a write: another notification cannot replace its body while it waits. */
	async publish(
		ctx: ExtensionContext,
		chat: ChatRef,
		notification?: GatewayNotification,
	): Promise<string | undefined> {
		try {
			// Preserve document membership rules: introducing a control card invites its single-chat user;
			// sending a notice alone does not grant its recipient access to every session in the document.
			const viewer = !notification && chat.chatType === 1 ? chat.chatId : undefined;
			const pending = this.queue(ctx, viewer, notification, false);
			if (!pending) return undefined;
			const result = await this.wait(pending, PAGE_WAIT_MS);
			return result.ok &&
				this.host.live() &&
				pending.doc === this.document() &&
				pending.doc.pageUrl(this.host.sessionId) === result.url
				? result.url
				: undefined;
		} catch (error) {
			this.host.log(`文档页准备失败，正文回退到文字引用区：${errorMessage(error)}`);
			return undefined;
		}
	}

	/** A finished turn keeps an existing page current, including retrying a failed write; it never creates one. */
	writeAuto(): void {
		const ctx = this.host.context();
		if (!ctx || !this.document()?.pageUrl(this.host.sessionId) || Date.now() - this.lastWrite < AUTO_WRITE_MS) return;
		try {
			this.queue(ctx);
		} catch (error) {
			this.host.log(`文档页自动写入未准备好：${errorMessage(error)}`);
		}
	}

	async refresh(viewer: string): Promise<string> {
		if (this.host.contentDisplay() === "inline") return "已刷新；正文保留在文字引用区，不写文档";
		if (!this.document()) return "已刷新；未配置文档，正文使用文字引用区";
		const ctx = this.host.context();
		if (!ctx) return "会话已停止，未写入文档";
		const started = Date.now();
		try {
			const pending = this.queue(ctx, viewer);
			if (!pending) return "会话已停止，未写入文档";
			const result = await this.wait(pending, REFRESH_BUDGET_MS);
			return result.ok
				? `已刷新（${((Date.now() - started) / 1000).toFixed(1)} 秒）`
				: `文档写入失败：${result.error}`;
		} catch (error) {
			return `文档写入失败：${errorMessage(error)}`;
		}
	}

	private document(): PageDocument | undefined {
		return this.host.contentDisplay() === "linked" ? this.host.doc() : undefined;
	}

	/** Snapshot before any await: a later local run, model switch or reconnect cannot supply another body. */
	private queue(
		ctx: ExtensionContext,
		viewer?: string,
		notification?: GatewayNotification,
		coalesce = true,
	): PendingWrite | undefined {
		const doc = this.document();
		if (!this.host.live() || !doc || ctx.sessionManager.getSessionId() !== this.host.sessionId) return undefined;
		const source = notification?.source ?? captureSessionSource(ctx);
		const { rounds, notices } = pageActivity(ctx.sessionManager.getBranch());
		// An explicit send (or an unrecorded final reply) may not be in pi's branch yet. Link only a page that
		// includes the body this card carries, without duplicating one the branch already contains.
		if (
			notification &&
			!rounds.some((round) => round.reply.trim() === notification.text.trim()) &&
			!notices.some((notice) => notice.content.trim() === notification.text.trim())
		)
			notices.unshift({ at: new Date(), content: notification.text });
		const mask = (text: string) => this.host.maskText(text);
		const running = this.host.running();
		const markdown = pageMarkdown(source, {
			state: running ? "执行中" : "空闲",
			at: new Date(),
			rounds: rounds.map((round, index) => ({
				...round,
				prompt: mask(round.prompt),
				reply:
					running && index === 0 && round.reply === NO_REPLY_TEXT ? "（执行中，还没有回复）" : mask(round.reply),
			})),
			notices: notices.slice(0, 3).map((notice) => ({ ...notice, content: mask(notice.content) })),
		});
		if (coalesce && this.next?.doc === doc) {
			this.next.source = source;
			this.next.markdown = markdown;
			this.next.viewer ??= viewer;
			return this.next;
		}
		const pending: PendingWrite = {
			doc,
			source,
			markdown,
			viewer,
			done: this.writing.then(() => this.overwrite(pending)),
		};
		// A publication separates batches: a later refresh must not join one queued before this publication.
		this.next = coalesce ? pending : undefined;
		this.latest = pending;
		this.writing = pending.done;
		this.lastWrite = Date.now();
		return pending;
	}

	/** Never rejects: the next write waits on this one, even when the service refused it. */
	private async overwrite(pending: PendingWrite): Promise<PageResult> {
		if (this.next === pending) this.next = undefined;
		try {
			if (
				!this.host.live() ||
				pending.doc !== this.document() ||
				this.host.context()?.sessionManager.getSessionId() !== this.host.sessionId
			) {
				pending.result = { ok: false, error: "会话或文档配置已改变，未写入" };
			} else {
				const { url } = await pending.doc.write(pending.source, pending.markdown, pending.viewer);
				pending.result = { ok: true, url };
			}
		} catch (error) {
			const reason = this.host.maskText(errorMessage(error));
			this.host.log(`文档页写入失败：${reason}`);
			pending.result = { ok: false, error: reason };
		}
		return pending.result;
	}

	private async wait(pending: PendingWrite, ms: number): Promise<PageResult> {
		const result = await within(pending.done, ms);
		if (result) return result;
		const error = `等待文档写入超过 ${ms / 1000} 秒，正文回退到文字引用区`;
		this.host.log(error);
		pending.result = { ok: false, error };
		return pending.result;
	}
}

/** Undefined at the deadline; a late write still settles its queue, but cannot change an already-sent card. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * This session's document page. A card waits for its own write (within a budget), never trusts an old URL
 * alone. Writes are serialized; refreshes and automatic writes waiting together share the latest snapshot.
 * A timed-out write may finish later, but cannot mutate an already-published card; a click can show recovery.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_REPLY_TEXT } from "../shared/notification.ts";
import type { GatewayNotification, SessionSource } from "../shared/notification-types.ts";
import { errorMessage } from "../shared/text.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import type { ContentDisplay } from "./config.ts";
import { DocError } from "./doc-mcp.ts";
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

interface PageFailure {
	ok: false;
	/** Masked technical detail for the operation note and pi log. */
	error: string;
	/** A short, actionable quote, never the reply body or terminal. */
	quote: string;
}
type PageResult = { ok: true; url: string } | PageFailure;
export type PageView = { pageUrl: string; pageProblem?: never } | { pageProblem: string; pageUrl?: never };

const UNCONFIGURED = "会话文档未配置\n请在 pi 执行 /wecom-aibot config edit\n填写 docMcpUrl 后点「刷新卡片」";
const NOT_READY = "会话文档尚未更新\n请稍后点「刷新卡片」重试";
const CHANGED = "会话或文档配置已改变\n请点「刷新卡片」重新写入";
const TIMED_OUT = "文档写入超时\n未回退显示正文\n请稍后点「刷新卡片」重试";
const AUTHORIZATION = "文档权限不足或授权已到期\n工作台 → 智能机器人 → 可使用权限\n重新授权后点「刷新卡片」";
const UNAVAILABLE = "会话文档不可用\n请在 pi 查看日志并检查文档配置\n处理后点「刷新卡片」重试";

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
	private preparationFailure: { doc: PageDocument | undefined; result: PageFailure } | undefined;
	private lastWrite = Number.NEGATIVE_INFINITY;

	constructor(private readonly host: SessionPageHost) {}

	get problem(): boolean {
		return this.view()?.pageProblem !== undefined;
	}

	/** linked never borrows an older URL, the terminal or the reply body when its page is unavailable. */
	view(): PageView | undefined {
		if (this.host.contentDisplay() !== "linked") return undefined;
		const doc = this.document();
		if (!doc) return { pageProblem: UNCONFIGURED };
		if (this.preparationFailure?.doc === doc) return { pageProblem: this.preparationFailure.result.quote };
		const latest = this.latest;
		if (latest?.doc !== doc || !latest.result) return { pageProblem: NOT_READY };
		if (!latest.result.ok) return { pageProblem: latest.result.quote };
		return doc.pageUrl(this.host.sessionId) === latest.result.url
			? { pageUrl: latest.result.url }
			: { pageProblem: UNAVAILABLE };
	}

	icon(): string | undefined {
		return this.document()?.iconUrl();
	}

	/** Each publication owns a write: another notification cannot replace its body while it waits. */
	async publish(
		ctx: ExtensionContext,
		chat: ChatRef,
		notification?: GatewayNotification,
	): Promise<PageView | undefined> {
		try {
			// Preserve document membership rules: introducing a control card invites its single-chat user;
			// sending a notice alone does not grant its recipient access to every session in the document.
			const viewer = !notification && chat.chatType === 1 ? chat.chatId : undefined;
			const pending = this.queue(ctx, viewer, notification, false);
			if (!pending) return this.view();
			const result = await this.wait(pending, PAGE_WAIT_MS);
			if (!result.ok) return { pageProblem: result.quote };
			return this.host.live() &&
				pending.doc === this.document() &&
				pending.doc.pageUrl(this.host.sessionId) === result.url
				? { pageUrl: result.url }
				: { pageProblem: CHANGED };
		} catch (error) {
			return { pageProblem: this.failPreparation(error).quote };
		}
	}

	/** A finished turn keeps an existing page current, including retrying a failed write; it never creates one. */
	writeAuto(): void {
		const ctx = this.host.context();
		if (!ctx || !this.document()?.pageUrl(this.host.sessionId) || Date.now() - this.lastWrite < AUTO_WRITE_MS) return;
		try {
			this.queue(ctx);
		} catch (error) {
			this.failPreparation(error);
		}
	}

	async refresh(viewer: string): Promise<string> {
		if (this.host.contentDisplay() === "inline") return "已刷新；正文保留在文字引用区，不写文档";
		if (!this.document()) return "未配置 docMcpUrl，未写入文档；请先配置会话文档";
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
			return `文档写入失败：${this.failPreparation(error).error}`;
		}
	}

	private failure(error: unknown): PageFailure {
		return { ok: false, error: this.host.maskText(errorMessage(error)), quote: failureQuote(error) };
	}

	private failPreparation(error: unknown): PageFailure {
		const result = this.failure(error);
		this.preparationFailure = { doc: this.document(), result };
		this.host.log(`文档页准备失败：${result.error}`);
		return result;
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
		this.preparationFailure = undefined;
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
				pending.result = { ok: false, error: "会话或文档配置已改变，未写入", quote: CHANGED };
			} else {
				const { url } = await pending.doc.write(pending.source, pending.markdown, pending.viewer);
				pending.result = { ok: true, url };
			}
		} catch (error) {
			pending.result = this.failure(error);
			this.host.log(`文档页写入失败：${pending.result.error}`);
		}
		return pending.result;
	}

	private async wait(pending: PendingWrite, ms: number): Promise<PageResult> {
		const result = await within(pending.done, ms);
		if (result) return result;
		const error = `等待文档写入超过 ${ms / 1000} 秒`;
		this.host.log(error);
		pending.result = { ok: false, error, quote: TIMED_OUT };
		return pending.result;
	}
}

/** Only an authentication/permission error suggests renewal; timeouts, network failures and bad records do not. */
function failureQuote(error: unknown): string {
	if (!(error instanceof DocError)) return UNAVAILABLE;
	if (
		(error.kind === "http" && (error.errcode === 401 || error.errcode === 403)) ||
		(error.kind === "tool" && error.errcode === 851008) ||
		((error.kind === "tool" || error.kind === "rpc") &&
			/权限(?:不足|已?(?:失效|过期|到期))|(?:缺少|没有|无|未获得)(?:文档|接口|访问|操作)?(?:权限|授权)|授权(?:已)?(?:失效|过期|到期|失败)|未(?:经)?授权|unauthori[sz]ed|forbidden|no (?:authori[sz]ation|permission)|(?:permission|access) denied|(?:api.?key|access.?token|credential).*(?:expired|invalid|过期|失效)|(?:expired|invalid).*(?:api.?key|access.?token|credential)/i.test(
				error.message,
			))
	)
		return AUTHORIZATION;
	if (error.kind === "network")
		return /超时|timed?\s*out|timeout/i.test(error.message)
			? TIMED_OUT
			: "文档服务连接失败\n请检查网络或稍后重试\n点「刷新卡片」重新写入";
	return UNAVAILABLE;
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

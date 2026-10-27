/**
 * This session's page in the session document: made before a control card goes out, rewritten from the
 * session's branch after each card, refresh and finished turn. One write at a time; writes asked for while
 * one runs share the next, so the page never ends older than its latest request.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NO_REPLY_TEXT } from "../shared/notification.ts";
import { errorMessage } from "../shared/text.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import { captureSessionSource, pageActivity } from "./session-data.ts";
import { pageMarkdown, type SessionDoc } from "./session-doc.ts";

/** A first page with its document and icon took about 4.4 s; a slow service must not hold a card back. */
const PAGE_WAIT_MS = 6_000;
/** A refresh answers within this, so the gateway still updates the card inside WeCom's five seconds. */
const REFRESH_BUDGET_MS = 3_300;
/** A finished turn rewrites an existing page at most this often. */
const AUTO_WRITE_MS = 30_000;

export interface SessionPageHost {
	sessionId: string;
	/** The session is formally connected and not disposed. */
	live(): boolean;
	context(): ExtensionContext | undefined;
	doc(): SessionDoc | undefined;
	running(ctx: ExtensionContext): boolean;
	maskText(text: string): string;
	log(line: string): void;
}

type PageResult = { ok: true } | { ok: false; error: string };

export class SessionPage {
	/** The latest write or make failed: the card turns red until one succeeds. */
	problem = false;
	private writing: Promise<unknown> = Promise.resolve();
	private next: { viewer?: string; done: Promise<PageResult> } | undefined;
	private lastWrite = Number.NEGATIVE_INFINITY;

	constructor(private readonly host: SessionPageHost) {}

	url(): string | undefined {
		return this.host.doc()?.pageUrl(this.host.sessionId);
	}

	icon(): string | undefined {
		return this.host.doc()?.iconUrl();
	}

	/** Before a card goes out: the page (and the icon), so the card links it; one too slow is linked by later cards. */
	async ensure(ctx: ExtensionContext, chat: ChatRef): Promise<void> {
		const doc = this.host.doc();
		if (!doc) return;
		const made = doc.ensure(captureSessionSource(ctx), chat.chatType === 1 ? chat.chatId : undefined).then(
			() => true,
			(error: unknown) => {
				this.problem = true;
				this.host.log(`文档页未建好，控制卡先不带链接：${errorMessage(error)}`);
				return true;
			},
		);
		if (!(await within(made, PAGE_WAIT_MS, false)))
			this.host.log(`文档页 ${PAGE_WAIT_MS / 1000} 秒内没建好，控制卡先不带链接；页面建好后，之后的卡片带上`);
	}

	/** `viewer` is added as a reader. */
	write(viewer?: string): Promise<PageResult> {
		if (this.next) {
			this.next.viewer ??= viewer;
			return this.next.done;
		}
		const next: { viewer?: string; done: Promise<PageResult> } = { viewer, done: Promise.resolve({ ok: true }) };
		next.done = this.writing.then(() => {
			if (this.next === next) this.next = undefined;
			return this.overwrite(next.viewer);
		});
		this.next = next;
		this.writing = next.done;
		this.lastWrite = Date.now();
		return next.done;
	}

	/** A finished turn keeps an existing page current; it never makes one. */
	writeAuto(): void {
		if (!this.host.live() || !this.url() || Date.now() - this.lastWrite < AUTO_WRITE_MS) return;
		void this.write();
	}

	/** 刷新卡片's note: the page written within REFRESH_BUDGET_MS, or still being written. */
	async refresh(viewer: string): Promise<string> {
		if (!this.host.doc()) {
			this.problem = false;
			return "已刷新；未配置文档，只更新卡片";
		}
		const started = Date.now();
		const written = this.write(viewer).then((result) =>
			result.ok ? `已刷新（${((Date.now() - started) / 1000).toFixed(1)} 秒）` : `文档写入失败：${result.error}`,
		);
		return within(written, REFRESH_BUDGET_MS, "页面仍在写入，稍后再点「刷新卡片」");
	}

	/** Never rejects: the next write in line waits on this one. */
	private async overwrite(viewer?: string): Promise<PageResult> {
		const doc = this.host.doc();
		const ctx = this.host.context();
		if (!this.host.live() || !doc || !ctx || ctx.sessionManager.getSessionId() !== this.host.sessionId)
			return { ok: true };
		const mask = (text: string) => this.host.maskText(text);
		try {
			const source = captureSessionSource(ctx);
			const { rounds, notices } = pageActivity(ctx.sessionManager.getBranch());
			const running = this.host.running(ctx);
			const content = pageMarkdown(source, {
				state: running ? "执行中" : "空闲",
				at: new Date(),
				rounds: rounds.map((round, index) => ({
					...round,
					prompt: mask(round.prompt),
					// The newest round of a busy session is still running, not one that said nothing.
					reply:
						running && index === 0 && round.reply === NO_REPLY_TEXT
							? "（执行中，还没有回复）"
							: mask(round.reply),
				})),
				notices: notices.map((notice) => ({ ...notice, content: mask(notice.content) })),
			});
			await doc.write(source, content, viewer);
			this.problem = false;
			return { ok: true };
		} catch (error) {
			this.problem = true;
			this.host.log(`文档页写入失败：${errorMessage(error)}`);
			return { ok: false, error: errorMessage(error) };
		}
	}
}

/** The promise's value, or `late` once `ms` have passed; the promise goes on either way. */
async function within<T>(promise: Promise<T>, ms: number, late: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(late), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

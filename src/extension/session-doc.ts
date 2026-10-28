/**
 * The session document: one WeCom smart document per machine and bot, one page per session holding its latest
 * replies and notices, overwritten as plain text. The document MCP cannot list or read pages (851008 partial
 * no authorization, 2026-10) nor delete documents, so this machine keeps the only record of them, shared by
 * every pi under one lock. A page never holds an image: a document image's URL opens without signing in and
 * survives the page's deletion. The one image is pi's own logo, already public, uploaded once per document as
 * the cards' icon.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pluginDirectory } from "../shared/agent-path.ts";
import type { SessionSource } from "../shared/notification-types.ts";
import { errorMessage } from "../shared/text.ts";
import { asRecord } from "../shared/wecom-protocol.ts";
import { writeJson } from "./config.ts";
import { DocError, type DocMcpClient, findField } from "./doc-mcp.ts";
import type { PageNotice, PageRound } from "./session-data.ts";

/** pi's colour logo, uploaded once into the document for the cards' icon. */
const LOGO_FILE = new URL("./assets/pi-logo.png", import.meta.url);
/** A page not written for this long is deleted when another page is created. */
export const PAGE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOCK_WAIT_MS = 3_000;
/** Longer than any locked step can take (a few MCP calls of at most 10 s each). */
const LOCK_STALE_MS = 45_000;
/** smartpage_pages_overwrite on a deleted page_id (probed 2026-10). */
const PAGE_GONE = 640027;
const MAX_VIEWERS = 200;

interface PageEntry {
	pageId: string;
	url: string;
	createdAt: number;
	writtenAt: number;
}

interface DocRecord {
	version: 1;
	/** A hash of the BotID: the document belongs to that bot, whatever its current apikey. */
	bot: string;
	docid: string;
	url: string;
	/** Members already granted read access. */
	viewers: string[];
	pages: Record<string, PageEntry>;
	/** Pi's logo uploaded to this document (smartpage_images_upload): the cards' source icon. */
	iconUrl?: string;
}

export interface PageWrite {
	url: string;
	created: boolean;
}

export interface SessionDocOptions {
	botId: string;
	mcp: DocMcpClient;
	log(line: string): void;
	/** Tests use a sandbox. */
	directory?: string;
	machine?: string;
	now?: () => number;
}

export class SessionDoc {
	private readonly file: string;
	private readonly lock: string;
	/** The record's name before the document was called the session document; adopted once. */
	private readonly earlier: string;
	private adopted = false;
	private readonly bot: string;
	private readonly machine: string;
	private readonly now: () => number;
	/** One upload attempt per process: a failure is logged once, the next pi run tries again. */
	private icon: Promise<void> | undefined;

	constructor(private readonly options: SessionDocOptions) {
		const directory = options.directory ?? pluginDirectory();
		this.file = join(directory, "session-doc.json");
		this.lock = join(directory, "session-doc.lock");
		this.earlier = join(directory, "screen-pages.json");
		this.bot = createHash("sha256").update(options.botId).digest("hex").slice(0, 32);
		this.machine = options.machine ?? hostname();
		this.now = options.now ?? Date.now;
	}

	/** The page a session already has; reading the record never calls the service, and never fails a card. */
	pageUrl(sessionId: string): string | undefined {
		return this.readForCard()?.pages[sessionId]?.url;
	}

	/** The cards' icon, once this document has one; reading the record never calls the service, never fails a card. */
	iconUrl(): string | undefined {
		return this.readForCard()?.iconUrl;
	}

	/** A card is drawn without what an unreadable record holds; the reason is logged. */
	private readForCard(): DocRecord | undefined {
		try {
			return this.read();
		} catch (error) {
			this.options.log(errorMessage(error));
			return undefined;
		}
	}

	/**
	 * The session's page, created now if it has none, and the card icon: connect waits for both, so the card it
	 * publishes links its page. Returns the page's link.
	 */
	async ensure(source: SessionSource, viewer?: string): Promise<string> {
		const page = await this.ensurePage(source);
		await this.besides(this.ensureIcon(page.docid), viewer ? this.ensureViewer(page.docid, viewer) : undefined);
		return page.url;
	}

	/** Overwrite the session's page, creating the document and page on first use and granting `viewer` access. */
	async write(source: SessionSource, markdown: string, viewer?: string): Promise<PageWrite> {
		let page = await this.ensurePage(source);
		// Alongside the page, not before it: neither the viewer nor the icon fails a write. A write settles only
		// after both, so no call of this write is left running once its caller has its answer.
		const viewing = viewer ? this.ensureViewer(page.docid, viewer) : undefined;
		const icon = this.ensureIcon(page.docid);
		try {
			try {
				await this.overwrite(page.docid, page.pageId, markdown);
			} catch (error) {
				if (!(error instanceof DocError) || error.errcode !== PAGE_GONE || page.created) throw error;
				// Deleted outside this record (another machine, by hand): make a new one, once.
				await this.forget(source.sessionId, page.pageId);
				page = await this.ensurePage(source);
				await this.overwrite(page.docid, page.pageId, markdown);
			}
		} finally {
			await this.besides(viewing, icon);
		}
		await this.locked(() => {
			const current = this.read();
			const entry = current?.pages[source.sessionId];
			if (!current || !entry || entry.pageId !== page.pageId) return;
			entry.writtenAt = this.now();
			this.save(current);
		});
		if (page.created) void this.sweep(source.sessionId);
		return { url: page.url, created: page.created };
	}

	/** Work done beside a page's (its viewer, the icon): it never fails the page, a failure is only logged. */
	private async besides(...steps: (Promise<void> | undefined)[]): Promise<void> {
		for (const step of await Promise.allSettled(steps))
			if (step.status === "rejected") this.options.log(`会话文档附带操作失败：${errorMessage(step.reason)}`);
	}

	/** Delete every page this machine created for the bot; the document itself cannot be deleted. */
	async reset(): Promise<number> {
		const current = this.read();
		if (!current) return 0;
		const pages = Object.entries(current.pages);
		let deleted = 0;
		for (const [sessionId, entry] of pages) {
			try {
				await this.deletePage(current.docid, entry.pageId);
				deleted++;
			} catch (error) {
				this.options.log(`文档页删除失败（${sessionId}）：${errorMessage(error)}`);
			}
		}
		await this.locked(() => {
			const latest = this.read();
			if (!latest) return;
			latest.pages = {};
			this.save(latest);
		});
		return deleted;
	}

	private async ensurePage(
		source: SessionSource,
	): Promise<{ docid: string; pageId: string; url: string; created: boolean }> {
		return this.locked(async () => {
			let current = this.read();
			if (!current) {
				current = await this.createDocument();
				this.save(current);
			}
			const existing = current.pages[source.sessionId];
			if (existing) return { docid: current.docid, pageId: existing.pageId, url: existing.url, created: false };
			const made = await this.options.mcp.call("smartpage_pages_update", {
				docid: current.docid,
				create_page: { page_name: pageName(source), index: 0 },
			});
			const pageId = findField(made, "page_id");
			const url = findField(made, "page_url");
			if (!pageId || !url?.startsWith("https://")) throw new DocError("新建页面没有返回 page_id 和链接", "protocol");
			const at = this.now();
			current.pages[source.sessionId] = { pageId, url, createdAt: at, writtenAt: at };
			this.save(current);
			this.options.log(`文档页已创建：session ${source.sessionId}`);
			return { docid: current.docid, pageId, url, created: true };
		});
	}

	private async createDocument(): Promise<DocRecord> {
		const created = await this.options.mcp.call("smartpage_create", {
			name: `pi 会话文档（${this.machine.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 64)}）`,
		});
		const docid = findField(created, "docid");
		const url = findField(created, "url");
		if (!docid || !url?.startsWith("https://")) throw new DocError("新建文档没有返回 docid 和链接", "protocol");
		// Only invited members may read it: colleagues must apply, outsiders are refused.
		try {
			await this.options.mcp.call("doc_rules_update", {
				docid,
				enable_member_join_admin_check: false,
				corp_internal_join_auth: "apply",
				corp_external_join_auth: "deny",
			});
		} catch (error) {
			this.options.log(`会话文档加入规则未设置：${errorMessage(error)}`);
		}
		this.options.log("会话文档已创建");
		return { version: 1, bot: this.bot, docid, url, viewers: [], pages: {} };
	}

	/** A document created before icons, or whose upload failed, gets its icon with the next write. */
	private ensureIcon(docid: string): Promise<void> {
		if (this.icon) return this.icon;
		if (this.iconUrl()) return Promise.resolve();
		this.icon = (async () => {
			try {
				const uploaded = await this.options.mcp.call("media_upload", {
					type: "image",
					file_name: "pi-logo.png",
					base64_content: readFileSync(LOGO_FILE).toString("base64"),
				});
				const mediaId = findField(uploaded, "media_id");
				if (!mediaId) throw new DocError("上传图标没有返回 media_id", "protocol");
				const bound = await this.options.mcp.call("smartpage_images_upload", { docid, media_id: mediaId });
				const url = findField(bound, "url");
				if (!url?.startsWith("https://")) throw new DocError("上传图标没有返回链接", "protocol");
				await this.locked(() => {
					const current = this.read();
					if (!current || current.docid !== docid || current.iconUrl) return;
					current.iconUrl = url;
					this.save(current);
				});
				this.options.log("卡片图标已上传到会话文档");
			} catch (error) {
				this.options.log(`卡片图标未上传，继续用默认图标：${errorMessage(error)}`);
			}
		})();
		return this.icon;
	}

	private async ensureViewer(docid: string, userid: string): Promise<void> {
		if (this.read()?.viewers.includes(userid)) return;
		try {
			await this.options.mcp.call("doc_members_update", {
				docid,
				add_member_list: { items: [{ userid, user_type: "user", user_auth: "read" }] },
			});
		} catch (error) {
			// The page is still written; the member may just have to apply for access.
			this.options.log(`会话文档成员未添加：${errorMessage(error)}`);
			return;
		}
		await this.locked(() => {
			const current = this.read();
			if (!current || current.docid !== docid || current.viewers.includes(userid)) return;
			current.viewers = [...current.viewers, userid].slice(-MAX_VIEWERS);
			this.save(current);
		});
	}

	private async overwrite(docid: string, pageId: string, markdown: string): Promise<void> {
		const uploaded = await this.options.mcp.call("media_upload", {
			type: "file",
			file_name: "pi-screen.md",
			base64_content: Buffer.from(markdown, "utf8").toString("base64"),
		});
		const mediaId = findField(uploaded, "media_id");
		if (!mediaId) throw new DocError("上传页面内容没有返回 media_id", "protocol");
		await this.options.mcp.call("smartpage_pages_overwrite", {
			docid,
			page_id: pageId,
			content_type: "markdown",
			media_id: mediaId,
		});
	}

	private deletePage(docid: string, pageId: string): Promise<string[]> {
		return this.options.mcp.call("smartpage_pages_update", { docid, delete_page: { page_id: pageId } });
	}

	private async forget(sessionId: string, pageId: string): Promise<void> {
		await this.locked(() => {
			const current = this.read();
			if (current?.pages[sessionId]?.pageId !== pageId) return;
			delete current.pages[sessionId];
			this.save(current);
		});
	}

	/** Pages nobody refreshed for PAGE_RETENTION_MS, swept after a new page so a click never waits for it. */
	/** Started without waiting: it never rejects, every failure is logged. */
	private async sweep(keep: string): Promise<void> {
		let current: DocRecord | undefined;
		try {
			current = this.read();
		} catch (error) {
			this.options.log(`过期文档页未清理：${errorMessage(error)}`);
			return;
		}
		if (!current) return;
		const cutoff = this.now() - PAGE_RETENTION_MS;
		for (const [sessionId, entry] of Object.entries(current.pages)) {
			if (sessionId === keep || entry.writtenAt >= cutoff) continue;
			try {
				await this.deletePage(current.docid, entry.pageId);
				await this.forget(sessionId, entry.pageId);
				this.options.log(`文档页已过期删除：session ${sessionId}`);
			} catch (error) {
				this.options.log(`过期文档页删除失败（${sessionId}）：${errorMessage(error)}`);
			}
		}
	}

	// ---------------------------------------------------------------- the record

	/** A record an earlier version kept under its old name takes the new one, so its pages are found again. */
	private adopt(): void {
		if (this.adopted) return;
		this.adopted = true;
		if (existsSync(this.file)) return;
		try {
			mkdirSync(join(this.file, ".."), { recursive: true });
			renameSync(this.earlier, this.file);
			this.options.log(`会话文档记录已改名为 ${this.file}`);
		} catch (error) {
			// No earlier record, or another pi adopted it first; anything else would lose its pages.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.options.log(`旧的会话文档记录 ${this.earlier} 未能改名：${errorMessage(error)}`);
		}
	}

	/**
	 * Every bot's entries. The file is the only record of the pages: a broken one is an error, never an empty
	 * record, or a new document would be made and the other bots' pages written over.
	 */
	private readAll(): Record<string, unknown> {
		this.adopt();
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`无法读取会话文档记录 ${this.file}：${errorMessage(error)}`);
		}
		let all: Record<string, unknown> | undefined;
		try {
			all = asRecord(JSON.parse(text));
		} catch {
			all = undefined;
		}
		if (!all) throw new Error(`会话文档记录 ${this.file} 已损坏：请修好或删除它`);
		return all;
	}

	private read(): DocRecord | undefined {
		const value = this.readAll()[this.bot];
		if (value === undefined) return undefined;
		const record = asRecord(value);
		if (!record || !validRecord(record)) throw new Error(`会话文档记录 ${this.file} 中本机器人的一项已损坏`);
		return record;
	}

	private save(next: DocRecord): void {
		const all = this.readAll();
		all[this.bot] = next;
		writeJson(this.file, all, false);
	}

	/** One pi at a time reads and changes the record; a lock left by a crashed pi expires. */
	private async locked<T>(action: () => T | Promise<T>): Promise<T> {
		mkdirSync(join(this.lock, ".."), { recursive: true });
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				closeSync(openSync(this.lock, "wx", 0o600));
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					if (Date.now() - statSync(this.lock).mtimeMs > LOCK_STALE_MS) rmSync(this.lock, { force: true });
				} catch {
					// Released meanwhile.
				}
				if (Date.now() > deadline) throw new Error("另一个 pi 正在更新会话文档，请稍后再刷新");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		try {
			return await action();
		} finally {
			rmSync(this.lock, { force: true });
		}
	}
}

/** What a page shows: the last rounds and notices, newest first. The terminal's last lines are on the card. */
export interface PageContent {
	state: string;
	at: Date;
	rounds: readonly PageRound[];
	notices: readonly PageNotice[];
}

/** A reply or notice longer than this is cut on its page: three of each must fit one page. */
const PAGE_BODY_CHARS = 8000;
const PROMPT_CHARS = 60;

/**
 * A page's markdown: who it is; the last rounds, each its prompt and reply, newest first; the notices. Read as
 * text: a reply keeps its own Markdown, below its round, and nothing is wrapped in a code block.
 */
export function pageMarkdown(source: SessionSource, content: PageContent): string {
	const rounds = content.rounds.length
		? content.rounds.flatMap((round) => [
				`### ${shortStamp(round.at)} ${oneLine(round.prompt, PROMPT_CHARS) || "（没有文字）"}`,
				"",
				embedded(round.reply),
				"",
			])
		: ["（还没有对话）", ""];
	const notices = content.notices.flatMap((notice) => [
		`### ${shortStamp(notice.at)} ${oneLine(notice.content, PROMPT_CHARS)}`,
		"",
		embedded(notice.content),
		"",
	]);
	return [
		`# ${source.directoryName || "pi"} · ${source.sessionId}`,
		"",
		`${source.modelName} · ${source.provider} · ${content.state} · ${stamp(content.at)} 更新`,
		"",
		"## 最近回复",
		"",
		...rounds,
		...(notices.length ? ["## 最近通知", "", ...notices] : []),
	].join("\n");
}

/**
 * A reply as part of the page: cut to PAGE_BODY_CHARS, its headings three levels down (the page owns # to ###,
 * a round's heading is ###), and a code block it leaves open closed, so nothing after it is swallowed.
 */
function embedded(text: string): string {
	const chars = [...text.trim()];
	const body =
		chars.length > PAGE_BODY_CHARS
			? `${chars.slice(0, PAGE_BODY_CHARS).join("")}\n\n…（内容过长已截断）`
			: chars.join("");
	let open: string | undefined;
	const lines = body.split("\n").map((line) => {
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (!open) open = fence;
			else if (fence[0] === open[0] && fence.length >= open.length && !line.trim().slice(fence.length).trim())
				open = undefined;
			return line;
		}
		if (open) return line;
		return line.replace(
			/^( {0,3})(#{1,6})(?=\s|$)/,
			(_all, indent: string, hashes: string) => `${indent}${"#".repeat(Math.min(6, hashes.length + 3))}`,
		);
	});
	if (open) lines.push(open);
	return lines.join("\n");
}

function oneLine(text: string, limit: number): string {
	const line =
		text
			.split("\n")
			.map((item) => item.trim())
			.find(Boolean) ?? "";
	const chars = [...line.replace(/[#*`_[\]<>|]/g, "")];
	return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function shortStamp(at: Date): string {
	return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function pageName(source: SessionSource): string {
	const tail = source.sessionId.length <= 8 ? source.sessionId : `…${source.sessionId.slice(-8)}`;
	return `${(source.directoryName || "pi").slice(0, 80)} · ${tail}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
}

function stamp(at: Date): string {
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function validRecord(value: Record<string, unknown>): value is DocRecord & Record<string, unknown> {
	if (value.version !== 1 || typeof value.docid !== "string" || typeof value.url !== "string") return false;
	if (!Array.isArray(value.viewers) || !value.viewers.every((id) => typeof id === "string")) return false;
	if (value.iconUrl !== undefined && !(typeof value.iconUrl === "string" && value.iconUrl.startsWith("https://")))
		return false;
	const pages = asRecord(value.pages);
	if (!pages) return false;
	return Object.values(pages).every((item) => {
		const page = asRecord(item);
		return (
			!!page &&
			typeof page.pageId === "string" &&
			typeof page.url === "string" &&
			typeof page.createdAt === "number" &&
			typeof page.writtenAt === "number"
		);
	});
}

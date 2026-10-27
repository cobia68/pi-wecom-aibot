/**
 * The WeCom document MCP a smart robot gets once a member grants it 文档 (工作台 → 智能机器人 → 可使用权限):
 * a Streamable HTTP endpoint whose URL carries its own apikey, so the URL is a credential and never appears
 * in a message, log or error. Only the tools a session page needs are used; their names and arguments are
 * the live service's (probed 2026-10), which differ from the help article.
 */
import { asRecord } from "../shared/wecom-protocol.ts";

const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 10_000;

export type DocErrorKind = "http" | "rpc" | "tool" | "network" | "protocol";

/** errcode is WeCom's when the tool answered with one; for kind "http" it is the HTTP status. */
export class DocError extends Error {
	constructor(
		message: string,
		readonly kind: DocErrorKind,
		readonly errcode?: number,
	) {
		super(message);
		this.name = "DocError";
	}
}

/** A document address as typed by the user: https on a qq.com host, with nothing pasted around it. */
export function docUrlProblem(value: string): string | undefined {
	if (/[\s"'“”‘’`<>]/.test(value)) return "地址含空格或引号；请只粘贴 streamableHTTP URL 本身";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "不是有效的 URL";
	}
	if (url.protocol !== "https:") return "必须是 https 地址";
	if (!/(^|\.)qq\.com$/.test(url.hostname)) return `主机 ${url.hostname} 不是企业微信（qq.com）的地址`;
	if (value.length > 2048) return "地址过长";
	return undefined;
}

/** The address and the parts of it that work as its key: masked wherever text leaves pi. */
export function docUrlSecrets(url: string): string[] {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url ? [url] : [];
	}
	return [
		url,
		...[...parsed.searchParams.values()].filter((value) => value.length >= 8),
		...parsed.pathname.split("/").filter((segment) => segment.length >= 16),
	];
}

export class DocMcpClient {
	private session: string | undefined;
	private protocol: string | undefined;
	private ready: Promise<void> | undefined;
	private nextId = 1;
	private readonly secrets: string[];

	constructor(private readonly url: string) {
		this.secrets = docUrlSecrets(url);
	}

	/** The tool's text parts; an errcode other than 0, or isError, is thrown as a DocError. */
	async call(name: string, args: Record<string, unknown>): Promise<string[]> {
		try {
			return await this.callOnce(name, args);
		} catch (error) {
			// An expired MCP session is answered with 404: open a new one and try exactly once more.
			if (!(error instanceof DocError) || error.kind !== "http" || error.errcode !== 404 || !this.session)
				throw error;
			this.reset();
			return this.callOnce(name, args);
		}
	}

	private async callOnce(name: string, args: Record<string, unknown>): Promise<string[]> {
		await this.initialized();
		const result = await this.request("tools/call", { name, arguments: args });
		const parts = (Array.isArray(result.content) ? result.content : [])
			.map((item) => asRecord(item))
			.map((item) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
			.filter(Boolean);
		if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
		for (const part of parts) {
			const body = asRecord(parseJson(part));
			if (typeof body?.errcode === "number" && body.errcode !== 0)
				throw new DocError(
					`${name} 失败：企业微信 ${body.errcode}：${conciseMessage(body.errmsg)}`,
					"tool",
					body.errcode,
				);
		}
		if (result.isError === true)
			throw new DocError(`${name} 失败：${this.redact(parts.join(" ")).slice(0, 200)}`, "tool");
		return parts;
	}

	private initialized(): Promise<void> {
		this.ready ??= (async () => {
			const result = await this.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-wecom-aibot", version: "1" },
			});
			this.protocol = typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
			await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
		})().catch((error: unknown) => {
			this.reset();
			throw error;
		});
		return this.ready;
	}

	private reset(): void {
		this.ready = undefined;
		this.session = undefined;
		this.protocol = undefined;
	}

	private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return (await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params })) ?? {};
	}

	private async post(message: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.session) headers["mcp-session-id"] = this.session;
		if (this.protocol) headers["mcp-protocol-version"] = this.protocol;
		let response: Response;
		let text: string;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			});
			text = await response.text();
		} catch (error) {
			// fetch errors may quote the request URL: keep only their own words, redacted.
			const reason =
				error instanceof Error ? (error.name === "TimeoutError" ? "超时" : error.message) : String(error);
			throw new DocError(`文档服务连接失败：${this.redact(reason).slice(0, 200)}`, "network");
		}
		const session = response.headers.get("mcp-session-id");
		if (session) this.session = session;
		if (!response.ok)
			throw new DocError(
				`文档服务 HTTP ${response.status}：${this.redact(text).slice(0, 160)}`,
				"http",
				response.status,
			);
		if (message.id === undefined) return undefined;
		const payloads = response.headers.get("content-type")?.includes("text/event-stream") ? sseData(text) : [text];
		for (const payload of payloads) {
			const reply = asRecord(parseJson(payload));
			if (reply?.id !== message.id) continue;
			const error = asRecord(reply.error);
			if (error)
				throw new DocError(
					`文档服务 ${String(error.code)}：${this.redact(String(error.message ?? "")).slice(0, 200)}`,
					"rpc",
				);
			return asRecord(reply.result) ?? {};
		}
		throw new DocError(`文档服务没有返回 ${String(message.method)} 的结果`, "protocol");
	}

	private redact(text: string): string {
		let safe = text;
		for (const value of this.secrets) safe = safe.split(value).join("****");
		return safe.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	}
}

/** The first matching string anywhere in the tool's JSON parts. */
export function findField(parts: readonly string[], key: string): string | undefined {
	const search = (value: unknown, depth: number): string | undefined => {
		if (depth > 6) return undefined;
		if (Array.isArray(value)) return value.map((item) => search(item, depth + 1)).find(Boolean);
		const node = asRecord(value);
		if (!node) return undefined;
		const own = node[key];
		if (typeof own === "string" && own) return own;
		return Object.values(node)
			.map((item) => search(item, depth + 1))
			.find(Boolean);
	};
	return parts.map((part) => search(parseJson(part), 0)).find(Boolean);
}

/** One SSE message per blank-line-separated event, its data lines joined. */
function sseData(text: string): string[] {
	return text.split(/\r?\n\r?\n/).map((event) =>
		event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n"),
	);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** WeCom's errmsg without its trailing ", hint: [...], from ip: ..., more info at ...". */
function conciseMessage(value: unknown): string {
	return String(value ?? "")
		.split(/, hint:| \(callid:/)[0]
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.trim()
		.slice(0, 120);
}

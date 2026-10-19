/**
 * Upload a PNG to a generic HTTPS multipart endpoint and return a WeCom Markdown image link.
 * Hosts are tried in order; the next is tried only when the previous fails. Runs in pi only.
 * The link is read from a JSON reply or from a plain-text response.
 */

export interface HttpHost {
	type: "http";
	url: string;
	fileField: string;
	fields?: Record<string, string>;
	headers?: Record<string, string>;
	/** Dotted path to the link in a JSON reply, e.g. data.url; omitted means the reply is the link. */
	urlPath?: string;
}

export type ImageHost = HttpHost;

const MAX_HOSTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REPLY_BYTES = 64 * 1024;

/** Validate the configured hosts; undefined and [] mean none. Errors name the entry. */
export function parseImageHosts(value: unknown): ImageHost[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error("imageHosts 应为数组");
	if (value.length > MAX_HOSTS) throw new Error(`imageHosts 最多 ${MAX_HOSTS} 项`);
	return value.map((entry, index) => {
		const at = `imageHosts 第 ${index + 1} 项`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${at}应为对象`);
		const host = entry as Record<string, unknown>;
		if (host.type !== "http") throw new Error(`${at}的 type 只能是 http`);
		const url = text(host.url, `${at}的 url`, 2048);
		let parsed: URL;
		try { parsed = new URL(url); } catch { throw new Error(`${at}的 url 不是有效的网址`); }
		if (parsed.protocol !== "https:") throw new Error(`${at}的 url 必须是 https 地址`);
		if (parsed.username || parsed.password || parsed.hash) throw new Error(`${at}的 url 不要带账号、密码或 #；认证请用 headers 或 fields`);
		const fileField = text(host.fileField, `${at}的 fileField`, 100);
		const fields = stringMap(host.fields, `${at}的 fields`);
		const headers = stringMap(host.headers, `${at}的 headers`);
		const urlPath = host.urlPath === undefined ? undefined : text(host.urlPath, `${at}的 urlPath`, 200);
		if (urlPath !== undefined && !/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(urlPath)) throw new Error(`${at}的 urlPath 格式应如 data.url`);
		return { type: "http", url, fileField, ...(fields ? { fields } : {}), ...(headers ? { headers } : {}), ...(urlPath ? { urlPath } : {}) };
	});
}

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new Error(`${label}应为不超过 ${max} 个字符的非空文本`);
	}
	return value.trim();
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}应为对象`);
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > 20) throw new Error(`${label}最多 20 项`);
	return Object.fromEntries(entries.map(([key, item]) => {
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Error(`${label}的名称「${key}」格式不正确`);
		if (typeof item !== "string" || item.length > 4096 || /[\u0000-\u001f\u007f]/.test(item)) throw new Error(`${label}.${key} 应为不超过 4096 个字符的文本`);
		return [key, item];
	}));
}

export interface UploadOptions {
	signal?: AbortSignal;
}

/** Upload to each host in order and return the first link; the error lists every host's failure. */
export async function uploadImage(png: Uint8Array, hosts: readonly ImageHost[], options: UploadOptions = {}): Promise<{ url: string; host: string }> {
	if (!hosts.length) throw new Error("没有配置图床（imageHosts）");
	const failures: string[] = [];
	const secrets = hostSecrets(hosts);
	for (const host of hosts) {
		options.signal?.throwIfAborted();
		try {
			const url = await toHttp(png, host, options, secrets);
			return { url, host: hostLabel(host) };
		} catch (error) {
			if (options.signal?.aborted) throw options.signal.reason;
			failures.push(`${hostLabel(host)}：${redactSecrets(describe(error), secrets)}`);
		}
	}
	throw new Error(`图片上传失败：${failures.join("；")}`);
}

async function toHttp(png: Uint8Array, host: HttpHost, options: UploadOptions, secrets: readonly string[]): Promise<string> {
	const form = new FormData();
	for (const [key, value] of Object.entries(host.fields ?? {})) form.append(key, value);
	form.append(host.fileField, new Blob([new Uint8Array(png)], { type: "image/png" }), "pi-screen.png");
	// Never replay a multipart body (including credentials) to an unconfigured redirect target.
	const response = await fetch(host.url, { method: "POST", headers: host.headers, body: form, redirect: "error", signal: withTimeout(options.signal) });
	const body = await readReply(response);
	if (!response.ok) throw new Error(`图床返回 HTTP ${response.status}${excerpt(body, secrets)}`);
	let value: unknown = body.trim();
	if (host.urlPath) {
		let json: unknown;
		try { json = JSON.parse(body); } catch { throw new Error(`图床返回的不是 JSON${excerpt(body, secrets)}`); }
		value = host.urlPath.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), json);
	}
	const link = typeof value === "string" ? imageLink(value) : undefined;
	if (!link) throw new Error(`图床没有返回可用的 https 图片链接${host.urlPath ? `（${host.urlPath}）` : ""}${excerpt(body, secrets)}`);
	return link;
}

/** An https link that can sit inside `![](…)` unescaped; undefined otherwise. */
export function imageLink(value: string): string | undefined {
	const link = value.trim();
	if (link.length > 2048 || /[\s()<>\\"'`]/.test(link) || /[\u0000-\u001f\u007f]/.test(link)) return undefined;
	try {
		const url = new URL(link);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function imageMarkdown(link: string): string {
	return `![pi 终端画面](${link})`;
}

/** HTTP credentials from headers, form fields and URL queries: masked in diagnostics and screenshots. */
export function hostSecrets(hosts: readonly ImageHost[]): string[] {
	const secrets: string[] = [];
	for (const host of hosts) {
		for (const value of Object.values(host.headers ?? {})) {
			secrets.push(value);
			// Bearer/Basic schemes are not credentials; their argument is.
			const credential = /^\S+\s+(.+)$/.exec(value)?.[1];
			if (credential) secrets.push(credential);
		}
		const credentialName = /key|token|secret|auth|pass|credential|signature/i;
		for (const [key, value] of Object.entries(host.fields ?? {})) {
			if (credentialName.test(key) || value.length >= 16) secrets.push(value);
		}
		try {
			for (const [key, value] of new URL(host.url).searchParams) {
				if (credentialName.test(key) || value.length >= 8) secrets.push(value);
			}
		} catch { /* validated */ }
	}
	return [...new Set(secrets.filter(Boolean))];
}

function hostLabel(host: ImageHost): string {
	try {
		return `http ${new URL(host.url).host}`;
	} catch {
		return host.type;
	}
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
	const forms = new Set<string>();
	for (const secret of secrets) {
		if (!secret) continue;
		forms.add(secret);
		forms.add(JSON.stringify(secret).slice(1, -1));
		try { forms.add(encodeURIComponent(secret)); } catch { /* malformed Unicode: raw form still masks it */ }
	}
	return [...forms].sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("****"), message);
}

async function readReply(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_REPLY_BYTES) throw new Error("图床返回内容超过 64 KiB，已拒绝读取");
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function excerpt(body: string, secrets: readonly string[]): string {
	let message = body.trim();
	try {
		const json = JSON.parse(body) as { message?: unknown; error?: unknown; errmsg?: unknown };
		const field = [json.message, json.error, json.errmsg].find((item) => typeof item === "string");
		if (typeof field === "string") message = field;
	} catch { /* plain text */ }
	message = redactSecrets(message, secrets).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").slice(0, 160);
	return message ? `（${message}）` : "";
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError") return `${REQUEST_TIMEOUT_MS / 1000} 秒内没有响应`;
		const code = (error as { cause?: { code?: unknown } }).cause?.code;
		if (error.message === "fetch failed") return `无法连接${typeof code === "string" ? `（${code}）` : ""}`;
		return error.message;
	}
	return String(error);
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

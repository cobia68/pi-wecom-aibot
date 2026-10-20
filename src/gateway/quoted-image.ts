/**
 * The session a quoted image names. WeCom's quote carries only a short-lived download link, never the
 * message it quotes, so the name has to be in the file: every image the gateway sends carries its
 * session marker (see png-marker.ts).
 *
 * Measured against a real quote: the link serves our own bytes under the quote's aeskey, marker
 * intact, so reading a prefix is enough — no OCR, and nothing remembered about what was sent. Only
 * byte facts and field names are reported, never the signed link or the key.
 */
import { decryptAes256CbcPrefix, parseAesKey } from "../shared/media-crypto.ts";
import type { QuotedImage } from "../shared/wecom-protocol.ts";
import { inspectPng, isPng } from "./png-marker.ts";

/** The marker sits at byte 33; this leaves room for chunks a re-encoder might put before it. */
export const QUOTED_IMAGE_BYTES = 4096;
const READ_TIMEOUT_MS = 15_000;

export interface QuotedImageReading {
	/** The pi session that sent the quoted image, when its marker survived the round trip. */
	sessionId?: string;
	/** One line for the log: what the quote held, and what it named. */
	report: string;
}

/** Reads what a quoted image says about itself. Never throws: a quote is not worth failing a message over. */
export async function readQuotedImage(image: QuotedImage): Promise<QuotedImageReading> {
	const facts = [
		`引用类型 ${display(image.msgtype, 40) || "无"}`,
		`字段 ${names(image.quoteFields)}`,
		`image 字段 ${names(image.imageFields)}`,
	];
	const line = (...more: string[]) => `引用图片：${[...facts, ...more].join("；")}`;
	if (!image.url) return { report: line("没有下载链接") };
	let url: URL;
	try {
		url = new URL(image.url);
	} catch {
		return { report: line("下载链接无效") };
	}
	if (url.protocol !== "https:") return { report: line(`下载链接不是 https（${url.protocol}），未下载`) };
	let download: Awaited<ReturnType<typeof readPrefix>>;
	try {
		download = await readPrefix(url, QUOTED_IMAGE_BYTES);
	} catch (error) {
		return { report: line(`下载失败：${scrub(error, image.url)}`) };
	}
	facts.push(`HTTP ${download.status}`, `Content-Length ${download.length ?? "未知"}`);
	if (download.status < 200 || download.status > 299) return { report: line("未读取正文") };
	let bytes = download.bytes;
	if (!image.aeskey) facts.push("没有 aeskey，按未加密读取");
	else if (format(bytes) !== undefined) facts.push("有 aeskey 但正文未加密");
	else {
		try {
			bytes = decryptAes256CbcPrefix(bytes, parseAesKey(image.aeskey));
		} catch (error) {
			facts.push(`aeskey 无法使用：${scrub(error, image.aeskey)}`);
		}
	}
	const kind = format(bytes);
	if (kind !== "PNG")
		return {
			report: line(
				kind ? `格式 ${kind}` : `格式未知（开头 ${bytes.subarray(0, 12).toString("hex") || "无数据"}）`,
				"不是原 PNG，读不到标记",
			),
		};
	const png = inspectPng(bytes);
	if (!png) return { report: line("格式 PNG", "文件头不完整，读不到标记") };
	const shape = [`PNG ${png.width}×${png.height}`, `块 ${png.chunks.join(",")}`];
	if (png.session === undefined)
		return { report: line(...shape, `没有标记${png.markerProblem ? `（${png.markerProblem}）` : ""}`) };
	return { sessionId: png.session, report: line(...shape, `读到标记 session ${display(png.session)}`) };
}

function format(bytes: Buffer): "PNG" | "JPEG" | "GIF" | "WEBP" | undefined {
	if (isPng(bytes)) return "PNG";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
	if (/^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6))) return "GIF";
	if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "WEBP";
	return undefined;
}

/** Status, declared length and the first bytes of the body; the rest is never downloaded. */
async function readPrefix(url: URL, maxBytes: number): Promise<{ status: number; length?: string; bytes: Buffer }> {
	const response = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
	const declared = response.headers.get("content-length");
	const length = declared === null ? undefined : display(declared, 20);
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (reader && response.ok && size < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} finally {
		await reader?.cancel().catch(() => {});
	}
	return { status: response.status, length, bytes: Buffer.concat(chunks).subarray(0, maxBytes) };
}

/** Error text without the signed link or the key that produced it. */
function scrub(error: unknown, secret: string): string {
	const base = error instanceof Error ? error.message : String(error);
	const cause = error instanceof Error && error.cause instanceof Error ? `（${error.cause.message}）` : "";
	return display(
		`${base}${cause}`
			.split(secret)
			.join("<链接>")
			.replace(/\bhttps?:\/\/\S+/gi, "<链接>"),
		200,
	);
}

function names(values: string[]): string {
	if (!values.length) return "无";
	const shown = values.slice(0, 12).map((value) => display(value, 40));
	return `${shown.join(",")}${values.length > shown.length ? ",…" : ""}`;
}

function display(value: string, max = 120): string {
	return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")].slice(0, max).join("");
}

/** WeCom media callbacks carry { url, aeskey }: a 5-minute download link to a payload encrypted with that key. */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptAes256Cbc, parseAesKey } from "./media-crypto.ts";

export interface DownloadedMedia {
	buffer: Buffer;
	mimeType: string;
}

export interface DownloadOptions {
	signal?: AbortSignal;
	maxBytes?: number;
	timeoutMs?: number;
}

export async function downloadAndDecrypt(
	url: string,
	aeskey?: string,
	options: DownloadOptions = {},
): Promise<DownloadedMedia> {
	if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error("media URL must use HTTP or HTTPS");
	const signal = AbortSignal.any([
		AbortSignal.timeout(options.timeoutMs ?? 30_000),
		...(options.signal ? [options.signal] : []),
	]);
	signal.throwIfAborted();
	const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
	const res = await fetch(url, { signal });
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new Error(`download failed: HTTP ${res.status}`);
	}
	if (Number(res.headers.get("content-length")) > maxBytes) {
		await res.body?.cancel().catch(() => {});
		throw new Error("media download exceeds size limit");
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = res.body?.getReader();
	if (reader) {
		// Own cancellation even if a fetch adapter does not abort an already-returned response body.
		const onAbort = () => {
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			while (true) {
				signal.throwIfAborted();
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes) throw new Error("media download exceeds size limit");
				chunks.push(value);
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	signal.throwIfAborted();
	const raw = Buffer.concat(chunks, size);
	const buffer = aeskey ? decryptAes256Cbc(raw, parseAesKey(aeskey)) : raw;
	const mimeType =
		detectMimeType(buffer) ??
		(res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
	return { buffer, mimeType };
}

function detectMimeType(buffer: Buffer): string | undefined {
	if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP")
		return "image/webp";
	if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
	if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
	return undefined;
}

const EXT_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"video/mp4": "mp4",
	"audio/amr": "amr",
	"application/pdf": "pdf",
	"application/octet-stream": "bin",
	"application/json": "json",
	"application/zip": "zip",
	"text/plain": "txt",
	"text/markdown": "md",
};

function extensionFor(mimeType: string): string {
	return EXT_BY_MIME[mimeType] ?? mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") ?? "bin";
}

export async function saveMedia(
	dir: string,
	baseName: string,
	media: DownloadedMedia,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	const safe = baseName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "media";
	const file = join(dir, `${safe}.${extensionFor(media.mimeType)}`);
	await writeFile(file, media.buffer, { signal });
	return file;
}

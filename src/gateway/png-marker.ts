/**
 * The source marker inside every PNG the gateway sends. WeCom's quote of an image carries only a
 * short-lived download link, never the message it quotes; if that link serves our own bytes, the marker
 * names the session without OCR and without the gateway remembering anything.
 *
 * The marker is a tEXt chunk directly after IHDR. Viewers ignore it and the pixels stay unchanged; in
 * the file as sent it always starts at byte 33 (8-byte signature + 25-byte IHDR chunk).
 */
import { crc32 } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** tEXt is keyword, NUL, Latin-1 text; the session ID is URI-encoded to stay within that. */
const KEYWORD = "pi-wecom-aibot";
const PREFIX = Buffer.from(`${KEYWORD}\0session=`, "latin1");
/** Signature 8 + IHDR chunk (4 length + 4 type + 13 data + 4 CRC). */
const IHDR_END = 33;
const MAX_LISTED_CHUNKS = 12;

export interface PngInspection {
	width: number;
	height: number;
	/** Chunk types in file order, up to IDAT; "…" where the bytes read end or stop making sense. */
	chunks: string[];
	/** Set only from a complete marker with a valid CRC. */
	session?: string;
	/** A marker was seen but cannot be trusted. */
	markerProblem?: string;
}

export function isPng(data: Buffer): boolean {
	return data.length >= SIGNATURE.length && data.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

/** A copy of the PNG with this session's marker after IHDR; throws for anything that is not a PNG. */
export function stampPng(png: Buffer, sessionId: string): Buffer {
	if (!isPng(png) || png.length < IHDR_END || png.readUInt32BE(8) !== 13 || png.toString("latin1", 12, 16) !== "IHDR")
		throw new Error("不是有效的 PNG");
	const marker = chunk("tEXt", Buffer.concat([PREFIX, Buffer.from(encodeURIComponent(sessionId), "latin1")]));
	return Buffer.concat([png.subarray(0, IHDR_END), marker, png.subarray(IHDR_END)]);
}

/** Read what a PNG prefix says about itself; undefined when the bytes are not a PNG. */
export function inspectPng(data: Buffer): PngInspection | undefined {
	if (!isPng(data) || data.length < 24 || data.toString("latin1", 12, 16) !== "IHDR") return undefined;
	const report: PngInspection = { width: data.readUInt32BE(16), height: data.readUInt32BE(20), chunks: [] };
	let offset = SIGNATURE.length;
	while (report.chunks.length < MAX_LISTED_CHUNKS) {
		if (offset + 8 > data.length) {
			report.chunks.push("…");
			break;
		}
		const length = data.readUInt32BE(offset);
		const type = data.toString("latin1", offset + 4, offset + 8);
		if (!/^[A-Za-z]{4}$/.test(type) || length > 0x7fffffff) {
			report.chunks.push("…");
			break;
		}
		report.chunks.push(type);
		if (type === "tEXt" && !report.session) readMarker(data, offset, length, report);
		if (type === "IDAT" || type === "IEND") break;
		offset += 12 + length;
	}
	return report;
}

function readMarker(data: Buffer, offset: number, length: number, report: PngInspection): void {
	const start = offset + 8;
	const available = data.subarray(start, Math.min(start + length, data.length));
	const compared = Math.min(available.length, PREFIX.length);
	// Another program's text chunk is not ours; only a matching keyword is judged.
	if (length < PREFIX.length || !available.subarray(0, compared).equals(PREFIX.subarray(0, compared))) return;
	if (start + length + 4 > data.length) {
		report.markerProblem = "标记块超出读取范围";
		return;
	}
	const body = data.subarray(start, start + length);
	if (crc32(body, crc32(data.subarray(offset + 4, start))) !== data.readUInt32BE(start + length)) {
		report.markerProblem = "标记块 CRC 不符";
		return;
	}
	try {
		report.session = decodeURIComponent(body.subarray(PREFIX.length).toString("latin1"));
	} catch {
		report.markerProblem = "标记内容无法解码";
	}
}

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0);
	return Buffer.concat([head, data, crc]);
}

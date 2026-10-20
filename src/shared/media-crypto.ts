/**
 * WeCom long-connection media encryption, shared by pi (attachments) and the gateway (quoted images).
 *
 * Each image/file/video URL carries its own aeskey. The payload is AES-256-CBC encrypted with
 * PKCS#7 padding to 32 bytes; the IV is the first 16 bytes of the AES key.
 */
import { createDecipheriv } from "node:crypto";

/** The aeskey is Base64 (official SDK: `Buffer.from(aesKey, "base64")`), and must decode to 32 bytes. */
export function parseAesKey(raw: string): Buffer {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("empty aeskey");
	const key = Buffer.from(trimmed, "base64");
	// Buffer.from is lenient about invalid characters; a real 32-byte key round-trips exactly.
	if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
		throw new Error("invalid aeskey: expected a Base64-encoded 32-byte key");
	}
	return key;
}

export function decryptAes256Cbc(data: Buffer, key: Buffer): Buffer {
	if (key.length !== 32) throw new Error("invalid aeskey length");
	if (!data.length || data.length % 32 !== 0) throw new Error("invalid encrypted media length");
	const iv = key.subarray(0, 16);
	const decipher = createDecipheriv("aes-256-cbc", key, iv);
	// Node's automatic padding uses AES's 16-byte block size. WeCom uses 32.
	decipher.setAutoPadding(false);
	const plain = Buffer.concat([decipher.update(data), decipher.final()]);
	const padding = plain[plain.length - 1];
	if (padding < 1 || padding > 32 || !plain.subarray(-padding).every((byte) => byte === padding)) {
		throw new Error("invalid media PKCS#7 padding");
	}
	return plain.subarray(0, plain.length - padding);
}

/**
 * The plaintext of the leading whole AES blocks of an encrypted download. A CBC block depends only on
 * the ciphertext before it, so a file's header can be read without the rest of the file; the padding
 * lives at the end and is never seen here.
 */
export function decryptAes256CbcPrefix(data: Buffer, key: Buffer): Buffer {
	if (key.length !== 32) throw new Error("invalid aeskey length");
	const whole = data.subarray(0, data.length - (data.length % 16));
	const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
	decipher.setAutoPadding(false);
	return Buffer.concat([decipher.update(whole), decipher.final()]);
}

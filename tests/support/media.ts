import { createCipheriv } from "node:crypto";

export const MEDIA_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));

/** Encrypt as WeCom does for a long-connection media URL: AES-256-CBC, PKCS#7 padded to 32 bytes. */
export function encryptMedia(plain: Buffer, key = MEDIA_KEY): Buffer {
	const padding = 32 - (plain.length % 32);
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(padding, padding)])), cipher.final()]);
}

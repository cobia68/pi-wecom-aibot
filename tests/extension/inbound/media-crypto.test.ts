import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { test } from "node:test";
import { decryptAes256Cbc, parseAesKey } from "../../../src/extension/inbound/media-crypto.ts";
import { encryptMedia, MEDIA_KEY as key } from "../../support/media.ts";

test("decrypts WeCom media with every possible 32-byte padding length", () => {
	for (let length = 0; length < 64; length++) {
		const plain = Buffer.alloc(length, 0x61);
		assert.deepEqual(decryptAes256Cbc(encryptMedia(plain), key), plain, `plaintext length ${length}`);
	}
});

test("accepts the official Base64 key, with or without padding", () => {
	assert.deepEqual(parseAesKey(key.toString("base64")), key);
	assert.deepEqual(parseAesKey(key.toString("base64").replace(/=+$/, "")), key);
});

test("rejects the hex and raw spellings the API never sends", () => {
	assert.throws(() => parseAesKey(key.toString("hex")), /aeskey/i);
	assert.throws(() => parseAesKey("a".repeat(32)), /aeskey/i);
});

test("rejects malformed keys instead of silently truncating them", () => {
	assert.throws(() => parseAesKey(Buffer.alloc(33, 1).toString("base64")), /aeskey/i);
});

test("rejects corrupted padding even when the last padding byte is plausible", () => {
	const padded = Buffer.alloc(32, 7);
	padded[31] = 2;
	const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
	cipher.setAutoPadding(false);
	assert.throws(() => decryptAes256Cbc(Buffer.concat([cipher.update(padded), cipher.final()]), key), /padding/);
});

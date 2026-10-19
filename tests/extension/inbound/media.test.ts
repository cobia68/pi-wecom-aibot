import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { test } from "node:test";
import { decryptAes256Cbc, downloadAndDecrypt, parseAesKey } from "../../../src/extension/inbound/media.ts";

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));

function encrypt(plain: Buffer): Buffer {
  const padding = 32 - (plain.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(padding, padding)])), cipher.final()]);
}

test("decrypts WeCom media with every possible 32-byte padding length", () => {
  for (let length = 0; length < 64; length++) {
    const plain = Buffer.alloc(length, 0x61);
    assert.deepEqual(decryptAes256Cbc(encrypt(plain), key), plain, `plaintext length ${length}`);
  }
});

test("accepts the exact key in base64, unpadded base64, hex, or raw form", () => {
  assert.deepEqual(parseAesKey(key.toString("base64")), key);
  assert.deepEqual(parseAesKey(key.toString("base64").replace(/=+$/, "")), key);
  assert.deepEqual(parseAesKey(key.toString("hex")), key);
  assert.deepEqual(parseAesKey("a".repeat(32)), Buffer.from("a".repeat(32)));
});

test("rejects malformed keys instead of silently truncating them", () => {
  assert.throws(() => parseAesKey(Buffer.alloc(33, 1).toString("base64")), /aeskey/i);
});

test("detects image type from decrypted bytes when HTTP reports an opaque payload", async (t) => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30, 1)]);
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(encrypt(jpeg)), {
    headers: { "content-type": "application/octet-stream" },
  }));
  const media = await downloadAndDecrypt("https://example.invalid/image", key.toString("base64"));
  assert.equal(media.mimeType, "image/jpeg");
  assert.deepEqual(media.buffer, jpeg);
});

test("rejects corrupted padding even when the last padding byte is plausible", () => {
  const padded = Buffer.alloc(32, 7);
  padded[31] = 2;
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  assert.throws(() => decryptAes256Cbc(Buffer.concat([cipher.update(padded), cipher.final()]), key), /padding/);
});

test("limits streaming downloads even without a Content-Length header", async (t) => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(16)); },
    cancel() { cancelled = true; },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(stream));
  await assert.rejects(downloadAndDecrypt("https://example.invalid/large", undefined, { maxBytes: 8 }), /size limit/);
  assert.equal(cancelled, true);
});

test("a failed HTTP response releases its unread body", async (t) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 503 }));
  await assert.rejects(downloadAndDecrypt("https://example.invalid/unavailable"), /HTTP 503/);
  assert.equal(cancelled, true);
});

test("aborting an unfinished response body cancels the reader instead of holding a preparation slot", { timeout: 2000 }, async (t) => {
  let cancelled = false;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel() { cancelled = true; } });
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  const controller = new AbortController();
  const pending = downloadAndDecrypt("https://example.invalid/unfinished", undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await reading;
  // Allow fetch to hand its stream to the downloader before aborting it.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(cancelled, true);
});

test("an aborted media request does not begin a download", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(downloadAndDecrypt("https://example.invalid/image", undefined, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

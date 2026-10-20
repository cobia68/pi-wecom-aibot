import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadAndDecrypt } from "../../../src/extension/inbound/media.ts";
import { encryptMedia, MEDIA_KEY } from "../../support/media.ts";

test("detects image type from decrypted bytes when HTTP reports an opaque payload", async (t) => {
	const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30, 1)]);
	t.mock.method(
		globalThis,
		"fetch",
		async () =>
			new Response(new Uint8Array(encryptMedia(jpeg)), {
				headers: { "content-type": "application/octet-stream" },
			}),
	);
	const media = await downloadAndDecrypt("https://example.invalid/image", MEDIA_KEY.toString("base64"));
	assert.equal(media.mimeType, "image/jpeg");
	assert.deepEqual(media.buffer, jpeg);
});

test("limits streaming downloads even without a Content-Length header", async (t) => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(16));
		},
		cancel() {
			cancelled = true;
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response(stream));
	await assert.rejects(downloadAndDecrypt("https://example.invalid/large", undefined, { maxBytes: 8 }), /size limit/);
	assert.equal(cancelled, true);
});

test("a failed HTTP response releases its unread body", async (t) => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 503 }));
	await assert.rejects(downloadAndDecrypt("https://example.invalid/unavailable"), /HTTP 503/);
	assert.equal(cancelled, true);
});

test("aborting an unfinished response body cancels the reader instead of holding a preparation slot", {
	timeout: 2000,
}, async (t) => {
	let cancelled = false;
	let started!: () => void;
	const reading = new Promise<void>((resolve) => {
		started = resolve;
	});
	const body = new ReadableStream<Uint8Array>({
		pull() {
			started();
		},
		cancel() {
			cancelled = true;
		},
	});
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
	await assert.rejects(downloadAndDecrypt("https://example.invalid/image", undefined, { signal: controller.signal }), {
		name: "AbortError",
	});
	assert.equal(fetchMock.mock.callCount(), 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { stampPng } from "../../src/gateway/png-marker.ts";
import { QUOTED_IMAGE_BYTES, readQuotedImage } from "../../src/gateway/quoted-image.ts";
import type { QuotedImage } from "../../src/shared/wecom-protocol.ts";
import { encryptMedia, MEDIA_KEY, TINY_PNG } from "../support/media.ts";

const SESSION = "01234567-89ab-4cde-8012-3456789abcde";
const URL = "https://wecom.example.invalid/quoted?sign=SECRET-SIGNATURE";
const AESKEY = MEDIA_KEY.toString("base64");

function quoted(extra: Partial<QuotedImage> = {}): QuotedImage {
	return {
		msgtype: "image",
		quoteFields: ["msgtype", "image"],
		imageFields: ["url", "aeskey"],
		url: URL,
		aeskey: AESKEY,
		...extra,
	};
}

function serve(body: Buffer, status = 200) {
	return async () =>
		new Response(new Uint8Array(body), { status, headers: { "content-length": String(body.length) } });
}

test("our PNG, served back encrypted, names its session without leaking the link or the key", async (t) => {
	const encrypted = encryptMedia(stampPng(TINY_PNG, SESSION));
	t.mock.method(globalThis, "fetch", serve(encrypted));
	const reading = await readQuotedImage(quoted());
	assert.equal(reading.sessionId, SESSION);
	assert.match(reading.report, /^引用图片：引用类型 image；字段 msgtype,image；image 字段 url,aeskey；HTTP 200；/);
	assert.match(
		reading.report,
		new RegExp(`Content-Length ${encrypted.length}；PNG 1×1；块 IHDR,tEXt,IDAT；读到标记 session ${SESSION}$`),
	);
	assert.doesNotMatch(reading.report, /SECRET-SIGNATURE|wecom\.example/);
	assert.ok(!reading.report.includes(AESKEY));
});

test("a PNG without our chunk names nothing, and says which chunks it has", async (t) => {
	t.mock.method(globalThis, "fetch", serve(encryptMedia(TINY_PNG)));
	const reading = await readQuotedImage(quoted());
	assert.equal(reading.sessionId, undefined);
	assert.match(reading.report, /PNG 1×1；块 IHDR,IDAT；没有标记$/);
});

test("a re-encoded image reports its format, or its first bytes when the format is unknown", async (t) => {
	t.mock.method(globalThis, "fetch", serve(encryptMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))));
	const jpeg = await readQuotedImage(quoted());
	assert.equal(jpeg.sessionId, undefined);
	assert.match(jpeg.report, /格式 JPEG；不是原 PNG，读不到标记$/);
	t.mock.restoreAll();
	t.mock.method(globalThis, "fetch", serve(encryptMedia(Buffer.from("ftypheic"))));
	assert.match((await readQuotedImage(quoted())).report, /格式未知（开头 [0-9a-f]{24}）；不是原 PNG/);
});

test("without an aeskey the bytes are read as they are", async (t) => {
	t.mock.method(globalThis, "fetch", serve(stampPng(TINY_PNG, SESSION)));
	const reading = await readQuotedImage(quoted({ imageFields: ["url"], aeskey: undefined }));
	assert.equal(reading.sessionId, SESSION);
	assert.match(reading.report, /image 字段 url；.*没有 aeskey，按未加密读取；.*读到标记 session/);
});

test("an aeskey on a plain body is reported instead of garbling it", async (t) => {
	t.mock.method(globalThis, "fetch", serve(stampPng(TINY_PNG, SESSION)));
	assert.match((await readQuotedImage(quoted())).report, /有 aeskey 但正文未加密；.*读到标记 session/);
});

test("a failed download reports only its status or reason, and names nothing", async (t) => {
	t.mock.method(globalThis, "fetch", serve(Buffer.from("expired"), 403));
	const forbidden = await readQuotedImage(quoted());
	assert.equal(forbidden.sessionId, undefined);
	assert.match(forbidden.report, /HTTP 403；Content-Length 7；未读取正文$/);
	t.mock.restoreAll();
	t.mock.method(globalThis, "fetch", async () => {
		throw new TypeError(`fetch failed for ${URL}`, { cause: new Error("getaddrinfo ENOTFOUND") });
	});
	const offline = await readQuotedImage(quoted());
	assert.match(offline.report, /下载失败：fetch failed for <链接>（getaddrinfo ENOTFOUND）$/);
	assert.doesNotMatch(offline.report, /SECRET-SIGNATURE/);
});

test("nothing is fetched without an https link", async (t) => {
	const fetchMock = t.mock.method(globalThis, "fetch");
	for (const [image, expected] of [
		[quoted({ msgtype: "file", quoteFields: ["msgtype", "file"], url: undefined, imageFields: [] }), /没有下载链接$/],
		[quoted({ url: undefined, imageFields: [] }), /image 字段 无；没有下载链接$/],
		[quoted({ url: "http://wecom.example.invalid/x" }), /不是 https（http:），未下载$/],
		[quoted({ url: "not a url" }), /下载链接无效$/],
	] as const) {
		const reading = await readQuotedImage(image);
		assert.equal(reading.sessionId, undefined);
		assert.match(reading.report, expected);
	}
	assert.equal(fetchMock.mock.callCount(), 0);
});

test("only the head of the file is downloaded", async (t) => {
	const file = encryptMedia(stampPng(TINY_PNG, SESSION));
	let pulls = 0;
	let cancelled = false;
	// An endless body: the read resolves only because it stops reading on its own.
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(file));
		},
		pull(controller) {
			pulls++;
			controller.enqueue(new Uint8Array(QUOTED_IMAGE_BYTES));
		},
		cancel() {
			cancelled = true;
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body));
	const reading = await readQuotedImage(quoted());
	assert.equal(reading.sessionId, SESSION);
	assert.match(reading.report, /Content-Length 未知；PNG 1×1；块 IHDR,tEXt,IDAT；读到标记 session/);
	assert.equal(cancelled, true);
	assert.ok(pulls < 5, `pulled ${pulls} chunks`);
});

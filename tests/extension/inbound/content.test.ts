import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { InboundContentPreparer } from "../../../src/extension/inbound/content.ts";
import type { InboundMessage, Attachment } from "../../../src/shared/wecom-protocol.ts";

const png = () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } });
const image = (id: string): Attachment => ({ kind: "image", url: `https://example.invalid/${id}` });
function message(id: string, attachments = [image(id)]): InboundMessage {
  return { msgId: id, msgtype: "image", chat: { chatId: "user", chatType: 1 }, userid: "user", text: "[图片]", attachments };
}
const images = (prepared: Awaited<ReturnType<InboundContentPreparer["prepare"]>>) => prepared.content.filter((part) => part.type === "image");
const text = (prepared: Awaited<ReturnType<InboundContentPreparer["prepare"]>>) => prepared.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

test("the source chat is returned separately and never injected into the prompt", async (t) => {
  t.mock.method(globalThis, "fetch", async () => png());
  const preparer = new InboundContentPreparer();
  const signal = new AbortController().signal;
  const plain = await preparer.prepare(tmpdir(), { ...message("plain", []), text: "用户正文" }, signal);
  assert.equal(text(plain), "用户正文");
  assert.deepEqual(plain.chat, { chatId: "user", chatType: 1, userid: "user" });
  assert.doesNotMatch(text(plain), /\[企业微信|chatid=/);
  plain.release();
  const imageOnly = await preparer.prepare(tmpdir(), message("image-only"), signal);
  assert.equal(text(imageOnly), "", "the old placeholder/header is gone");
  assert.equal(images(imageOnly).length, 1);
  imageOnly.release();
});

test("queued images share one byte budget, release frees it, and a second release cannot steal another owner's bytes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => png());
  // An 8-byte fixture encodes to 12 Base64 bytes: this budget admits exactly one retained image.
  const preparer = new InboundContentPreparer({ maxImageBytes: 12 });
  const signal = new AbortController().signal;
  const first = await preparer.prepare(tmpdir(), message("first"), signal);
  const blocked = await preparer.prepare(tmpdir(), message("blocked"), signal);
  assert.equal(images(first).length, 1);
  assert.equal(images(blocked).length, 0);
  assert.match(text(blocked), /图片处理失败.*资源上限/);
  first.release();
  const next = await preparer.prepare(tmpdir(), message("next"), signal);
  assert.equal(images(next).length, 1);
  first.release();
  const stillBlocked = await preparer.prepare(tmpdir(), message("still-blocked"), signal);
  assert.equal(images(stillBlocked).length, 0);
  for (const prepared of [blocked, next, stillBlocked]) prepared.release();
});

test("several images in one message cannot exceed the same budget, and text survives partial preparation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => png());
  const preparer = new InboundContentPreparer({ maxImageBytes: 12 });
  const mixed = { ...message("mixed", [image("one"), image("two")]), text: "Keep this question" };
  const prepared = await preparer.prepare(tmpdir(), mixed, new AbortController().signal);
  assert.equal(images(prepared).length, 1);
  assert.match(text(prepared), /Keep this question/);
  assert.match(text(prepared), /图片处理失败.*资源上限/);
  prepared.release();
});

test("aborting partway through a message returns both its image budget and preparation slot", { timeout: 2000 }, async (t) => {
  let secondStarted!: () => void;
  const started = new Promise<void>((resolve) => { secondStarted = resolve; });
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    if (++downloads !== 2) return png();
    secondStarted();
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
  });
  const preparer = new InboundContentPreparer({ concurrency: 1, maxImageBytes: 12 });
  const cancel = new AbortController();
  const pending = preparer.prepare(tmpdir(), message("cancelled", [image("one"), image("two")]), cancel.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started;
  cancel.abort();
  await rejected;
  const next = await preparer.prepare(tmpdir(), message("after-cancel"), new AbortController().signal);
  assert.equal(images(next).length, 1);
  next.release();
});

test("cancelled waiters do not fetch, FIFO preparations make progress, and text needs no media slot", { timeout: 2000 }, async (t) => {
  const urls: string[] = [];
  let finish!: (response: Response) => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    urls.push(String(url));
    if (urls.length > 1) return png();
    firstStarted();
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const preparer = new InboundContentPreparer({ concurrency: 1 });
  const signal = new AbortController().signal;
  const first = preparer.prepare(tmpdir(), message("first"), signal);
  await started;
  const cancel = new AbortController();
  const skipped = preparer.prepare(tmpdir(), message("cancelled"), cancel.signal);
  const rejected = assert.rejects(skipped, { name: "AbortError" });
  const last = preparer.prepare(tmpdir(), message("last"), signal);
  const plain = await preparer.prepare(tmpdir(), { ...message("text", []), text: "plain text" }, signal);
  assert.match(text(plain), /plain text/);
  cancel.abort();
  await rejected;
  assert.deepEqual(urls, ["https://example.invalid/first"]);
  finish(png());
  const prepared = await Promise.all([first, last]);
  assert.deepEqual(urls, ["https://example.invalid/first", "https://example.invalid/last"]);
  for (const item of [...prepared, plain]) item.release();
});

test("abort immediately after admission does not leak the preparation slot", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => png());
  const preparer = new InboundContentPreparer({ concurrency: 1 });
  const cancel = new AbortController();
  const first = preparer.prepare(tmpdir(), message("cancelled"), cancel.signal);
  cancel.abort();
  await assert.rejects(first, { name: "AbortError" });
  const next = await preparer.prepare(tmpdir(), message("next"), new AbortController().signal);
  assert.equal(images(next).length, 1);
  assert.equal(fetch.mock.callCount(), 1);
  next.release();
});

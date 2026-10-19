import assert from "node:assert/strict";
import { test } from "node:test";
import type { WeComConfig } from "../../../src/extension/config.ts";
import { notificationPayload, renderNotification } from "../../../src/shared/notification.ts";
import { parseFontFiles, prepareScreenNotification, screenText } from "../../../src/extension/screen/notification.ts";
import { renderScreenPng, type FontSet } from "../../../src/extension/screen/render.ts";

const source = { sessionId: "test-session", provider: "provider", modelName: "model", directoryName: "project" };
const notification = notificationPayload("notification", source, "结果文字");
const config: WeComConfig = {
  botId: "test-bot", secret: "wecom-secret", enabled: true, welcome: "hi", screenMode: "text",
  imageHosts: [{ type: "http", url: "https://images.example/upload?key=upload-secret", fileField: "image" }],
};
const imageConfig: WeComConfig = { ...config, screenMode: "image" };
const screen = { lines: ["Hello"], columns: 80, foreground: "#eeeeee", background: "#111111" };

test("text mode replaces the body with the plain screen text and never touches fonts, hosts or the network", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("text mode must not upload"));
  const styled = { ...screen, lines: ["\x1b[32m结果 OK\x1b[0m   ", "", "\x1b[1m最后一行\x1b[0m"] };
  const prepared = await prepareScreenNotification(notification, {
    ...config, imageHosts: "not an array" as never, fontFiles: "not an array" as never,
  }, () => styled, {
    render: async () => assert.fail("text mode must not render"),
    warn: () => assert.fail("text mode has nothing to warn about"),
  });
  assert.equal(prepared.text, "结果 OK\n\n最后一行");
  assert.equal(screenText(styled), "结果 OK\n\n最后一行", "ANSI styles and padding are dropped");
  const output = renderNotification(source, prepared.text, prepared);
  assert.match(output, /\n\n结果 OK\n\n最后一行$/);
  assert.doesNotMatch(output, /\x1b|结果文字|!\[/);
});

test("text mode keeps only the last 20 visible lines", async () => {
  const many = { ...screen, lines: Array.from({ length: 30 }, (_, index) => `LINE-${index + 1}`) };
  const prepared = await prepareScreenNotification(notification, config, () => many);
  assert.match(prepared.text, /^LINE-11\nLINE-12/);
  assert.match(prepared.text, /\nLINE-30$/);
  assert.doesNotMatch(prepared.text, /LINE-10/);
});

test("the default mode is text even when the configuration predates screenMode", async () => {
  const legacy = { ...config, screenMode: undefined };
  const prepared = await prepareScreenNotification(notification, legacy, () => ({ ...screen, lines: ["legacy default"] }));
  assert.equal(prepared.text, "legacy default");
});

test("image mode uses the image link as the whole body instead of a text-plus-image notification", async (t) => {
  let captured = false;
  let finish!: (png: Uint8Array) => void;
  t.mock.method(globalThis, "fetch", async () => new Response("https://cdn.example/pi.png"));
  const pending = prepareScreenNotification(notification, imageConfig, () => { captured = true; return screen; }, {
    render: async (snapshot, options) => {
      assert.equal(snapshot, screen);
      assert.ok(options?.secrets?.includes("wecom-secret"));
      assert.ok(options?.secrets?.includes("upload-secret"));
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  assert.equal(captured, true, "capture precedes the first asynchronous boundary");
  finish(new Uint8Array([1, 2, 3]));
  const prepared = await pending;
  assert.equal(prepared.text, "![pi 终端画面](https://cdn.example/pi.png)");
  const output = renderNotification(source, prepared.text, prepared);
  assert.match(output, /\n\n!\[pi 终端画面\]\(https:\/\/cdn\.example\/pi\.png\)$/);
  assert.doesNotMatch(output, /结果文字/);
  assert.doesNotMatch(JSON.stringify(prepared), /wecom-secret|upload-secret|Hello/);
});

test("image configuration failures keep the notification usable by sending the screen text with a reason", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("invalid configuration must not reach the network"));
  const retired = { type: "gitea", repo: "https://git.example/owner/images", token: "retired-private-token" };
  for (const imageHosts of [[retired], [retired, ...imageConfig.imageHosts!]]) {
    const warnings: string[] = [];
    const prepared = await prepareScreenNotification(notification, { ...imageConfig, imageHosts } as WeComConfig, () => screen, {
      render: async () => assert.fail("invalid host configuration must not render an image"),
      warn: (message) => warnings.push(message),
    });
    assert.match(prepared.text, /^Hello\n\n（图片配置有误.*type 只能是 http.*文字照常发送）$/);
    assert.doesNotMatch(prepared.text, /!\[|retired-private-token|git\.example|结果文字/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /type 只能是 http/);
  }
  const missing = await prepareScreenNotification(notification, { ...imageConfig, imageHosts: [] }, () => screen, {
    render: async () => assert.fail("no host must not render"),
  });
  assert.match(missing.text, /^Hello\n\n（图片配置有误：没有配置图床（imageHosts）；文字照常发送）$/);
});

test("upload failure keeps the screen text, redacts credentials and escapes injected Markdown in the explanation", async (t) => {
  const warnings: string[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response("wecom-secret upload-secret ![](https://unexpected.example/x.png)", { status: 503 }));
  const prepared = await prepareScreenNotification(notification, imageConfig, () => screen, {
    render: async () => new Uint8Array([1]), warn: (message) => warnings.push(message),
  });
  assert.match(prepared.text, /^Hello\n\n/);
  assert.match(prepared.text, /图片上传失败/);
  assert.doesNotMatch(prepared.text, /wecom-secret|upload-secret|结果文字/);
  assert.doesNotMatch(prepared.text, /!\[\]/);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /wecom-secret|upload-secret/);
});

test("cancelling during rendering never uploads or sends a fallback", async (t) => {
  const abort = new AbortController();
  let finish!: (png: Uint8Array) => void;
  t.mock.method(globalThis, "fetch", () => assert.fail("cancelled render must not be uploaded"));
  const pending = prepareScreenNotification(notification, imageConfig, () => screen, {
    signal: abort.signal, render: () => new Promise((resolve) => { finish = resolve; }),
    warn: () => assert.fail("cancellation is not an image failure"),
  });
  abort.abort(new Error("stopped"));
  finish(new Uint8Array());
  await assert.rejects(pending, /stopped/);
});

test("missing Linux CJK fonts send the screen text and never upload an image", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("a missing font must not trigger an upload or a font download"));
  const warnings: string[] = [];
  const fonts: FontSet = {
    platform: "linux", buffers: [], families: ["Latin"], hasCjk: false,
    metrics: { advance: 0.6, ascent: 0.8, descent: 0.2, lineGap: 0 },
  };
  const prepared = await prepareScreenNotification(notification, imageConfig, () => ({ ...screen, lines: ["中文结果"] }), {
    render: (snapshot, options) => renderScreenPng(snapshot, { ...options, fonts }),
    warn: (message) => warnings.push(message),
  });
  assert.match(prepared.text, /^中文结果/);
  assert.match(prepared.text, /CJK.*安装/);
  assert.match(prepared.text, /文字照常发送/);
  assert.doesNotMatch(prepared.text, /!\[/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fonts-noto-cjk/);
});

test("an unavailable or empty screen falls back to the original notification text with a reason", async () => {
  const unsupported = await prepareScreenNotification(notification, config, () => { throw new Error("RPC 不支持终端画面"); });
  assert.match(unsupported.text, /^结果文字\n\n（画面获取失败：RPC 不支持终端画面；文字照常发送）$/);
  const empty = await prepareScreenNotification(notification, config, () => ({ ...screen, lines: ["   ", ""] }));
  assert.match(empty.text, /^结果文字\n\n（画面获取失败：终端没有可发送的可见内容；文字照常发送）$/);
});

test("font file configuration is bounded and does not silently accept the wrong type", () => {
  assert.equal(parseFontFiles(undefined), undefined);
  assert.deepEqual(parseFontFiles([" /fonts/mono.ttf ", "C:\\Windows\\Fonts\\msyh.ttc"]), ["/fonts/mono.ttf", "C:\\Windows\\Fonts\\msyh.ttc"]);
  for (const value of [null, "font.ttf", [""], [42], ["line\nbreak"], Array(9).fill("font.ttf")]) assert.throws(() => parseFontFiles(value), /fontFiles/);
});

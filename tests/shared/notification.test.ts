import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import {
  formatNotification, formatProcessingStatus, lastParagraphs, MAX_NOTIFICATION_BYTES,
  notificationPayload, quotedSessions, renderNotification, replaceNotificationBody,
} from "../../src/shared/notification.ts";

const source = { sessionId: "pi-session-1", provider: "test-provider", modelName: "Model A", directoryName: "pi-wecom-bot" };

test("metadata renders as three unstyled lines without changing body Markdown", () => {
  const message = formatNotification(source, "**正文强调**", { kind: "test" });
  const header = message.split("\n\n")[0];
  const html = marked.parse(header, { async: false, breaks: false });
  assert.equal((html.match(/<br\s*\/?>/g) ?? []).length, 2, "来源区必须有两个实际换行");
  assert.doesNotMatch(html, /<(?:strong|b|code)\b/, "来源区统一使用普通字体");
  assert.match(marked.parse(message, { async: false, breaks: false }), /<strong>正文强调<\/strong>/);
});

test("takes trailing paragraphs across Windows line endings", () => {
  assert.equal(lastParagraphs("开头\r\n\r\n中间\r\n\r\n结尾\r\n", 2), "中间\n\n结尾");
});

test("blank lines inside fenced code do not split the excerpt", () => {
  const code = "```ts\nconst value = 1;\n\nconsole.log(value);\n```";
  assert.equal(lastParagraphs(`说明\n\n${code}\n\n最后一段`, 2), `${code}\n\n最后一段`);
});

test("excerpt truncation keeps the tail and session ID within the UTF-8 byte limit", () => {
  const message = formatNotification(source, `${"汉字🙂".repeat(4000)}最后结论`, { tailParagraphs: 3 });
  assert.ok(Buffer.byteLength(message, "utf8") <= MAX_NOTIFICATION_BYTES);
  assert.match(message, /pi-session-1/);
  assert.match(message, /test-provider/);
  assert.match(message, /Model A/);
  assert.match(message, /pi-wecom-bot/);
  assert.match(message, /前文已截断/);
  assert.match(message, /最后结论$/);
  assert.equal(message.includes("\ufffd"), false);
});

test("invalid paragraph counts cannot silently change the excerpt", () => {
  for (const count of [0, -1, 1.5, 21]) assert.throws(() => lastParagraphs("text", count), /tail_paragraphs/);
});

test("metadata and abort notice both count towards the byte budget", () => {
  assert.throws(() => formatNotification(source, "x".repeat(MAX_NOTIFICATION_BYTES)), /20480/);
  const message = formatNotification(source, "汉🙂".repeat(6000), { kind: "completion", tailParagraphs: 2, aborted: true });
  assert.ok(Buffer.byteLength(message, "utf8") <= MAX_NOTIFICATION_BYTES);
  assert.match(message, /^🔔 pi-wecom-bot · 会话通知  \n/);
  assert.match(message, /本轮任务已中止/);
  assert.equal(message.includes("\ufffd"), false);
  assert.throws(() => formatNotification({ ...source, modelName: "x".repeat(MAX_NOTIFICATION_BYTES) }, "result", { tailParagraphs: 1 }), /来源信息过长/);
});

test("welcome text uses the same source fields within its plain text byte limit", () => {
  const message = formatNotification(source, "你好🙂".repeat(1000), { kind: "welcome" });
  assert.ok(Buffer.byteLength(message, "utf8") <= 2048);
  assert.match(message, /^🔔 pi-wecom-bot · 欢迎\n🏷️ test-provider · Model A\n🆔 session: pi-session-1\n\n/);
  assert.match(message, /已截断/);
  assert.equal(message.includes("\ufffd"), false);
});

test("metadata stays on a single line and embedded backticks cannot break the header", () => {
  const message = formatNotification({ ...source, modelName: "Model `A`\nextra", directoryName: "project`name" }, "body");
  assert.ok(message.startsWith("🔔 project\\`name · 会话通知  \n"));
  assert.ok(message.includes("\n🏷️ test-provider · Model \\`A\\` extra  \n🆔 session: "));
  assert.throws(() => formatNotification({ ...source, sessionId: "another\nsession" }, "body"), /session_id/);
});

test("every published envelope round-trips: a quoted notification or status routes to its exact session", () => {
  const tricky = { ...source, sessionId: "session_with_[brackets]\\suffix", directoryName: "project session: notes", modelName: "model `A`" };
  for (const kind of ["notification", "completion", "reply", "test", "welcome"] as const) {
    const message = formatNotification(tricky, `body\nsession: another-session`, { kind });
    assert.deepEqual(quotedSessions(message), [tricky.sessionId], kind);
    // WeCom may prefix each quoted line with "> ".
    assert.deepEqual(quotedSessions(message.split("\n").map((line) => `> ${line}`).join("\n")), [tricky.sessionId], `${kind} quoted`);
  }
  for (const state of ["running", "settled", "stopped", "waiting", "busy", "failed"] as const) {
    assert.deepEqual(quotedSessions(formatProcessingStatus(tricky.sessionId, state)), [tricky.sessionId], state);
  }
  // A source header without its session line never falls back to another ID in the text.
  assert.deepEqual(quotedSessions("project · 会话通知\nprovider · model"), [""]);
});

test("notifications and status messages sent before the header icons still route to their session", () => {
  for (const legacy of [
    "project · 会话通知  \nprovider · model  \nsession: s1\n\nresult",
    "session: s1  \n执行中…",
  ]) {
    assert.deepEqual(quotedSessions(legacy), ["s1"]);
    assert.deepEqual(quotedSessions(legacy.split("\n").map((line) => `> ${line}`).join("\n")), ["s1"]);
  }
});

test("a screen body replaces the text and keeps its tail through UTF-8 truncation", () => {
  const image = "![pi 终端画面](https://cdn.example/screen.png)";
  for (const tail of [undefined, 3]) {
    const payload = notificationPayload("completion", source, `HEAD-${"汉🙂".repeat(10_000)}-TAIL`, { tailParagraphs: tail, aborted: true });
    const prepared = replaceNotificationBody(payload, `${payload.text}\n\n${image}`);
    const output = renderNotification(source, prepared.text, prepared);
    assert.ok(Buffer.byteLength(output) <= MAX_NOTIFICATION_BYTES);
    assert.equal(output.includes("\ufffd"), false);
    assert.ok(output.includes(image), "the image is the body, not an appended leftover");
    assert.match(output, /前文已截断/);
    assert.match(output, /-TAIL\n\n!\[/);
    assert.match(output, /本轮任务已中止/);
    assert.deepEqual(quotedSessions(output), [source.sessionId]);
    assert.match(marked.parse(output, { async: false }), /<img src="https:\/\/cdn.example\/screen.png" alt="pi 终端画面"/);
  }
});

test("a replaced body keeps pi's header, stays within the limit and never appends anything after it", () => {
  const body = "最后一行结果\n\n![pi 终端画面](https://cdn.example/screen.png)";
  const payload = notificationPayload("notification", source, "旧正文应被替换");
  const prepared = replaceNotificationBody(payload, body);
  const output = renderNotification(source, prepared.text, prepared);
  assert.match(output, /\n\n最后一行结果\n\n!\[pi 终端画面\]/);
  assert.doesNotMatch(output, /旧正文/);
  assert.ok(Buffer.byteLength(output) <= MAX_NOTIFICATION_BYTES);
  assert.deepEqual(quotedSessions(output), [source.sessionId]);
  assert.throws(() => replaceNotificationBody(payload, "  \n "), /没有可发送的内容/);
});

test("pi's notification payload, rendered by the gateway, is exactly the formatted notification", () => {
  const long = `开头\n\n${"汉字🙂".repeat(30_000)}\n\n结尾`;
  const cases = [
    ["completion", "最终结果\n\n验证通过", { tailParagraphs: 1, aborted: true }],
    ["completion", long, { tailParagraphs: 3 }],
    ["reply", long, {}],
    ["notification", "自定义正文", {}],
    ["test", "部署测试正文", {}],
  ] as const;
  for (const [kind, text, options] of cases) {
    const payload = notificationPayload(kind, source, text, options);
    assert.ok(Buffer.byteLength(payload.text) <= 256 * 1024, "the IPC body is bounded");
    assert.equal(renderNotification(payload.source, payload.text, payload), formatNotification(source, text, { kind, ...options }), kind);
  }
});

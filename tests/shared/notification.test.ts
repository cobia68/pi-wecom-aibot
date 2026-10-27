import assert from "node:assert/strict";
import { test } from "node:test";
import { marked } from "marked";
import {
	ABORTED_SUFFIX,
	formatProcessingStatus,
	MAX_NOTIFICATION_BYTES,
	notificationPayload,
	quotedSessions,
	sessionMarkdown,
	sessionNote,
} from "../../src/shared/notification.ts";

const source = {
	sessionId: "pi-session-1",
	provider: "test-provider",
	modelName: "Model A",
	directoryName: "pi-wecom-aibot",
};

test("text outside a card opens with two unstyled source lines and keeps the body's Markdown", () => {
	const message = sessionMarkdown(source, "**正文强调**");
	const header = message.split("\n\n")[0];
	const html = marked.parse(header, { async: false, breaks: false });
	assert.equal((html.match(/<br\s*\/?>/g) ?? []).length, 1, "来源区两行之间必须有实际换行");
	assert.doesNotMatch(html, /<(?:strong|b|code)\b/, "来源区统一使用普通字体");
	assert.match(marked.parse(message, { async: false, breaks: false }), /<strong>正文强调<\/strong>/);
});

test("a long body is cut from the end within the UTF-8 byte limit, keeping its source and suffix", () => {
	const message = sessionMarkdown(source, `开头结论${"汉字🙂".repeat(4000)}`, ABORTED_SUFFIX);
	assert.ok(Buffer.byteLength(message, "utf8") <= MAX_NOTIFICATION_BYTES);
	assert.match(message, /^🆔 session: pi-session-1/);
	assert.match(message, /开头结论/);
	assert.match(message, /内容过长已截断/);
	assert.ok(message.endsWith(ABORTED_SUFFIX));
	assert.equal(message.includes("\ufffd"), false);
	assert.throws(
		() => sessionMarkdown({ ...source, modelName: "x".repeat(MAX_NOTIFICATION_BYTES) }, "r"),
		/来源信息过长/,
	);
});

test("metadata stays on its lines and embedded backticks cannot break the header", () => {
	const message = sessionMarkdown({ ...source, modelName: "Model `A`\nextra", directoryName: "project`name" }, "body");
	assert.ok(
		message.startsWith("🆔 session: pi-session-1  \n🏷️ project\\`name · test-provider · Model \\`A\\` extra\n\n"),
	);
	assert.throws(() => sessionMarkdown({ ...source, sessionId: "another\nsession" }, "body"), /session_id/);
});

test("everything the bot writes outside a card routes a quote back to its exact session", () => {
	const tricky = { ...source, sessionId: "session_with_[brackets]\\suffix", directoryName: "project session: notes" };
	const written = [
		sessionMarkdown(tricky, "body\nsession: another-session"),
		sessionNote(tricky.sessionId, "中止请求未送达：会话已离线"),
		...(["stopped", "busy", "failed", "cancelled"] as const).map((state) =>
			formatProcessingStatus(tricky.sessionId, state),
		),
	];
	for (const message of written) {
		assert.deepEqual(quotedSessions(message), [tricky.sessionId], message);
		// WeCom may prefix each quoted line with "> ".
		const quoted = message
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n");
		assert.deepEqual(quotedSessions(quoted), [tricky.sessionId], `quoted ${message}`);
	}
});

test("other quoted text routes only when every session marker in it is a clean line naming one ID", () => {
	assert.deepEqual(quotedSessions("前面的话\nsession: s1\n后面的话"), ["s1"]);
	assert.deepEqual(quotedSessions("说明\nsession: s1\nsession: s2"), ["s1", "s2"]);
	// Prose that mentions a session is damage, never a guess.
	assert.deepEqual(quotedSessions("说明\nsession: s1\n另一个 session: s2 的输出"), ["s1", ""]);
	assert.deepEqual(quotedSessions("没有任何会话标记"), []);
});

test("pi's payload is bounded for IPC and carries only the options it was given", () => {
	const long = `开头\n\n${"汉字🙂".repeat(30_000)}\n\n结尾`;
	const payload = notificationPayload("result", source, long, {
		title: "  ✅ 完成  ",
		aborted: true,
	});
	assert.ok(Buffer.byteLength(payload.text) <= 256 * 1024);
	assert.equal(payload.text.includes("\ufffd"), false);
	assert.equal(payload.title, "✅ 完成");
	assert.equal(payload.aborted, true);
	assert.deepEqual(notificationPayload("notice", source, "正文"), { kind: "notice", source, text: "正文" });
	assert.throws(() => notificationPayload("notice", source, "   "), /没有可发送的文本/);
	assert.throws(() => notificationPayload("notice", { ...source, sessionId: "bad id" }, "正文"), /session_id/);
});

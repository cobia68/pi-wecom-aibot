import assert from "node:assert/strict";
import { test } from "node:test";
import { marked, type Tokens } from "marked";
import { markdownParts } from "../../src/shared/markdown-parts.ts";
import { MAX_NOTIFICATION_BYTES, quotedSessions, sessionMarkdownParts } from "../../src/shared/notification.ts";

const source = { sessionId: "session-A", directoryName: "project", provider: "provider", modelName: "Model A" };

test("Markdown parts preserve all text, line breaks and UTF-8 characters without a truncation marker", () => {
	for (const text of ["abc🙂中文".repeat(100), "一行\n\n下一行🙂\n".repeat(100), "x".repeat(4096)]) {
		const parts = markdownParts(text, 127);
		assert.ok(parts.length > 1);
		assert.equal(parts.join(""), text);
		for (const part of parts) {
			assert.ok(Buffer.byteLength(part) <= 127);
			assert.doesNotMatch(part, /\ufffd|已截断/);
		}
	}
	assert.deepEqual(markdownParts("short", 64), ["short"]);
	assert.throws(() => markdownParts("text", 0), /空间不足/);
});

test("code fences are closed and reopened on every part without dropping code lines", () => {
	for (const fence of ["```", "~~~~"]) {
		const code = Array.from({ length: 60 }, (_, i) => `const line${i} = "中文🙂";\n`).join("");
		const parts = markdownParts(`${fence}ts\n${code}${fence}`, 200);
		assert.ok(parts.length > 1);
		const recovered: string[] = [];
		for (const part of parts) {
			assert.ok(Buffer.byteLength(part) <= 200);
			assert.ok(part.startsWith(`${fence}ts\n`));
			assert.ok(part.endsWith(fence));
			const tokens = marked.lexer(part);
			assert.equal(tokens.length, 1);
			assert.equal(tokens[0].type, "code");
			recovered.push(part.slice(`${fence}ts\n`.length, -fence.length));
		}
		assert.equal(recovered.join(""), code);
	}
});

test("a long code line is split, not clipped, and each piece stays within the limit", () => {
	const code = "ab中文🙂".repeat(300);
	const parts = markdownParts(`before\n\n\`\`\`text\n${code}\n\`\`\`\n\nafter`, 160);
	assert.ok(parts[0].includes("before"));
	assert.ok(parts.at(-1)!.endsWith("after"));
	assert.ok(parts.every((part) => Buffer.byteLength(part) <= 160));
	const recovered = parts.flatMap((part) =>
		marked.lexer(part).filter((token): token is Tokens.Code => token.type === "code"),
	);
	assert.equal(recovered.map((token) => token.text).join(""), code);
});

test("fence markers inside code and longer closing fences do not lose the surrounding prose", () => {
	const body = `head\n\n\`\`\`\`js\n${"x\n".repeat(100)}\`\`\`\nendCode\n\`\`\`\`\`\n\ntail`;
	const parts = markdownParts(body, 128);
	assert.ok(parts.every((part) => Buffer.byteLength(part) <= 128));
	assert.ok(parts.at(-1)!.endsWith("tail"));
	const blocks = parts.flatMap((part) =>
		marked.lexer(part).filter((token): token is Tokens.Code => token.type === "code"),
	);
	assert.match(blocks.map((token) => token.text).join("\n"), /```\nendCode$/);
	assert.throws(() => markdownParts(`${"`".repeat(200)}\ncode`, 128), /围栏过长/);
	assert.throws(() => markdownParts(`\`\`\`js\ncode\n${"`".repeat(200)}`, 128), /围栏过长/);
});

test("full-text messages include a bounded source and part counter, and every part routes back to the original session", () => {
	const body = "正文🙂\n".repeat(10_000);
	const parts = sessionMarkdownParts(source, body);
	assert.ok(parts.length > 1);
	const chunks = parts.map((part, index) => {
		assert.ok(Buffer.byteLength(part) <= MAX_NOTIFICATION_BYTES);
		assert.deepEqual(quotedSessions(part), [source.sessionId]);
		const counter = `**全文 ${index + 1}/${parts.length}**\n\n`;
		assert.ok(part.includes(counter));
		return part.slice(part.indexOf(counter) + counter.length);
	});
	assert.equal(chunks.join(""), body.trim());
	assert.doesNotMatch(parts.join(""), /已截断|\ufffd/);
	assert.throws(() => sessionMarkdownParts({ ...source, provider: "x".repeat(MAX_NOTIFICATION_BYTES) }, "body"));
});

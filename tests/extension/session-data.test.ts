import assert from "node:assert/strict";
import { test } from "node:test";
import { captureSessionSource, pageActivity } from "../../src/extension/session-data.ts";
import { sessionMarkdown } from "../../src/shared/notification.ts";

const modelA = { id: "model-a", name: "Model A", provider: "test-provider" };
const context = (cwd: string) => ({
	cwd,
	model: { ...modelA },
	sessionManager: { getSessionId: () => "pi-session-1" },
	modelRegistry: {
		find: (provider: string, id: string) => (provider === modelA.provider && id === modelA.id ? modelA : undefined),
	},
});

test("text outside a card names the complete session, then directory, provider and model, above the body", () => {
	const result = sessionMarkdown(
		captureSessionSource(context("D:\\code\\pi-wecom-aibot\\")),
		"修改完成。\n\n验证通过。",
	);
	assert.equal(
		result,
		[
			"🆔 session: pi-session-1  ",
			"🏷️ pi-wecom-aibot · test-provider · Model A",
			"",
			"修改完成。",
			"",
			"验证通过。",
		].join("\n"),
	);
});

test("directory metadata handles Windows, POSIX, UNC, trailing separators and roots without exposing parents", () => {
	for (const [cwd, directoryName] of [
		["D:\\private\\project", "project"],
		["D:/private/project///", "project"],
		["/home/private/project/", "project"],
		["\\\\server\\private-share\\project\\", "project"],
		["D:\\", "根目录"],
		["/", "根目录"],
		["\\\\server\\private-share\\", "根目录"],
		["", "未知目录"],
	]) {
		const captured = captureSessionSource(context(cwd));
		assert.equal(captured.directoryName, directoryName, cwd);
		assert.doesNotMatch(sessionMarkdown(captured, "result"), /private|server|D:/);
	}
});

test("excerpts identify the original provider and model even when providers share a model ID", () => {
	const ctx = context("D:/code/project");
	ctx.model = { ...modelA, name: "Other Provider's Model A", provider: "another-provider" };
	const original = captureSessionSource(ctx, { model: "model-a", provider: "test-provider" });
	assert.equal(original.modelName, "Model A");
	assert.equal(original.provider, "test-provider");
	const uncatalogued = captureSessionSource(ctx, { model: "uncatalogued-model", provider: "original-provider" });
	assert.equal(uncatalogued.modelName, "uncatalogued-model");
	assert.equal(uncatalogued.provider, "original-provider");
	const current = captureSessionSource(ctx);
	assert.equal(current.modelName, "Other Provider's Model A");
	assert.equal(current.provider, "another-provider");
	const uncataloguedModel = captureSessionSource(ctx, { model: "model-a" });
	assert.equal(uncataloguedModel.provider, "未知供应商");
	assert.equal(uncataloguedModel.modelName, "model-a");
});

test("source snapshots survive later context changes and missing models have an explicit label", () => {
	const ctx = context("D:/code/project");
	const captured = captureSessionSource(ctx);
	ctx.cwd = "D:/code/another-project";
	ctx.model.name = "Model B";
	ctx.model.provider = "another-provider";
	assert.equal(captured.provider, "test-provider");
	assert.equal(captured.modelName, "Model A");
	assert.equal(captured.directoryName, "project");
	assert.equal(captureSessionSource({ ...ctx, model: undefined }).modelName, "未选择模型");
	assert.equal(captureSessionSource({ ...ctx, model: undefined }).provider, "未选择供应商");
});

test("a page shows the last three rounds, newest first, and the wecom_send notices with content that did not fail", () => {
	let clock = Date.UTC(2026, 9, 24, 1, 0);
	const entry = (message: Record<string, unknown>) => {
		clock += 60_000;
		return { type: "message", id: `e${clock}`, parentId: null, timestamp: new Date(clock).toISOString(), message };
	};
	const user = (text: string) => entry({ role: "user", content: [{ type: "text", text }], timestamp: clock });
	const reply = (text: string, calls: Record<string, unknown>[] = []) =>
		entry({ role: "assistant", content: [{ type: "text", text }, ...calls], stopReason: "stop" });
	const send = (id: string, content?: string) => ({
		type: "toolCall",
		id,
		name: "wecom_send",
		arguments: content === undefined ? {} : { content },
	});
	const result = (id: string, isError: boolean) =>
		entry({ role: "toolResult", toolCallId: id, toolName: "wecom_send", content: [], isError, timestamp: clock });
	const entries = [
		user("第一轮"),
		reply("ONE"),
		user("第二轮"),
		reply("TWO-DRAFT", [send("n1", "NOTICE-ONE")]),
		result("n1", false),
		reply("TWO"),
		user("第三轮"),
		reply("", [send("n2", "NOTICE-FAILED")]),
		result("n2", true),
		{ type: "custom", id: "c", parentId: null, timestamp: new Date(clock).toISOString(), customType: "x", data: {} },
		user("第四轮"),
		reply("FOUR", [send("n3"), send("n4", "NOTICE-PENDING")]),
	] as any[];
	const { rounds, notices } = pageActivity(entries);
	assert.deepEqual(
		rounds.map((round) => [round.prompt, round.reply]),
		[
			["第四轮", "FOUR"],
			["第三轮", "（本轮没有新的文本输出）"],
			["第二轮", "TWO"],
		],
		"each round's last reply; three rounds",
	);
	assert.equal(rounds[0].at.toISOString(), entries[10].timestamp);
	assert.deepEqual(
		notices.map((notice) => notice.content),
		["NOTICE-PENDING", "NOTICE-ONE"],
		"a notice still being sent counts; a failed one and one without content do not",
	);
	assert.deepEqual(pageActivity([]), { rounds: [], notices: [] });
});

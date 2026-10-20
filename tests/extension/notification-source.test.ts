import assert from "node:assert/strict";
import { test } from "node:test";
import { captureNotificationSource } from "../../src/extension/notification-source.ts";
import { formatNotification } from "../../src/shared/notification.ts";

const modelA = { id: "model-a", name: "Model A", provider: "test-provider" };
const context = (cwd: string) => ({
	cwd,
	model: { ...modelA },
	sessionManager: { getSessionId: () => "pi-session-1" },
	modelRegistry: {
		find: (provider: string, id: string) => (provider === modelA.provider && id === modelA.id ? modelA : undefined),
	},
});

test("notifications show complete session, provider, model and last directory above the body", () => {
	const result = formatNotification(
		captureNotificationSource(context("D:\\code\\pi-wecom-aibot\\")),
		"修改完成。\n\n验证通过。",
	);
	assert.equal(
		result,
		[
			"🔔 pi-wecom-aibot · 会话通知  ",
			"🏷️ test-provider · Model A  ",
			"🆔 session: pi-session-1",
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
		const captured = captureNotificationSource(context(cwd));
		assert.equal(captured.directoryName, directoryName, cwd);
		assert.doesNotMatch(formatNotification(captured, "result"), /private|server|D:/);
	}
});

test("excerpts identify the original provider and model even when providers share a model ID", () => {
	const ctx = context("D:/code/project");
	ctx.model = { ...modelA, name: "Other Provider's Model A", provider: "another-provider" };
	const original = captureNotificationSource(ctx, { model: "model-a", provider: "test-provider" });
	assert.equal(original.modelName, "Model A");
	assert.equal(original.provider, "test-provider");
	const uncatalogued = captureNotificationSource(ctx, { model: "uncatalogued-model", provider: "original-provider" });
	assert.equal(uncatalogued.modelName, "uncatalogued-model");
	assert.equal(uncatalogued.provider, "original-provider");
	const current = captureNotificationSource(ctx);
	assert.equal(current.modelName, "Other Provider's Model A");
	assert.equal(current.provider, "another-provider");
	const uncataloguedModel = captureNotificationSource(ctx, { model: "model-a" });
	assert.equal(uncataloguedModel.provider, "未知供应商");
	assert.equal(uncataloguedModel.modelName, "model-a");
});

test("source snapshots survive later context changes and missing models have an explicit label", () => {
	const ctx = context("D:/code/project");
	const captured = captureNotificationSource(ctx);
	ctx.cwd = "D:/code/another-project";
	ctx.model.name = "Model B";
	ctx.model.provider = "another-provider";
	assert.equal(captured.provider, "test-provider");
	assert.equal(captured.modelName, "Model A");
	assert.equal(captured.directoryName, "project");
	assert.equal(captureNotificationSource({ ...ctx, model: undefined }).modelName, "未选择模型");
	assert.equal(captureNotificationSource({ ...ctx, model: undefined }).provider, "未选择供应商");
});

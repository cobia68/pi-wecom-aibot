import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContentDisplay } from "../../src/extension/config.ts";
import { DocError } from "../../src/extension/doc-mcp.ts";
import { SessionPage } from "../../src/extension/session-page.ts";
import { notificationPayload } from "../../src/shared/notification.ts";

const source = { sessionId: "session", directoryName: "project", provider: "provider", modelName: "model" };
const url = "https://doc.weixin.qq.com/page";
const chat = { chatId: "user", chatType: 1 as const };

function setup() {
	const state = {
		display: "linked" as ContentDisplay,
		configured: true,
		live: true,
		readable: true,
		branchFailure: false,
		error: undefined as unknown,
		wait: undefined as Promise<void> | undefined,
	};
	const writes: string[] = [];
	const logs: string[] = [];
	let docReads = 0;
	const doc = {
		pageUrl: () => (state.readable ? url : undefined),
		iconUrl: () => undefined,
		async write(_source: typeof source, markdown: string) {
			writes.push(markdown);
			const error = state.error;
			await state.wait;
			if (error) throw error;
			return { url, created: false };
		},
	};
	const ctx = {
		cwd: "/project",
		model: { id: "model", provider: "provider" },
		sessionManager: {
			getSessionId: () => source.sessionId,
			getBranch: () => {
				if (state.branchFailure) throw new Error("bad branch private-key");
				return [];
			},
		},
	} as unknown as ExtensionContext;
	const page = new SessionPage({
		sessionId: source.sessionId,
		live: () => state.live,
		context: () => ctx,
		contentDisplay: () => state.display,
		doc: () => {
			docReads++;
			return state.configured ? doc : undefined;
		},
		running: () => false,
		maskText: (text) => text.replaceAll("private-key", "****"),
		log: (line) => logs.push(line),
	});
	const publish = (text = "REPLY-BODY") => page.publish(ctx, chat, notificationPayload("notice", source, text));
	return { page, state, writes, logs, publish, docReads: () => docReads };
}

test("inline never reads the document or reports a document failure; missing linked configuration has an actionable quote", async () => {
	const h = setup();
	h.state.display = "inline";
	assert.equal(h.page.view(), undefined);
	assert.equal(h.page.problem, false);
	assert.equal(await h.publish(), undefined);
	await h.page.refresh("user");
	h.page.writeAuto();
	assert.equal(h.docReads(), 0);
	h.state.display = "linked";
	h.state.configured = false;
	const view = await h.publish();
	assert.match(view!.pageProblem!, /未配置\n.*\/wecom-aibot config edit\n.*docMcpUrl/);
	assert.equal(view!.pageUrl, undefined);
	assert.equal(h.page.problem, true);
	assert.match(await h.page.refresh("user"), /未配置 docMcpUrl/);
	assert.doesNotMatch(view!.pageProblem!, /REPLY-BODY|授权|到期/);
	assert.deepEqual(h.writes, []);
});

test("a recorded URL alone is not trusted; only the current successful write supplies a document link", async () => {
	const h = setup();
	assert.equal(h.page.view()!.pageUrl, undefined);
	assert.deepEqual(await h.publish(), { pageUrl: url });
	assert.deepEqual(h.page.view(), { pageUrl: url });
	assert.equal(h.page.problem, false);
	assert.match(h.writes[0], /REPLY-BODY/);
	h.state.readable = false;
	assert.equal(h.page.view()!.pageUrl, undefined);
	assert.match(h.page.view()!.pageProblem!, /不可用/);
});

for (const error of [
	new DocError("HTTP unauthorized private-key", "http", 401),
	new DocError("HTTP forbidden private-key", "http", 403),
	new DocError("partial no authorization private-key", "tool", 851008),
	new DocError("apikey expired private-key", "rpc"),
	new DocError("invalid apikey private-key", "tool"),
	new DocError("文档权限不足 private-key", "tool"),
])
	test(`an authorization failure (${error.kind}/${error.errcode ?? error.message}) asks for renewal in the quote and refresh restores the link`, async () => {
		const h = setup();
		await h.publish();
		h.state.error = error;
		const failed = await h.publish("BODY-MUST-STAY-IN-DOCUMENT");
		assert.equal(failed!.pageUrl, undefined);
		assert.match(failed!.pageProblem!, /权限不足或授权已到期/);
		assert.match(failed!.pageProblem!, /工作台 → 智能机器人 → 可使用权限/);
		assert.match(failed!.pageProblem!, /重新授权后点「刷新卡片」/);
		assert.doesNotMatch(JSON.stringify(failed), /BODY-MUST-STAY|private-key/);
		assert.equal(h.page.problem, true);
		h.state.error = undefined;
		assert.match(await h.page.refresh("user"), /^已刷新/);
		assert.deepEqual(h.page.view(), { pageUrl: url });
		assert.equal(h.page.problem, false);
		assert.match(failed!.pageProblem!, /授权已到期/, "an already-published snapshot never mutates itself");
		assert.doesNotMatch(h.logs.join("\n"), /private-key/);
	});

for (const [error, expected] of [
	[new DocError("connection refused private-key", "network"), /连接失败/],
	[new DocError("operation permission denied private-key", "network"), /连接失败/],
	[new DocError("文档服务连接失败：超时", "network"), /写入超时/],
	[new DocError("session expired", "http", 404), /不可用/],
	[new DocError("server unavailable", "http", 500), /不可用/],
	[new DocError("other tool failure", "tool", 850003), /不可用/],
	[new DocError("读取权限配置超时", "tool"), /不可用/],
	[new DocError("MCP session token expired", "rpc"), /不可用/],
] as const)
	test(`non-authorization failures (${error.kind}/${error.errcode ?? error.message}) do not claim that document permission expired`, async () => {
		const h = setup();
		h.state.error = error;
		const view = await h.publish();
		assert.equal(view!.pageUrl, undefined);
		assert.match(view!.pageProblem!, expected);
		assert.doesNotMatch(view!.pageProblem!, /REPLY-BODY|private-key|权限|授权|到期/);
	});

test("preparation failure invalidates a previously successful view, remains redacted, and can recover", async () => {
	const h = setup();
	await h.publish();
	h.state.branchFailure = true;
	const failed = await h.publish("NOT-IN-THE-PAGE");
	assert.equal(failed!.pageUrl, undefined);
	assert.equal(h.page.view()!.pageUrl, undefined);
	assert.match(h.page.view()!.pageProblem!, /不可用/);
	assert.doesNotMatch(h.logs.join("\n"), /private-key/);
	h.state.branchFailure = false;
	await h.page.refresh("user");
	assert.deepEqual(h.page.view(), { pageUrl: url });
});

test("a timed-out publication keeps a failure snapshot; late success or a refresh can repair only a future redraw", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = setup();
	let release!: () => void;
	h.state.wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = h.publish("TIMEOUT-BODY");
	await Promise.resolve();
	t.mock.timers.tick(6000);
	const failed = await pending;
	assert.equal(failed!.pageUrl, undefined);
	assert.match(failed!.pageProblem!, /写入超时/);
	assert.doesNotMatch(failed!.pageProblem!, /TIMEOUT-BODY|授权|到期/);
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(h.page.view(), { pageUrl: url });
	assert.match(failed!.pageProblem!, /写入超时/);
});

test("changing document configuration during publication cannot attach the old link", async () => {
	const h = setup();
	let release!: () => void;
	h.state.wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = h.publish();
	await Promise.resolve();
	h.state.configured = false;
	release();
	const failed = await pending;
	assert.equal(failed!.pageUrl, undefined);
	assert.match(failed!.pageProblem!, /配置已改变/);
	assert.match(h.page.view()!.pageProblem!, /未配置/);
});

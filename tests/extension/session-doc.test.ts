import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DocError, type DocMcpClient } from "../../src/extension/doc-mcp.ts";
import { PAGE_RETENTION_MS, pageMarkdown, SessionDoc } from "../../src/extension/session-doc.ts";

const root = await mkdtemp(join(tmpdir(), "pi-wecom-aibot-pages-test-"));
after(() => rm(root, { recursive: true, force: true }));
let sequence = 0;

const source = (sessionId: string) => ({
	sessionId,
	directoryName: "project",
	provider: "provider",
	modelName: "model",
});

/** The document MCP as a list of calls; `slow` makes calls take a moment, so two pi can overlap. */
function fakeService(options: { slow?: boolean; overwriteFails?: number[]; iconFails?: boolean } = {}) {
	const calls: { name: string; args: any }[] = [];
	let pages = 0;
	let documents = 0;
	const failures = [...(options.overwriteFails ?? [])];
	const mcp = {
		async call(name: string, args: any) {
			calls.push({ name, args });
			if (options.slow) await new Promise((resolve) => setTimeout(resolve, 20));
			const reply = (body: Record<string, unknown>) => [JSON.stringify({ errcode: 0, ...body })];
			if (name === "smartpage_create") {
				documents++;
				return reply({
					docid: `a1_doc${documents}`,
					url: `https://doc.weixin.qq.com/smartpage/a1_doc${documents}`,
				});
			}
			if (name === "smartpage_pages_update" && args.create_page) {
				pages++;
				return reply({
					page_id: `p${pages}`,
					page_url: `https://doc.weixin.qq.com/smartpage/${args.docid}?p=p${pages}`,
				});
			}
			if (name === "media_upload") return reply({ media_id: `m${calls.length}` });
			if (name === "smartpage_images_upload") {
				if (options.iconFails)
					throw new DocError("smartpage_images_upload 失败：企业微信 851008：x", "tool", 851008);
				return reply({ url: `https://wdcdn.qpic.cn/icon-${args.docid}` });
			}
			if (name === "smartpage_pages_overwrite" && failures.length) {
				const code = failures.shift()!;
				throw new DocError(`smartpage_pages_overwrite 失败：企业微信 ${code}：x`, "tool", code);
			}
			return reply({});
		},
	};
	return { calls, mcp: mcp as unknown as DocMcpClient, names: () => calls.map((call) => call.name) };
}

function pages(service: ReturnType<typeof fakeService>, directory: string, now = () => Date.now()) {
	return new SessionDoc({
		botId: "aibot-UNIQUE-BOT-ID",
		mcp: service.mcp,
		log() {},
		directory,
		machine: "host:1",
		now,
	});
}

async function sandbox(): Promise<string> {
	return mkdtemp(join(root, `case-${++sequence}-`));
}

test("one document per machine and bot, named after the machine, invite-only, one page per session", async () => {
	const directory = await sandbox();
	const service = fakeService();
	const store = pages(service, directory);
	const first = await store.write(source("s1"), "# one", "alice");
	assert.deepEqual(first, { url: "https://doc.weixin.qq.com/smartpage/a1_doc1?p=p1", created: true });
	assert.equal(service.calls[0].args.name, "pi 会话文档（host_1）", "a document name may not contain a colon");
	assert.deepEqual(service.calls.find((call) => call.name === "doc_rules_update")!.args, {
		docid: "a1_doc1",
		enable_member_join_admin_check: false,
		corp_internal_join_auth: "apply",
		corp_external_join_auth: "deny",
	});
	assert.equal(service.calls.find((call) => call.args.create_page)!.args.create_page.page_name, "project · s1");
	assert.equal(store.pageUrl("s1"), first.url);
	// The new document carries pi's logo as a PNG; the cards' icon is that copy.
	const logo = service.calls.find((call) => call.name === "media_upload" && call.args.type === "image")!;
	assert.equal(logo.args.file_name, "pi-logo.png");
	assert.deepEqual(
		[...Buffer.from(logo.args.base64_content, "base64").subarray(0, 8)],
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	);
	assert.equal(service.calls.find((call) => call.name === "smartpage_images_upload")!.args.docid, "a1_doc1");
	assert.equal(store.iconUrl(), "https://wdcdn.qpic.cn/icon-a1_doc1");
	service.calls.length = 0;
	assert.equal((await store.write(source("s1"), "# again", "alice")).created, false);
	assert.deepEqual(
		service.names(),
		["media_upload", "smartpage_pages_overwrite"],
		"a granted member is not granted again, an uploaded icon not uploaded again",
	);
	await store.write(source("s2"), "# two", "bob");
	assert.equal(service.calls.filter((call) => call.name === "smartpage_create").length, 0, "one document per bot");
	assert.equal(store.pageUrl("s2"), "https://doc.weixin.qq.com/smartpage/a1_doc1?p=p2");
	const record = JSON.parse(await readFile(join(directory, "session-doc.json"), "utf8"));
	const [entry] = Object.values(record) as any[];
	assert.deepEqual(entry.viewers, ["alice", "bob"]);
	assert.equal(JSON.stringify(record).includes("UNIQUE-BOT-ID"), false, "the BotID itself is not written");
});

test("a broken record leaves a card without its page link and icon, and says why in the log", async () => {
	const directory = await sandbox();
	await pages(fakeService(), directory).write(source("s1"), "# one");
	await writeFile(join(directory, "session-doc.json"), "{not json");
	const lines: string[] = [];
	const store = new SessionDoc({
		botId: "aibot-UNIQUE-BOT-ID",
		mcp: fakeService().mcp,
		log: (line) => lines.push(line),
		directory,
		machine: "host:1",
	});
	assert.equal(store.pageUrl("s1"), undefined);
	assert.equal(store.iconUrl(), undefined);
	assert.equal(lines.length, 2, "the link and the icon each say so");
	for (const line of lines) assert.match(line, /会话文档记录 .* 已损坏/);
});

test("a broken record fails the write: no new document, and the file is left for the user to fix", async () => {
	const directory = await sandbox();
	const service = fakeService();
	const file = join(directory, "session-doc.json");
	await pages(service, directory).write(source("s0"), "# zero");
	const [bot] = Object.keys(JSON.parse(await readFile(file, "utf8")));
	for (const broken of ["{not json", JSON.stringify({ [bot]: { version: 1 }, other: { kept: true } })]) {
		await writeFile(file, broken);
		await assert.rejects(pages(service, directory).write(source("s9"), "# nine"), /会话文档记录/);
		assert.equal(await readFile(file, "utf8"), broken, "nothing is written over");
	}
	assert.equal(
		service.names().filter((name) => name === "smartpage_create").length,
		1,
		"only the first write made one",
	);
});

test("two pi refreshing for the first time at once still create one document and one page per session", async () => {
	const directory = await sandbox();
	const service = fakeService({ slow: true });
	const [a, b] = [pages(service, directory), pages(service, directory)];
	const written = await Promise.all([
		a.write(source("s1"), "a"),
		b.write(source("s1"), "b"),
		b.write(source("s2"), "c"),
	]);
	assert.equal(service.calls.filter((call) => call.name === "smartpage_create").length, 1);
	assert.equal(service.calls.filter((call) => call.args?.create_page).length, 2);
	assert.equal(written[0].url, written[1].url);
});

test("a page deleted elsewhere is made again once; any other failure is reported unchanged", async () => {
	const directory = await sandbox();
	const service = fakeService();
	const store = pages(service, directory);
	const first = await store.write(source("s1"), "first");
	const service2 = fakeService({ overwriteFails: [640027] });
	const reopened = pages(service2, directory);
	const again = await reopened.write(source("s1"), "second");
	assert.equal(again.created, true);
	assert.equal(again.url, "https://doc.weixin.qq.com/smartpage/a1_doc1?p=p1", "a new page, numbered by its service");
	assert.deepEqual(service2.names(), [
		"media_upload",
		"smartpage_pages_overwrite",
		"smartpage_pages_update",
		"media_upload",
		"smartpage_pages_overwrite",
	]);
	assert.ok(first.url);
	const service3 = fakeService({ overwriteFails: [851008] });
	await assert.rejects(pages(service3, directory).write(source("s1"), "third"), { errcode: 851008 });
});

test("creating a page sweeps pages nobody refreshed for seven days; the document itself stays", async () => {
	const directory = await sandbox();
	const service = fakeService();
	let now = 1_000_000_000_000;
	const store = pages(service, directory, () => now);
	await store.write(source("old"), "old");
	await store.write(source("recent"), "recent");
	now += PAGE_RETENTION_MS + 1;
	await store.write(source("recent"), "kept fresh");
	service.calls.length = 0;
	await store.write(source("new"), "new");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(
		service.calls.filter((call) => call.args?.delete_page).map((call) => call.args.delete_page.page_id),
		["p1"],
	);
	assert.equal(store.pageUrl("old"), undefined);
	assert.ok(store.pageUrl("recent"));
});

test("reset deletes every recorded page, forgets them, and keeps the document for later", async () => {
	const directory = await sandbox();
	const service = fakeService();
	const store = pages(service, directory);
	await store.write(source("s1"), "a");
	await store.write(source("s2"), "b");
	service.calls.length = 0;
	assert.equal(await store.reset(), 2);
	assert.deepEqual(service.names(), ["smartpage_pages_update", "smartpage_pages_update"]);
	assert.equal(store.pageUrl("s1"), undefined);
	service.calls.length = 0;
	await store.write(source("s1"), "again");
	assert.equal(service.calls.filter((call) => call.name === "smartpage_create").length, 0);
});

test("a page is its session and model, the last rounds newest first, then the notices: text, no code block of its own", () => {
	const at = new Date(2026, 9, 24, 13, 57, 9);
	const markdown = pageMarkdown(source("s1"), {
		state: "执行中",
		at,
		rounds: [
			{
				at: new Date(2026, 9, 24, 13, 50),
				prompt: "**修**一下构建\n细节",
				reply: "# 结论\n\n已修好\n\n```sh\nnpm test",
			},
			{ at: new Date(2026, 9, 24, 9, 5), prompt: "", reply: "（本轮没有新的文本输出）" },
		],
		notices: [{ at: new Date(2026, 9, 24, 13, 51), content: "部署成功\n\n日志" }],
	});
	assert.equal(
		markdown,
		[
			"# project · s1",
			"",
			"model · provider · 执行中 · 2026-10-24 13:57:09 更新",
			"",
			"## 最近回复",
			"",
			"### 10-24 13:50 修一下构建",
			"",
			// The reply's own heading goes below the round's; the code block it leaves open is closed.
			"#### 结论\n\n已修好\n\n```sh\nnpm test\n```",
			"",
			"### 10-24 09:05 （没有文字）",
			"",
			"（本轮没有新的文本输出）",
			"",
			"## 最近通知",
			"",
			"### 10-24 13:51 部署成功",
			"",
			"部署成功\n\n日志",
			"",
		].join("\n"),
	);
	const bare = pageMarkdown(source("s1"), { state: "空闲", at, rounds: [], notices: [] });
	assert.match(bare, /## 最近回复\n\n（还没有对话）\n/);
	assert.doesNotMatch(bare, /最近通知/, "no notices, no section");
	// A very long reply is cut, so three of them fit one page.
	const long = pageMarkdown(source("s1"), {
		state: "空闲",
		at,
		rounds: [{ at, prompt: "p", reply: "长".repeat(9000) }],
		notices: [],
	});
	assert.match(long, /长{8000}\n\n…（内容过长已截断）/);
});

test("ensure makes the session's page, with the icon, before anything is written to it", async () => {
	const directory = await sandbox();
	const service = fakeService();
	const store = pages(service, directory);
	const url = await store.ensure(source("s1"), "alice");
	assert.equal(store.pageUrl("s1"), url);
	assert.ok(service.names().includes("smartpage_images_upload"), "the card icon comes with the page");
	assert.ok(service.names().includes("doc_members_update"), "a single chat's user may read it at once");
	assert.equal(service.names().filter((name) => name === "smartpage_pages_overwrite").length, 0);
	service.calls.length = 0;
	assert.equal(await store.ensure(source("s1")), url, "an existing page is only looked up");
	assert.deepEqual(service.names(), []);
});

test("a document without an icon gets one with its next write; a failed upload leaves the write and the record alone", async () => {
	const directory = await sandbox();
	const failing = fakeService({ iconFails: true });
	const logs: string[] = [];
	const first = new SessionDoc({
		botId: "aibot-UNIQUE-BOT-ID",
		mcp: failing.mcp,
		log: (line) => logs.push(line),
		directory,
		machine: "host:1",
	});
	const written = await first.write(source("s1"), "a");
	assert.ok(written.url, "the page is written although the icon was refused");
	assert.equal(first.iconUrl(), undefined);
	assert.match(logs.join("\n"), /卡片图标未上传.*851008/);
	failing.calls.length = 0;
	await first.write(source("s1"), "b");
	assert.equal(
		failing.calls.filter((call) => call.name === "smartpage_images_upload").length,
		0,
		"one attempt per pi run",
	);
	// The next pi run (a new instance) tries again, and records the icon for every pi.
	const working = fakeService();
	await pages(working, directory).write(source("s1"), "c");
	assert.equal(working.calls.filter((call) => call.name === "smartpage_create").length, 0, "the same document");
	assert.equal(pages(working, directory).iconUrl(), "https://wdcdn.qpic.cn/icon-a1_doc1");
});

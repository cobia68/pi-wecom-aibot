import assert from "node:assert/strict";
import { test } from "node:test";
import { promptOptions, quoteTail, sessionControlCard } from "../../src/extension/control-view.ts";
import { modelOptions, modelPage } from "../../src/extension/model-options.ts";
import { renderCard } from "../../src/shared/card.ts";
import { parseControlKey, sessionFingerprint } from "../../src/shared/control-card.ts";

const source = { sessionId: "session-A", directoryName: "project", provider: "provider", modelName: "model" };
const PRINT = sessionFingerprint(source.sessionId);

/** Each button as [action, text, style]; every key names the session the card shows. */
function buttons(card: ReturnType<typeof sessionControlCard>): [string, string, number | undefined][] {
	return card.actions.map((action) => {
		const parsed = parseControlKey(action.key);
		assert.equal(parsed?.fingerprint, PRINT, action.key);
		return [parsed!.action, action.text, action.style];
	});
}

test("the source line counts waiting tasks while live; a finished run's copy says only how it ended", () => {
	assert.equal(sessionControlCard(source, { status: "running", queued: 2 }).label, "执行中 · 排队 2");
	assert.equal(sessionControlCard(source, { status: "idle", queued: 0 }).label, "空闲");
	assert.equal(sessionControlCard(source, { status: "done", queued: 3 }).label, "已完成");
});

test("确认中止 with tasks queued offers this run, everything or the queue alone, two by two", () => {
	assert.deepEqual(
		buttons(sessionControlCard(source, { status: "confirming", queued: 2 })).map(([action, text]) => [action, text]),
		[
			["abort-confirm", "确认中止"],
			["abort-all", "全部中止"],
			["abort-queue", "清空排队"],
			["abort-cancel", "取消中止"],
		],
	);
	assert.deepEqual(
		buttons(sessionControlCard(source, { status: "confirming" })).map(([action]) => action),
		["abort-confirm", "abort-cancel"],
	);
});

test("a reply's next-step comment never shows in the card's quote", () => {
	assert.deepEqual(quoteTail(["一", "二", "结论", '<!-- wecom_next ["运行测试"] -->']), ["一", "二", "结论"]);
});

test("before any refresh the card names the session; its four buttons are always there, in two rows", () => {
	const card = sessionControlCard(source, { status: "idle" });
	assert.equal(card.label, "空闲");
	assert.equal(card.tone, "neutral");
	assert.equal(card.title, "📁 project");
	assert.equal(card.desc, "🤖 model · provider", "the model first, its provider after");
	const long = sessionControlCard(
		{ ...source, modelName: "deepseek-v4-flash", provider: "welfare-agentrouter-github-mirror" },
		{ status: "idle" },
	);
	const title = renderCard(long, "t").main_title as { desc: string };
	assert.equal(title.desc, "🤖 deepseek-v4-flash · welfare-agentrout…", "a cut at 40 takes the provider's end");
	assert.equal(card.quote, "点「刷新卡片」读取画面");
	assert.equal(card.quoteUrl, undefined);
	assert.equal(card.subtitle, "🆔 session-id: session-A", "the whole ID, spelled like pi --session-id");
	assert.deepEqual(card.facts, []);
	assert.deepEqual(
		card.selection,
		{ key: "session", title: "会话", options: [{ id: PRINT, text: "project · on-A" }], selected: PRINT },
		"the session dropdown, its own session alone: the gateway adds the others online",
	);
	// Four, so WeCom draws two rows (three in one are cut to 刷新…); 中止任务 last, away from 刷新卡片.
	assert.deepEqual(buttons(card), [
		["refresh", "刷新卡片", 1],
		["send", "发提示词", 2],
		["model", "切换模型", 2],
		["abort", "中止任务", 3],
	]);
	const prompted = sessionControlCard(source, { status: "idle", prompts: ["继续"] });
	assert.equal(prompted.selection?.key, "session", "prompts wait for 发提示词: a card has one dropdown");
	assert.deepEqual(buttons(prompted), buttons(card), "without prompts too: 发提示词 then says how to add some");
	assert.equal(
		sessionControlCard({ ...source, modelName: "new-model" }, { status: "idle" }).desc,
		"🤖 new-model · provider",
	);
});

test("after a refresh the quote is the last three lines with words, without a time, linked to the session page", () => {
	const at = new Date(2026, 0, 1, 13, 57, 9);
	const pageUrl = "https://doc.weixin.qq.com/smartpage/a1_doc?p=page";
	const card = sessionControlCard(source, {
		status: "running",
		screen: {
			at,
			lines: ["$ npm run check", "✔ 483 passed", "", " ─ ─ ─ ─", "检查全部通过，改动未提交", "────────"],
		},
		pageUrl,
	});
	assert.equal(card.label, "执行中");
	assert.equal(card.tone, "success");
	assert.equal(card.quote, "$ npm run check\n✔ 483 passed\n检查全部通过，改动未提交", "窗口记录 says when");
	const blank = sessionControlCard(source, { status: "idle", screen: { at, lines: ["", " ─ ─ "] } });
	assert.equal(blank.quote, "（终端画面为空）");
	assert.equal(card.quoteUrl, pageUrl);
	assert.deepEqual(card.facts, [], "no link row: the quote opens the page");
	assert.equal(card.noteKey, "窗口记录", "a click's result goes to 窗口记录");
	// A page from an earlier pi run: no lines yet, but the quote still links.
	const reopened = sessionControlCard(source, { status: "idle", pageUrl });
	assert.equal(reopened.quote, "没有终端画面；点这里看最近回复", "no terminal: the page has the replies");
	assert.equal(reopened.quoteUrl, pageUrl);
});

test("the quote keeps two whole terminal lines, however wide, and the card does not cut them", () => {
	const wide = "第一二三四五六七八九十".repeat(10);
	const latin = "x".repeat(240);
	assert.deepEqual(quoteTail([wide, "", latin]), [wide, latin], "no cut to a phone's width");
	assert.deepEqual(quoteTail(["", " ─ ─ ", "  "]), []);
	const card = sessionControlCard(source, {
		status: "idle",
		screen: { at: new Date(2026, 9, 24, 13, 57), lines: [wide, latin] },
	});
	const rendered = renderCard(card, "t").quote_area as { quote_text: string };
	assert.equal(rendered.quote_text, `${wide}\n${latin}`, "beyond the 200 characters of a result card's excerpt");
});

test("confirming an abort leaves only 确认中止 and 取消; a broken document says how to recover", () => {
	const confirming = sessionControlCard(source, { status: "confirming" });
	assert.equal(confirming.label, "等待确认中止");
	assert.equal(confirming.tone, "danger");
	assert.equal(confirming.selection, undefined, "no dropdown may point at another session while it is asked");
	assert.deepEqual(buttons(confirming), [
		["abort-confirm", "确认中止", 3],
		["abort-cancel", "取消中止", 2],
	]);
	const broken = sessionControlCard(source, { status: "doc-problem" });
	assert.equal(broken.label, "文档不可用");
	assert.equal(broken.tone, "danger");
	assert.match(broken.subtitle!, /^🆔 session-id: session-A；.*工作台 → 智能机器人 → 可使用权限/);
	assert.ok([...broken.subtitle!].length <= 112);
});

test("a prompt's option shows ten characters, sends all of it, and keeps its ID wherever it moves in the list", () => {
	const long = "运行 npm run check，失败就修复后再跑一遍";
	const [first, second] = promptOptions(["继续", long]);
	assert.match(first.id, /^p-[0-9a-f]{16}$/);
	assert.equal(second.text, "运行 npm ru…", "the dropdown shows ten characters, the last one an ellipsis");
	assert.equal(second.prompt, long, "发送 sends the whole prompt");
	assert.notEqual(first.id, second.id);
	const [moved] = promptOptions([long, "继续"]);
	assert.equal(moved.id, second.id, "the ID is the prompt's, not its position");
	assert.notEqual(promptOptions([`${long}！`])[0].id, second.id, "an edited prompt is another option");
	const card = sessionControlCard(source, { status: "idle", prompts: ["继续", long], choosing: "prompt" });
	assert.equal(card.selection?.key, "prompt");
	assert.equal(card.selection?.title, "提示词");
	assert.deepEqual(
		card.selection?.options.map((option) => [option.id, option.text]),
		[
			[first.id, "继续"],
			[second.id, "运行 npm ru…"],
		],
	);
});

test("发提示词 turns the card into the prompts with 确认发送 and 取消发送; without prompts the card stays as it is", () => {
	const choosing = sessionControlCard(source, { status: "running", prompts: ["继续"], choosing: "prompt" });
	assert.equal(choosing.label, "执行中", "the live state stays: the prompt waits in the queue if pi is busy");
	assert.deepEqual(buttons(choosing), [
		["send-confirm", "确认发送", 1],
		["send-cancel", "取消发送", 2],
	]);
	const empty = sessionControlCard(source, { status: "idle", choosing: "prompt" });
	assert.equal(empty.selection?.key, "session");
	assert.deepEqual(
		buttons(empty).map(([action]) => action),
		["refresh", "send", "model", "abort"],
	);
	const confirming = sessionControlCard(source, { status: "confirming", prompts: ["继续"], choosing: "prompt" });
	assert.deepEqual(
		buttons(confirming).map(([action]) => action),
		["abort-confirm", "abort-cancel"],
		"a pending abort comes first",
	);
});

test("every control button is four characters and says what it acts on", () => {
	const texts = (card: ReturnType<typeof sessionControlCard>) => card.actions.map((action) => action.text);
	assert.deepEqual(texts(sessionControlCard(source, { status: "idle", prompts: ["继续"] })), [
		"刷新卡片",
		"发提示词",
		"切换模型",
		"中止任务",
	]);
	assert.deepEqual(texts(sessionControlCard(source, { status: "confirming" })), ["确认中止", "取消中止"]);
	for (const status of ["idle", "running", "confirming", "doc-problem", "done", "aborted", "failed"] as const)
		for (const choosing of [undefined, "prompt", "model"] as const)
			for (const text of texts(sessionControlCard(source, { status, prompts: ["继续"], choosing, models: MODELS })))
				assert.equal([...text].length, 4, text);
});

const MODELS = [
	{ provider: "p1", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
	{ provider: "p1", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
	{ provider: "p2", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
	{ provider: "p2", id: "deepseek-v4-flash" },
];

test("no control card button is longer than four characters, in any of its modes", () => {
	const views = [
		{ status: "idle" as const },
		{ status: "confirming" as const },
		{ status: "confirming" as const, queued: 2 },
		{ status: "idle" as const, choosing: "prompt" as const, prompts: ["继续"] },
		{ status: "idle" as const, choosing: "model" as const, models: MODELS },
		{
			status: "idle" as const,
			choosing: "model" as const,
			models: Array.from({ length: 22 }, (_, index) => ({ provider: "p", id: `m-${index}` })),
		},
	];
	for (const view of views)
		for (const [, text] of buttons(sessionControlCard(source, view)))
			assert.ok([...text].length <= 4, `${JSON.stringify(view).slice(0, 60)}: ${text}`);
});

test("切换模型 turns the card into the models, the one in use first and selected, with 确认切换 and 取消切换", () => {
	const card = sessionControlCard(source, {
		status: "running",
		choosing: "model",
		models: MODELS,
		model: { provider: "p2", id: "deepseek-v4-flash" },
	});
	assert.deepEqual(buttons(card), [
		["model-confirm", "确认切换", 1],
		["model-cancel", "取消切换", 2],
	]);
	assert.equal(card.selection?.key, "model");
	assert.equal(card.selection?.title, "模型");
	assert.deepEqual(
		card.selection?.options.map((option) => option.text),
		["deepseek-v4-flash", "Claude Opus 4.1", "Claude Opus 4.5 · p1", "Claude Opus 4.5 · p2"],
		"the one in use first, then pi's order; a name two providers share names its provider",
	);
	assert.equal(card.selection?.selected, card.selection?.options[0].id);
	assert.equal(card.subtitle, "🆔 session-id: session-A", "ten or fewer: one page, no page buttons");
	assert.equal(
		sessionControlCard(source, { status: "idle", choosing: "model", models: [] }).selection?.key,
		"session",
		"nothing to choose: the card stays as it is",
	);
});

test("more than ten models are shown ten at a time, with 上一页 and 下一页 below 确认切换 and 取消切换", () => {
	const many = Array.from({ length: 22 }, (_, index) => ({ provider: "p", id: `m-${index}` }));
	const view = {
		status: "idle" as const,
		choosing: "model" as const,
		models: many,
		model: { provider: "p", id: "m-15" },
	};
	const first = sessionControlCard(source, view);
	assert.deepEqual(buttons(first), [
		["model-confirm", "确认切换", 1],
		["model-cancel", "取消切换", 2],
		["model-prev", "上一页", 2],
		["model-next", "下一页", 2],
	]);
	assert.equal(first.selection?.title, "模型 1/3");
	assert.equal(first.selection?.options.length, 10, "WeCom takes ten");
	assert.equal(first.selection?.options[0].text, "m-15", "the one in use first, and selected");
	assert.equal(first.selection?.selected, first.selection?.options[0].id);
	assert.match(first.subtitle!, /；共 22 个模型，分 3 页，用「上一页」「下一页」翻$/);
	const last = sessionControlCard(source, { ...view, modelPage: 2 });
	assert.equal(last.selection?.title, "模型 3/3");
	assert.deepEqual(
		last.selection?.options.map((option) => option.text),
		["m-20", "m-21"],
	);
	assert.equal(last.selection?.selected, undefined, "WeCom then shows the page's first selected");
	assert.equal(sessionControlCard(source, { ...view, modelPage: 9 }).selection?.title, "模型 3/3", "clamped");
	// Every page of the list holds every model once.
	const all = modelOptions(many, view.model);
	const paged = [0, 1, 2].flatMap((page) => modelPage(all, page).options.map((option) => option.id));
	assert.deepEqual(
		paged,
		all.options.map((option) => option.id),
	);
	assert.equal(new Set(paged).size, 22);
});

test("one model through several relays lists together, each naming its relay without what all of them share", () => {
	const relays = ["welfare-agentrouter", "welfare-agentrouter-fbw", "welfare-agentrouter-github", "welfare-anyrouter"];
	const models = [
		{ provider: "deepseek", id: "deepseek-flash" },
		...relays.map((provider) => ({ provider, id: "gpt-6-astra" })),
		{ provider: "welfare-k40", id: "claude-opus-5-5" },
		{ provider: "welfare-100xlabs", id: "claude-opus-5-5" },
		...relays.map((provider) => ({ provider, id: "deepseek-v4-flash" })),
	];
	const { options, selected } = modelOptions(models, { provider: "welfare-anyrouter", id: "deepseek-v4-flash" });
	assert.deepEqual(
		options.map((option) => option.text),
		[
			// The one in use first, then the others with its name; then each name in pi's order, with its relays.
			"deepseek-v4-flash · anyrouter",
			"deepseek-v4-flash · agentrouter",
			// Past 32 characters the name gives way first, down to 12, then the relay.
			"deepseek-v4-f… · agentrouter-fbw",
			"deepseek-v4… · agentrouter-gith…",
			"deepseek-flash",
			"gpt-6-astra · agentrouter",
			"gpt-6-astra · agentrouter-fbw",
			"gpt-6-astra · agentrouter-github",
			"gpt-6-astra · anyrouter",
			"claude-opus-5-5 · k40",
			"claude-opus-5-5 · 100xlabs",
		],
	);
	assert.equal(selected, options[0].id);
	assert.equal(new Set(options.map((option) => option.text)).size, options.length, "no two labels alike");
	for (const option of options) assert.ok([...option.text].length <= 32, option.text);
});

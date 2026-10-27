/**
 * 模板卡片探针：用当前已配置的 BotID/Secret 单独开一条长连接，验证四类卡片能否下发、
 * 点击后能否收到 template_card_event、以及 5 秒内 aibot_respond_update_msg 能否更新卡片。
 * 另外验证：超长字段是被截断还是被拒绝（long），回复通道的 stream_with_template_card 和
 * finish 帧带 msg_item 图片是否可用（给机器人发一条消息触发），以及引用卡片回复时回调里带什么。
 *
 *   node --import tsx scripts/card-probe.ts --dry-run          只打印卡片 JSON，不连网
 *   node --import tsx scripts/card-probe.ts --force --seconds 180
 *
 * 注意：一个机器人同一时间只能有一条有效长连接。脚本订阅成功后会顶掉 pi 的网关，
 * pi 会因 disconnected_event 停止重连；测试结束请在 pi 里重新执行 /wecom-aibot connect。
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { WeComClient } from "../src/gateway/wecom-client.ts";
import { pluginDirectory } from "../src/shared/agent-path.ts";
import { asRecord } from "../src/shared/wecom-protocol.ts";

const CARD_TYPES = ["text", "button", "vote", "select", "long"] as const;
type CardKind = (typeof CARD_TYPES)[number] | "stream";

interface ProbeConfig {
	botId?: string;
	secret?: string;
	defaultChatId?: string;
	defaultChatType?: 1 | 2;
}

interface Options {
	target: string;
	chatType: 1 | 2;
	seconds: number;
	gapMs: number;
	kinds: CardKind[];
	dryRun: boolean;
	force: boolean;
	verbose: boolean;
	replyProbe: boolean;
	configPath: string;
}

interface Result {
	sent?: string;
	event?: boolean;
	eventKey?: string;
	updateMs?: number;
	updateError?: string;
}

// ---------------------------------------------------------------- probe cards

const PROBE_FONT = "pi-wecom-aibot 卡片探针";

function taskIdOf(kind: CardKind): string {
	return `probe-${kind}-${Date.now().toString(36)}`;
}

function textCard(taskId: string): Record<string, unknown> {
	return {
		card_type: "text_notice",
		source: { desc: PROBE_FONT },
		main_title: { title: "文本通知型卡片", desc: "能看到这张卡：text_notice 下发成功" },
		emphasis_content: { title: "1/4", desc: "probe" },
		sub_title_text: "点卡片其余位置不会产生事件；这张只验证展示。",
		horizontal_content_list: [
			{ keyname: "探针", value: "text_notice" },
			{ keyname: "task", value: taskId },
		],
		card_action: { type: 1, url: "https://work.weixin.qq.com/" },
	};
}

function buttonCard(taskId: string): Record<string, unknown> {
	return {
		card_type: "button_interaction",
		source: { desc: PROBE_FONT },
		main_title: { title: "按钮交互型卡片", desc: "点下面任意按钮，5 秒内卡片应变成「已点击」" },
		sub_title_text: "验证 template_card_event → aibot_respond_update_msg",
		horizontal_content_list: [{ keyname: "task", value: taskId }],
		button_selection: {
			question_key: "session",
			title: "模拟会话",
			selected_id: "s1",
			option_list: [
				{ id: "s1", text: "pi-wecom-aibot" },
				{ id: "s2", text: "api-server" },
			],
		},
		button_list: [
			{ text: "发送", key: "send", style: 1 },
			{ text: "中止", key: "abort", style: 2 },
			{ text: "刷新", key: "refresh", style: 3 },
		],
		task_id: taskId,
	};
}

function voteCard(taskId: string): Record<string, unknown> {
	return {
		card_type: "vote_interaction",
		source: { desc: PROBE_FONT },
		main_title: { title: "投票选择型卡片", desc: "选一项再点提交" },
		checkbox: {
			question_key: "usable",
			mode: 0,
			option_list: [
				{ id: "ok", text: "卡片可用" },
				{ id: "bad", text: "卡片异常" },
			],
		},
		submit_button: { text: "提交", key: "submit" },
		task_id: taskId,
	};
}

function selectCard(taskId: string): Record<string, unknown> {
	return {
		card_type: "multiple_interaction",
		source: { desc: PROBE_FONT },
		main_title: { title: "多项选择型卡片", desc: "两个下拉都选一下再提交" },
		select_list: [
			{
				question_key: "first",
				title: "第一组",
				option_list: [
					{ id: "a1", text: "选项 A" },
					{ id: "a2", text: "选项 B" },
				],
			},
			{
				question_key: "second",
				title: "第二组",
				option_list: [
					{ id: "b1", text: "选项 C" },
					{ id: "b2", text: "选项 D" },
				],
			},
		],
		submit_button: { text: "提交", key: "submit" },
		task_id: taskId,
	};
}

/** 每个字段都远超文档建议的长度：看服务端是截断、照收还是拒绝。 */
function longCard(taskId: string): Record<string, unknown> {
	return {
		card_type: "button_interaction",
		source: { desc: `${PROBE_FONT}——来源行超长测试`.repeat(2) },
		main_title: { title: `标题超长测试${"长".repeat(60)}`, desc: `说明超长${"短".repeat(60)}` },
		quote_area: { quote_text: `引用块第一行\n第二行\n${"引".repeat(600)}` },
		sub_title_text: `二级文本${"文".repeat(300)}`,
		horizontal_content_list: [{ keyname: "很长的键名测试", value: "值".repeat(80) }],
		button_list: [{ text: "按钮文字超长测试一下", key: "long-ok", style: 1 }],
		task_id: taskId,
	};
}

/** 回复通道首帧附带的卡片：点它验证 stream 结束后卡片还能不能回调、能不能更新。 */
function streamCard(taskId: string): Record<string, unknown> {
	return {
		card_type: "button_interaction",
		source: { desc: PROBE_FONT },
		main_title: { title: "stream + 卡片", desc: "首帧带卡片，随后 finish" },
		sub_title_text: "流式文字结束后点下面的按钮：卡片能变成「已收到」说明回复通道的卡片可用",
		button_list: [{ text: "测试按钮", key: "stream-card", style: 1 }],
		task_id: taskId,
	};
}

const BUILDERS: Record<CardKind, (taskId: string) => Record<string, unknown>> = {
	text: textCard,
	button: buttonCard,
	vote: voteCard,
	select: selectCard,
	long: longCard,
	stream: streamCard,
};

/** 点击后把同一张卡换成完成态；task_id 必须与回调里的一致。 */
function clickedCard(kind: CardKind, taskId: string, eventKey: string, selected: unknown): Record<string, unknown> {
	const echo = selected === undefined ? "" : `\n选择：${compact(selected)}`;
	// 更新时必须带齐该类型的必填字段（checkbox / select_list / button_list），否则 42037/42047。
	const base = BUILDERS[kind](taskId);
	return {
		...base,
		main_title: { title: `✅ 已收到 ${eventKey || "点击"}`, desc: "更新链路可用" },
		sub_title_text: `task ${taskId}${echo}`,
		...(kind === "button" || kind === "long" || kind === "stream"
			? { button_list: [{ text: "再点一次", key: "again", style: 1 }] }
			: {}),
	};
}

function compact(value: unknown): string {
	const text = JSON.stringify(value);
	return text === undefined ? "" : text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// ------------------------------------------------------------------- helpers

function parseArgs(argv: string[]): Options {
	const configPath = flag(argv, "--config") ?? join(pluginDirectory(), "config.json");
	// --dry-run 只打印卡片，不需要凭据，也不因为缺文件而失败。
	const config = has(argv, "--dry-run") && !existsSync(configPath) ? {} : readConfig(configPath);
	const only = flag(argv, "--only")
		?.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	const kinds: CardKind[] = only?.length ? only.filter(isKind) : [...CARD_TYPES];
	if (only?.length && !kinds.length) throw new Error(`--only 只接受 ${CARD_TYPES.join("/")}`);
	const chatType = Number(flag(argv, "--chat-type") ?? config.defaultChatType ?? 1);
	return {
		target: flag(argv, "--target") ?? config.defaultChatId ?? "",
		chatType: chatType === 2 ? 2 : 1,
		seconds: Number(flag(argv, "--seconds") ?? 180),
		gapMs: Number(flag(argv, "--gap") ?? 1200),
		kinds,
		dryRun: has(argv, "--dry-run"),
		force: has(argv, "--force"),
		verbose: has(argv, "--verbose"),
		replyProbe: !has(argv, "--no-reply-probe"),
		configPath,
	};
}

function isKind(value: string): value is (typeof CARD_TYPES)[number] {
	return (CARD_TYPES as readonly string[]).includes(value);
}

function has(argv: string[], name: string): boolean {
	return argv.includes(name);
}

function flag(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${name} 缺少取值`);
	return value;
}

function readConfig(path: string): ProbeConfig {
	if (!existsSync(path)) throw new Error(`找不到配置文件：${path}`);
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	const config = asRecord(parsed) ?? {};
	const chatType = config.defaultChatType === 2 ? 2 : 1;
	return {
		...(typeof config.botId === "string" ? { botId: config.botId } : {}),
		...(typeof config.secret === "string" ? { secret: config.secret } : {}),
		...(typeof config.defaultChatId === "string" ? { defaultChatId: config.defaultChatId } : {}),
		defaultChatType: chatType,
	};
}

function liveGateway(): string | undefined {
	const dir = join(pluginDirectory(), "gateway");
	if (!existsSync(dir)) return undefined;
	try {
		const socket = readdirSync(dir).find((name) => name.endsWith(".sock"));
		return socket ? join(dir, socket) : undefined;
	} catch {
		return undefined;
	}
}

/** Local time: the user compares it with the times WeCom shows. */
function stamp(): string {
	const now = new Date();
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function log(line: string): void {
	console.log(`${stamp()} ${line}`);
}

function mask(value: string): string {
	return value.length <= 10 ? "***" : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

// ---------------------------------------------------------------------- main

const options = parseArgs(process.argv.slice(2));
const config = readConfig(options.configPath);

if (options.dryRun) {
	for (const kind of options.kinds) console.log(JSON.stringify(BUILDERS[kind](taskIdOf(kind)), null, 2));
	process.exit(0);
}

if (!config.botId || !config.secret) throw new Error(`${options.configPath} 缺少 botId 或 secret`);
if (!options.target)
	throw new Error("没有推送目标：用 --target 指定，或先 /wecom-aibot config --scope global edit 设置默认推送目标");

const gateway = liveGateway();
if (gateway && !options.force) {
	console.error(
		[
			`检测到正在运行的网关：${gateway}`,
			"脚本会接管这个机器人的长连接，当前 pi 会被踢下线并停止重连。",
			"先在 pi 里 /wecom-aibot disconnect，或确认后加 --force 再运行。",
		].join("\n"),
	);
	process.exit(2);
}

log(
	`探针启动：bot ${mask(config.botId)}　目标 ${mask(options.target)}　chat_type=${options.chatType}　` +
		`卡片 ${options.kinds.join(",")}　监听 ${options.seconds}s`,
);
if (gateway) log(`已用 --force 顶掉网关 ${gateway}；结束后请回到 pi 执行 /wecom-aibot connect`);

const results = new Map<CardKind, Result>();
const byTask = new Map<string, CardKind>();
const client = new WeComClient({
	botId: config.botId,
	secret: config.secret,
	log: (line) => log(`[client] ${line}`),
	onState: (state, detail) => log(`[state] ${state}${detail ? `：${detail}` : ""}`),
	onMessage: (message) => void onMessage(message.reqId, message.body),
	onEvent: (event) => void onEvent(event.reqId, event.body),
});

let cardInbound = 0;
/** 回复通道与引用卡片的观察结果，汇总时打印。 */
const replies = { first: "—", withImage: "—", plain: "—", quotes: [] as string[] };

async function main(): Promise<void> {
	await waitSubscribed();
	// 对照组：markdown 一定可用，用来区分“链路不通”和“卡片被拒”。
	await send("markdown 基线", () =>
		client.sendMsg(options.target, options.chatType, {
			msgtype: "markdown",
			markdown: {
				content: [
					`**卡片探针开始**（${options.seconds} 秒内有效）`,
					`接下来依次下发 ${options.kinds.join(" / ")} 卡片，请按顺序：`,
					"1. 每张卡片点一个按钮或选好后提交，看卡片是否变成「✅ 已收到」",
					"2. **引用任意一张卡片**回复一句话（不能引用就直接发一句话）",
					"3. 机器人回复的「stream + 卡片」出现后，点它的「测试按钮」",
				].join("\n"),
			},
		}),
	);
	for (const kind of options.kinds) {
		const taskId = taskIdOf(kind);
		byTask.set(taskId, kind);
		results.set(kind, {});
		await delay(options.gapMs);
		await send(kind, () =>
			client.sendMsg(options.target, options.chatType, {
				msgtype: "template_card",
				template_card: BUILDERS[kind](taskId),
			}),
		);
	}
	log(
		`全部卡片已发出。请在企业微信里点按钮/提交，并在 ${options.seconds}s 内给机器人发一条消息（测试 stream+card 回复）。`,
	);
	await delay(options.seconds * 1000);
	finish();
}

async function send(label: string, action: () => Promise<unknown>): Promise<void> {
	const started = Date.now();
	try {
		await action();
		log(`${label}：ack ${Date.now() - started}ms`);
		const result = results.get(label as CardKind);
		if (result) result.sent = "ok";
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`${label}：拒绝/失败 ${message}`);
		const result = results.get(label as CardKind);
		if (result) result.sent = message;
	}
}

function onMessage(reqId: string, body: unknown): void {
	cardInbound++;
	const msgtype = asRecord(body)?.msgtype;
	log(`收到消息回调 req_id=${reqId} msgtype=${String(msgtype)}`);
	if (options.verbose) log(`body=${compact(body)}`);
	// 引用卡片回复时企业微信带来什么，决定卡片能否作为「引用定位会话」的凭据：完整记录，不截断。
	const quote = asRecord(body)?.quote;
	if (quote !== undefined) {
		const text = JSON.stringify(quote);
		replies.quotes.push(text.length > 600 ? `${text.slice(0, 600)}…` : text);
		log(`引用内容 quote=${text}`);
	}
	if (!options.replyProbe) return;
	void replyWithCard(reqId);
}

/** 101463 说“不支持流式+卡片组合”，101031 又给了 stream_with_template_card：这一条专门验它。 */
async function replyWithCard(reqId: string): Promise<void> {
	const streamId = `probe-stream-${Date.now().toString(36)}`;
	const taskId = taskIdOf("stream");
	byTask.set(taskId, "stream");
	results.set("stream", { sent: "（首帧）" });
	try {
		await client.respondMsgAck(reqId, {
			msgtype: "stream_with_template_card",
			stream: { id: streamId, finish: false, content: "**卡片探针**：已收到，正在回卡片…" },
			template_card: streamCard(taskId),
		});
		replies.first = "ack";
		results.set("stream", { sent: "ok" });
		log("stream_with_template_card 首帧：ack");
	} catch (error) {
		replies.first = error instanceof Error ? error.message : String(error);
		results.set("stream", { sent: replies.first });
		log(`stream_with_template_card 首帧被拒：${replies.first}`);
		return;
	}
	await delay(800);
	const finish = (withImage: boolean) =>
		client.respondMsgAck(reqId, {
			msgtype: "stream_with_template_card",
			stream: {
				id: streamId,
				finish: true,
				content:
					"**卡片探针完成**：这段文字下面应有一张 240×120 的**蓝底黄条图片**（msg_item）。卡片在哪里、图片在不在，都请告诉我；然后点卡片的「测试按钮」。",
				...(withImage
					? {
							msg_item: [
								{ msgtype: "image", image: { base64: PROBE_PNG.toString("base64"), md5: PROBE_PNG_MD5 } },
							],
						}
					: {}),
			},
		});
	try {
		await finish(true);
		replies.withImage = "ack";
		log("stream_with_template_card finish（带 msg_item 图片）：ack");
	} catch (error) {
		replies.withImage = error instanceof Error ? error.message : String(error);
		log(`finish 带 msg_item 被拒：${replies.withImage}；改为不带图片`);
		try {
			await finish(false);
			replies.plain = "ack";
			log("stream_with_template_card finish（无图片）：ack");
		} catch (retry) {
			replies.plain = retry instanceof Error ? retry.message : String(retry);
			log(`stream_with_template_card finish 被拒：${replies.plain}`);
		}
	}
}

/** 一张一眼能看见的 240×120 蓝底黄条 PNG：msg_item 是否真的显示，看它在不在。 */
const PROBE_PNG = solidPng(240, 120);

function solidPng(width: number, height: number): Buffer {
	const rows: Buffer[] = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 3);
		for (let x = 0; x < width; x++) {
			const stripe = y > height / 2 - 10 && y < height / 2 + 10;
			row.set(stripe ? [250, 200, 30] : [30, 90, 200], 1 + x * 3);
		}
		rows.push(row);
	}
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
const PROBE_PNG_MD5 = createHash("md5").update(PROBE_PNG).digest("hex");

function onEvent(reqId: string, body: unknown): void {
	const event = asRecord(asRecord(body)?.event);
	const type = typeof event?.eventtype === "string" ? event.eventtype : "?";
	log(`收到事件 ${type} req_id=${reqId}`);
	if (options.verbose) log(`body=${compact(body)}`);
	if (type === "disconnected_event") {
		log("长连接已被顶掉（多半是 pi 重新 connect 了）");
		finish();
		return;
	}
	if (type === "feedback_event") {
		log(`用户反馈：${compact(event?.feedback_event)}（官方只允许回空包，这里不回）`);
		return;
	}
	if (type !== "template_card_event") return;
	const card = asRecord(event?.template_card_event);
	const taskId = typeof card?.task_id === "string" ? card.task_id : "";
	const eventKey = typeof card?.event_key === "string" ? card.event_key : "";
	const kind = byTask.get(taskId);
	log(`卡片事件 card_type=${String(card?.card_type)} event_key=${eventKey} task_id=${taskId} kind=${kind ?? "?"}`);
	log(`selected_items=${compact(card?.selected_items)}`);
	if (!kind) return;
	const result = results.get(kind) ?? {};
	result.event = true;
	result.eventKey = eventKey;
	results.set(kind, result);
	void updateCard(reqId, kind, taskId, eventKey, card?.selected_items, result);
}

async function updateCard(
	reqId: string,
	kind: CardKind,
	taskId: string,
	eventKey: string,
	selected: unknown,
	result: Result,
): Promise<void> {
	const started = Date.now();
	try {
		await client.sendCommand(
			"aibot_respond_update_msg",
			{ response_type: "update_template_card", template_card: clickedCard(kind, taskId, eventKey, selected) },
			reqId,
		);
		result.updateMs = Date.now() - started;
		log(`更新卡片：ack ${result.updateMs}ms`);
	} catch (error) {
		result.updateError = error instanceof Error ? error.message : String(error);
		log(`更新卡片失败：${result.updateError}`);
	}
}

function waitSubscribed(): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("20 秒内没有订阅成功；看上面的 [client] 日志")), 20_000);
		const original = client.getState.bind(client);
		const poll = setInterval(() => {
			if (original() === "subscribed") {
				clearInterval(poll);
				clearTimeout(timer);
				resolve();
			}
		}, 200);
		client.start();
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let finished = false;

function finish(code = 0): void {
	if (finished) return;
	finished = true;
	client.stop("probe finished");
	const rows = [...results.entries()].map(([kind, result]) => {
		const event = result.event ? `✓ ${result.eventKey ?? ""}`.trim() : "—";
		const update = result.updateMs !== undefined ? `✓ ${result.updateMs}ms` : (result.updateError ?? "—");
		return `  ${kind.padEnd(7)} 下发 ${(result.sent ?? "—").padEnd(18)} 事件 ${event.padEnd(12)} 更新 ${update}`;
	});
	console.log(
		[
			"",
			"探针结果",
			`  markdown 基线对照组`,
			...rows,
			`  收到的消息回调：${cardInbound} 条`,
			`  回复通道 stream_with_template_card 首帧：${replies.first}`,
			`  finish 带 msg_item 图片：${replies.withImage}${replies.plain === "—" ? "" : `；不带图片：${replies.plain}`}`,
			`  引用回复：${replies.quotes.length ? "" : "—"}`,
			...replies.quotes.map((quote) => `    ${quote}`),
			"",
			"回到 pi 执行 /wecom-aibot connect 恢复机器人。",
		].join("\n"),
	);
	process.exit(code);
}

process.on("SIGINT", () => finish(130));
process.on("unhandledRejection", (error) => {
	log(`未处理异常：${error instanceof Error ? error.message : String(error)}`);
	finish(1);
});

await main();

/**
 * A session's control card, as pi draws it for each publish and each click. One dropdown per card: normally
 * the session (the gateway adds the others online), the prompts or models while choosing one.
 */
import { createHash } from "node:crypto";
import { type CardAction, type CardModel, type CardSelection, type CardTone, clamp } from "../shared/card.ts";
import {
	CONTROL_KEYS,
	type ControlAction,
	controlKey,
	MODEL_QUESTION,
	OPTION_TEXT,
	PROMPT_QUESTION,
	SESSION_QUESTION,
	sessionHead,
	sessionOption,
} from "../shared/control-card.ts";
import type { SessionSource } from "../shared/notification-types.ts";
import { type ModelChoice, modelOptions, modelPage } from "./model-options.ts";
import { withoutNextStepLines } from "./next-steps.ts";

/** done, aborted, failed: a finished run's copy, until a click shows the live state. */
export type ControlStatus = "idle" | "running" | "confirming" | "doc-problem" | "done" | "aborted" | "failed";

/** What pi knows as it draws a card; one model per viewer. */
export interface ControlView {
	status: ControlStatus;
	/** The viewer pressed 发提示词 or 切换模型; nothing to choose from leaves the card as it is. */
	choosing?: "prompt" | "model";
	models?: readonly ModelChoice[];
	model?: Pick<ModelChoice, "provider" | "id">;
	modelPage?: number;
	screen?: { at: Date; lines: readonly string[] };
	pageUrl?: string;
	/** The session document's copy of pi's logo; the gateway draws a public one without it. */
	icon?: string;
	prompts?: readonly string[];
	/** Tasks waiting behind the current run, counted when the card is drawn; a finished run's copy leaves it out. */
	queued?: number;
}

export interface PromptOption {
	/** The prompt's own fingerprint: a moved prompt is still found, an edited one is not. */
	id: string;
	text: string;
	prompt: string;
}

const STATUS: Record<ControlStatus, { text: string; tone: CardTone }> = {
	idle: { text: "空闲", tone: "neutral" },
	running: { text: "执行中", tone: "success" },
	confirming: { text: "等待确认中止", tone: "danger" },
	"doc-problem": { text: "文档不可用", tone: "danger" },
	done: { text: "已完成", tone: "success" },
	aborted: { text: "已中止", tone: "danger" },
	failed: { text: "未执行", tone: "danger" },
};
const WINDOW_ROW = "窗口记录";
const FINISHED: ReadonlySet<ControlStatus> = new Set(["done", "aborted", "failed"]);
/** WeCom shows three lines of a quote (measured 2026-10). */
const QUOTE_LINES = 3;
const QUOTE_LIMIT = 1500;

/**
 * Buttons by step, always two or four (three in a row are cut): the frequent pair first, 中止任务 last; a
 * second step confirms on the left and cancels on the right.
 */
const BUTTONS = {
	normal: [
		[CONTROL_KEYS.refresh, "刷新卡片", 1],
		[CONTROL_KEYS.send, "发提示词", 2],
		[CONTROL_KEYS.model, "切换模型", 2],
		[CONTROL_KEYS.abort, "中止任务", 3],
	],
	confirming: [
		[CONTROL_KEYS.confirmAbort, "确认中止", 3],
		[CONTROL_KEYS.cancelAbort, "取消中止", 2],
	],
	/** With tasks queued: this run only, or with the queue; the queue only; never. */
	confirmingQueue: [
		[CONTROL_KEYS.confirmAbort, "确认中止", 3],
		[CONTROL_KEYS.abortAll, "全部中止", 3],
		[CONTROL_KEYS.clearQueue, "清空排队", 3],
		[CONTROL_KEYS.cancelAbort, "取消中止", 2],
	],
	prompt: [
		[CONTROL_KEYS.confirmSend, "确认发送", 1],
		[CONTROL_KEYS.cancelSend, "取消发送", 2],
	],
	model: [
		[CONTROL_KEYS.confirmModel, "确认切换", 1],
		[CONTROL_KEYS.cancelModel, "取消切换", 2],
	],
	/** WeCom says nothing when only the dropdown changes, so pages turn by buttons. */
	pages: [
		[CONTROL_KEYS.modelPrev, "上一页", 2],
		[CONTROL_KEYS.modelNext, "下一页", 2],
	],
} as const satisfies Record<string, readonly (readonly [ControlAction, string, CardAction["style"]])[]>;

export function sessionControlCard(source: SessionSource, view: ControlView): CardModel {
	const prompts = promptOptions(view.prompts ?? []);
	const all = modelOptions(view.models ?? [], view.model);
	const models = modelPage(all, view.modelPage);
	const mode =
		view.status === "confirming"
			? view.queued
				? "confirmingQueue"
				: "confirming"
			: view.choosing === "prompt" && prompts.length
				? "prompt"
				: view.choosing === "model" && models.options.length
					? "model"
					: "normal";
	const paged = mode === "model" && models.pages > 1;
	const buttons = paged ? [...BUTTONS.model, ...BUTTONS.pages] : BUTTONS[mode];
	const options = (items: readonly { id: string; text: string }[]) => items.map(({ id, text }) => ({ id, text }));
	const own = sessionOption(source.sessionId, source.directoryName);
	// 确认中止 acts on the session shown: no dropdown may point elsewhere while it is asked.
	const selection: CardSelection | undefined = {
		confirming: undefined,
		confirmingQueue: undefined,
		prompt: { key: PROMPT_QUESTION, title: "提示词", options: options(prompts) },
		model: {
			key: MODEL_QUESTION,
			title: paged ? `模型 ${models.page + 1}/${models.pages}` : "模型",
			options: options(models.options),
			...(models.selected ? { selected: models.selected } : {}),
		},
		normal: { key: SESSION_QUESTION, title: "会话", options: [own], selected: own.id },
	}[mode];
	const head = sessionHead(source);
	const status = STATUS[view.status];
	// A finished run's copy says how that run ended; the live queue is a click away.
	const queued = FINISHED.has(view.status) ? 0 : (view.queued ?? 0);
	return {
		label: queued ? `${status.text} · 排队 ${queued}` : status.text,
		tone: status.tone,
		...(view.icon ? { icon: view.icon } : {}),
		title: head.title,
		desc: head.desc,
		quote: quoteOf(view),
		quoteLimit: QUOTE_LIMIT,
		...(view.pageUrl ? { quoteUrl: view.pageUrl } : {}),
		subtitle:
			view.status === "doc-problem"
				? `${head.subtitle}；文档授权过期请到工作台 → 智能机器人 → 可使用权限重新授权`
				: paged
					? `${head.subtitle}；共 ${all.options.length} 个模型，分 ${models.pages} 页，用「上一页」「下一页」翻`
					: head.subtitle,
		facts: [],
		...(selection ? { selection } : {}),
		actions: buttons.map(([action, text, style]) => ({ key: controlKey(action, source.sessionId), text, style })),
		noteKey: WINDOW_ROW,
	};
}

export function promptOptions(prompts: readonly string[]): PromptOption[] {
	return prompts.map((prompt) => ({
		id: `p-${createHash("sha256").update(prompt).digest("hex").slice(0, 16)}`,
		text: clamp(prompt, OPTION_TEXT),
		prompt,
	}));
}

/** The last lines with words, whole: no cut to a phone's width; a reply's next-step comment is not shown. */
export function quoteTail(lines: readonly string[]): string[] {
	return withoutNextStepLines(lines)
		.filter((line) => /[\p{L}\p{N}]/u.test(line))
		.slice(-QUOTE_LINES);
}

/** No screen: pi has no terminal (RPC, print), or none was read yet; the page still has the replies. */
function quoteOf(view: ControlView): string {
	if (view.screen) return quoteTail(view.screen.lines).join("\n") || "（终端画面为空）";
	return view.pageUrl ? "没有终端画面；点这里看最近回复" : "点「刷新卡片」读取画面";
}

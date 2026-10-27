/**
 * Every card the bot sends is a button_interaction template card, rebuilt whole on each update. The limits are
 * the recommendations of https://developer.work.weixin.qq.com/document/path/101032, so text is clamped.
 */
import { asRecord } from "./wecom-protocol.ts";

export interface CardAction {
	/** event_key: at most 1024 bytes and unique within the card. */
	key: string;
	text: string;
	style?: 1 | 2 | 3 | 4;
}

export interface CardFact {
	key: string;
	value: string;
}

/** A dropdown (button_selection). WeCom returns the chosen option only with a button click. */
export interface CardSelection {
	/** question_key: at most 1024 bytes. */
	key: string;
	title: string;
	options: { id: string; text: string }[];
	selected?: string;
}

export type CardTone = "neutral" | "success" | "danger";

export interface CardModel {
	/** The source line above the title. */
	label: string;
	tone: CardTone;
	/** The source line's icon (source.icon_url); https only. */
	icon?: string;
	title: string;
	desc?: string;
	/** A grey quote block: an excerpt, or a line the user may copy. */
	quote?: string;
	/** Makes the quote block a link (QuoteArea type=1); https only. */
	quoteUrl?: string;
	/** A longer quote than the default excerpt; WeCom took 1531 characters (measured), its client shows 3 lines. */
	quoteLimit?: number;
	/** Plain second-level text under the title. */
	subtitle?: string;
	facts: CardFact[];
	selection?: CardSelection;
	actions: CardAction[];
	/** The row a click's result is written to; NOTE_KEY when absent. */
	noteKey?: string;
}

const LIMITS = {
	label: 20,
	title: 36,
	desc: 40,
	text: 112,
	quote: 200,
	factKey: 5,
	factValue: 40,
	button: 10,
	facts: 6,
	buttons: 6,
	selectionTitle: 13,
	options: 10,
	/** The renderer's bound; each dropdown cuts its own options shorter (10 by WeCom's advice, a model 32). */
	option: 32,
} as const;
/** A link WeCom opens: https, bounded, no whitespace or control characters. */
const LINK = /^https:\/\/[^\s\u0000-\u001f\u007f]{1,1016}$/;
/** option id: at most 128 bytes, unique within its selection. */
const OPTION_ID_BYTES = 128;
/** The longest quote a card may ask for: above what WeCom was seen to accept, below anything unbounded. */
const MAX_QUOTE = 2048;
/** The fact that records the latest button click; it replaces itself instead of growing the card. */
export const NOTE_KEY = "动态";
const TONE_COLOR: Record<CardTone, 0 | 2 | 3> = { neutral: 0, danger: 2, success: 3 };

/** Semantic cards cross IPC too: keep their shape bounded before the renderer touches them. */
export function validCardModel(value: unknown): value is CardModel {
	const card = asRecord(value);
	const text = (value: unknown): value is string => typeof value === "string" && value.length <= 16_384;
	if (
		!card ||
		!text(card.label) ||
		!text(card.title) ||
		typeof card.tone !== "string" ||
		!["neutral", "success", "danger"].includes(card.tone)
	)
		return false;
	if (![card.desc, card.quote, card.text].every((value) => value === undefined || text(value))) return false;
	if (card.quoteUrl !== undefined && !link(card.quoteUrl)) return false;
	if (card.noteKey !== undefined && !(typeof card.noteKey === "string" && card.noteKey && card.noteKey.length <= 16))
		return false;
	if (
		card.quoteLimit !== undefined &&
		!(
			Number.isInteger(card.quoteLimit) &&
			(card.quoteLimit as number) > 0 &&
			(card.quoteLimit as number) <= MAX_QUOTE
		)
	)
		return false;
	if (card.icon !== undefined && !link(card.icon)) return false;
	if (
		!Array.isArray(card.facts) ||
		card.facts.length > 6 ||
		!card.facts.every((value) => {
			const fact = asRecord(value);
			return !!fact && text(fact.key) && text(fact.value);
		})
	)
		return false;
	if (card.selection !== undefined && !validSelection(card.selection)) return false;
	if (!Array.isArray(card.actions) || card.actions.length > 6) return false;
	const keys = new Set<string>();
	return card.actions.every((value) => {
		const action = asRecord(value);
		if (
			!action ||
			typeof action.key !== "string" ||
			!action.key ||
			Buffer.byteLength(action.key) > 1024 ||
			!text(action.text) ||
			(action.style !== undefined && (typeof action.style !== "number" || ![1, 2, 3, 4].includes(action.style))) ||
			keys.has(action.key)
		)
			return false;
		keys.add(action.key);
		return true;
	});
}

function link(value: unknown): value is string {
	return typeof value === "string" && LINK.test(value);
}

function validSelection(value: unknown): value is CardSelection {
	const selection = asRecord(value);
	if (
		!selection ||
		typeof selection.key !== "string" ||
		!selection.key ||
		Buffer.byteLength(selection.key) > 1024 ||
		typeof selection.title !== "string" ||
		selection.title.length > 256 ||
		!Array.isArray(selection.options) ||
		!selection.options.length ||
		selection.options.length > LIMITS.options
	)
		return false;
	const ids = new Set<string>();
	for (const value of selection.options) {
		const option = asRecord(value);
		if (
			!option ||
			typeof option.id !== "string" ||
			!option.id ||
			Buffer.byteLength(option.id) > OPTION_ID_BYTES ||
			ids.has(option.id) ||
			typeof option.text !== "string" ||
			option.text.length > 256
		)
			return false;
		ids.add(option.id);
	}
	return selection.selected === undefined || (typeof selection.selected === "string" && ids.has(selection.selected));
}

/** The template_card body for aibot_send_msg and aibot_respond_update_msg. */
export function renderCard(model: CardModel, cardId: string): Record<string, unknown> {
	const facts = model.facts.slice(0, LIMITS.facts).map((fact) => ({
		keyname: clamp(fact.key, LIMITS.factKey) || "·",
		value: clamp(fact.value, LIMITS.factValue),
	}));
	const actions = (model.actions.length ? model.actions : [{ key: "noop", text: "已完成" }])
		.slice(0, LIMITS.buttons)
		.map((action) => ({ text: clamp(action.text, LIMITS.button), key: action.key, style: action.style ?? 1 }));
	const quote = model.quote && clamp(model.quote, Math.min(model.quoteLimit ?? LIMITS.quote, MAX_QUOTE));
	const quoteLink = quote && model.quoteUrl && LINK.test(model.quoteUrl) ? { type: 1, url: model.quoteUrl } : {};
	const text = model.subtitle && clamp(model.subtitle, LIMITS.text);
	const selection = model.selection && renderSelection(model.selection);
	return {
		card_type: "button_interaction",
		source: {
			...(model.icon && LINK.test(model.icon) ? { icon_url: model.icon } : {}),
			desc: clamp(model.label, LIMITS.label),
			desc_color: TONE_COLOR[model.tone],
		},
		main_title: {
			title: clamp(model.title, LIMITS.title) || "pi",
			...(model.desc ? { desc: clamp(model.desc, LIMITS.desc) } : {}),
		},
		...(quote ? { quote_area: { ...quoteLink, quote_text: quote } } : {}),
		...(text ? { sub_title_text: text } : {}),
		...(facts.length ? { horizontal_content_list: facts } : {}),
		...(selection ? { button_selection: selection } : {}),
		button_list: actions,
		task_id: cardId,
	};
}

function renderSelection(selection: CardSelection): Record<string, unknown> {
	const options = selection.options
		.slice(0, LIMITS.options)
		.map((option) => ({ id: option.id, text: clamp(option.text, LIMITS.option) || option.id }));
	const selected = options.some((option) => option.id === selection.selected) ? selection.selected : options[0]?.id;
	return {
		question_key: selection.key,
		title: clamp(selection.title, LIMITS.selectionTitle),
		...(selected ? { selected_id: selected } : {}),
		option_list: options,
	};
}

/** The same card with the latest click recorded; never more than one note. */
export function withNote(model: CardModel, note: string, at = new Date()): CardModel {
	const key = model.noteKey ?? NOTE_KEY;
	const facts = model.facts.filter((fact) => fact.key !== key);
	facts.push({ key, value: `${clock(at)} ${note}` });
	return { ...model, facts: facts.slice(-LIMITS.facts) };
}

/** Card text is plain: Markdown markers are removed, code blocks become a placeholder. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/\r\n?/g, "\n")
		.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)/gm, "[代码]")
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[图片]")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
		.replace(/^[ \t]{0,3}>[ \t]?/gm, "")
		.replace(/^[ \t]*[-*+][ \t]+/gm, "· ")
		.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Code points, not UTF-16 units: an emoji is never cut in half. */
export function clamp(value: string, limit: number): string {
	const chars = [...value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim()];
	return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

export function clock(at: Date): string {
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

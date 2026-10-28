/**
 * What pi and the gateway agree on about cards: control card IDs, button keys, dropdown keys, and how a card
 * names a session. A control card belongs to one session, whichever registration or gateway process it met.
 */
import { createHash, randomBytes } from "node:crypto";
import { clamp } from "./card.ts";

// ---------------------------------------------------------------- IDs

const CONTROL_ID = /^s@([0-9a-f]{64})@[0-9a-f]{12}$/;

/** A session's fixed-size fingerprint, so custom IDs never reach a task_id, key or option id WeCom restricts. */
export function sessionFingerprint(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

export function controlCardId(sessionId: string): string {
	return `s@${sessionFingerprint(sessionId)}@${randomBytes(6).toString("hex")}`;
}

export function isControlCardId(value: unknown): value is string {
	return typeof value === "string" && CONTROL_ID.test(value);
}

/** The session a control card was published for. */
export function publisherFingerprint(cardId: string): string | undefined {
	return CONTROL_ID.exec(cardId)?.[1];
}

export function controlCardFor(cardId: unknown, sessionId: string): boolean {
	return isControlCardId(cardId) && publisherFingerprint(cardId) === sessionFingerprint(sessionId);
}

// ---------------------------------------------------------------- button keys

/** pi owns what each does; the gateway forwards them. A key names the session its copy showed (controlKey). */
/** A click without a card: the session publishes a new copy of its control card (企微 card, 打开会话). */
export const PUBLISH_KEY = "control";

export const CONTROL_KEYS = {
	refresh: "refresh",
	send: "send",
	confirmSend: "send-confirm",
	cancelSend: "send-cancel",
	model: "model",
	confirmModel: "model-confirm",
	cancelModel: "model-cancel",
	modelPrev: "model-prev",
	modelNext: "model-next",
	abort: "abort",
	confirmAbort: "abort-confirm",
	cancelAbort: "abort-cancel",
	/** 确认中止's neighbours while tasks are queued: this run and the queue, or the queue alone. */
	abortAll: "abort-all",
	clearQueue: "abort-queue",
	/** Never drawn: the gateway's, when a click should only turn the copy to its session. */
	show: "show",
} as const;

export type ControlAction = (typeof CONTROL_KEYS)[keyof typeof CONTROL_KEYS];

const ACTIONS: ReadonlySet<string> = new Set(Object.values(CONTROL_KEYS));
const KEY = /^([a-z-]{1,32})@([0-9a-f]{64})$/;

export function controlKey(action: ControlAction, sessionId: string): string {
	return `${action}@${sessionFingerprint(sessionId)}`;
}

/** Undefined for a key that is not one of today's buttons. */
export function parseControlKey(key: string): { action: ControlAction; fingerprint: string } | undefined {
	const match = KEY.exec(key);
	if (!match || !ACTIONS.has(match[1])) return undefined;
	return { action: match[1] as ControlAction, fingerprint: match[2] };
}

// ---------------------------------------------------------------- dropdowns

export const PROMPT_QUESTION = "prompt";
export const MODEL_QUESTION = "model";
/** pi draws it with its own session alone; the gateway adds the others online. */
export const SESSION_QUESTION = "session";

/** WeCom suggests ten characters an option. */
export const OPTION_TEXT = 10;
/** A model's label differs at its end and may name its relay; not measured on a phone. */
export const MODEL_OPTION_TEXT = 32;
/** The 提示词 dropdown holds at most 10 options (WeCom); a prompt is a task, bounded like one line of it. */
export const MAX_PROMPTS = 10;
export const MAX_PROMPT_LENGTH = 500;

// ---------------------------------------------------------------- naming a session

/** 「文件夹 · ID 末 4 位」: the end of the ID tells sessions in one folder apart; the folder is cut first. */
export function sessionLabel(sessionId: string, directory: string, folder = OPTION_TEXT): string {
	return `${clamp(directory || "pi", folder)} · ${sessionId.slice(-4)}`;
}

export function sessionOption(sessionId: string, directory: string): { id: string; text: string } {
	return { id: sessionFingerprint(sessionId), text: sessionLabel(sessionId, directory) };
}

/** A card's head: 📁 folder, 🤖 model · provider, 🆔 session-id (spelled as pi --session-id). */
export function sessionHead(source: {
	directoryName: string;
	modelName: string;
	provider: string;
	sessionId: string;
}): {
	title: string;
	desc: string;
	subtitle: string;
} {
	return {
		title: `📁 ${source.directoryName || "pi"}`,
		desc: `🤖 ${source.modelName} · ${source.provider}`,
		subtitle: `🆔 session-id: ${source.sessionId}`,
	};
}

export const CONTROL_OFFLINE_LABEL = "会话已离线";

/**
 * Pi's mark until a pi brings its session document's colour copy. WeCom draws no SVG icon and pi publishes no
 * PNG; LobeHub's pinned PNG on npmmirror's CDN shows on phones (measured 2026-10).
 */
export const PI_ICON_URL = "https://registry.npmmirror.com/@lobehub/icons-static-png/2.2.0/files/light/pi.png";

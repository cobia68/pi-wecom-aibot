/**
 * WeCom 智能机器人 configuration: one field table shared by validation, help, completion and the editor,
 * and the merge of a global file with per-session override files.
 *
 *   <agent-dir>/wecom-aibot/config.json              global defaults; allowedUserIds lives only here
 *   <agent-dir>/wecom-aibot/sessions/<session>.json  one session's explicit overrides
 *
 * A missing file means "no values here"; an unreadable one is an error, never an empty layer.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pluginDirectory } from "../shared/agent-path.ts";
import { MAX_PROMPT_LENGTH, MAX_PROMPTS } from "../shared/control-card.ts";
import { errorMessage, sentences } from "../shared/text.ts";
import type { ChatRef } from "../shared/wecom-protocol.ts";
import { docUrlProblem } from "./doc-mcp.ts";

export type NotificationScope = "wecom-tasks" | "all-runs";

export interface ManagedFields {
	botId: string;
	secret: string;
	defaultChatId: string;
	defaultChatType: 1 | 2;
	notificationScope: NotificationScope;
	/** The smart robot's document MCP address (streamableHTTP URL); it carries an apikey. */
	docMcpUrl: string;
	/** The control card's 提示词 dropdown: each one is sent as typed when 发送 is pressed. */
	controlPrompts: string[];
}
export type FieldName = keyof ManagedFields;
/** Read where they are used, so a change applies without a new registration. */
export type Settings = Pick<ManagedFields, "notificationScope" | "controlPrompts"> &
	Partial<Pick<ManagedFields, "docMcpUrl">>;
export type Layer = Partial<ManagedFields> & { allowedUserIds?: string[] };
export interface LayerChange {
	set?: Partial<ManagedFields>;
	remove?: readonly FieldName[];
}

interface Choice<Value> {
	value: Value;
	description: string;
}

interface FieldBase {
	label: string;
	description: string;
}

/** Part of the registration: adopted by /wecom-aibot connect, never applied to a live one. */
export interface ConnectionField extends FieldBase {
	effect: "connection";
	name: Exclude<FieldName, keyof Settings>;
	choices?: readonly Choice<ManagedFields[FieldName]>[];
	default?: undefined;
}

export interface ChoiceField extends FieldBase {
	effect: "setting";
	name: "notificationScope";
	choices: readonly Choice<NotificationScope>[];
	default: NotificationScope;
}

/** A list typed one item per line in `config edit`, or comma-separated in `config set` when no item has a comma or space; none by default. */
export interface PromptsField extends FieldBase {
	effect: "setting";
	name: "controlPrompts";
	choices?: undefined;
	default: readonly string[];
}

export type SettingField = ChoiceField | PromptsField;

/** Global only, typed only in `config edit`: the address is a credential, shown as set or not set. */
export interface DocumentField extends FieldBase {
	effect: "document";
	name: "docMcpUrl";
	choices?: undefined;
	default?: undefined;
}

export type FieldSpec = ConnectionField | SettingField | DocumentField;

/** Every managed field, in display order. */
export const FIELDS: readonly FieldSpec[] = [
	{ name: "botId", label: "BotID", description: "智能机器人 BotID", effect: "connection" },
	{
		name: "secret",
		label: "Secret",
		description: "长连接专用 Secret；查看时只显示是否已配置",
		effect: "connection",
	},
	{
		name: "defaultChatId",
		label: "默认推送目标",
		description: "单聊填 userid，群聊填群 chatid，原样保存",
		effect: "connection",
	},
	{
		name: "defaultChatType",
		label: "目标类型",
		description: "与 defaultChatId 成组；只给 defaultChatId 时为 1",
		choices: [
			{ value: 1, description: "单聊" },
			{ value: 2, description: "群聊" },
		],
		effect: "connection",
	},
	{
		name: "notificationScope",
		label: "自动结束通知范围",
		description: "哪些运行结束后自动通知；显式发送、部署测试和会话控制卡不受影响",
		choices: [
			{ value: "wecom-tasks", description: "仅自动回传企微发起的任务结果" },
			{ value: "all-runs", description: "已接入会话的每轮完整运行结束后都通知；企微任务不重复发送" },
		],
		default: "wecom-tasks",
		effect: "setting",
	},
	{
		name: "controlPrompts",
		label: "控制卡提示词",
		description: `控制卡「提示词」下拉框的候选，最多 ${MAX_PROMPTS} 条；点「发提示词」时把选中的那条原样作为本 session 的任务。下拉框只显示前 10 个字。config set 用英文逗号分隔（controlPrompts=继续,运行测试），整份替换；controlPrompts+=新提示 加在末尾，controlPrompts-=旧提示 删掉一条，多条也用英文逗号分隔；session 还没有自己的提示词时，+= 和 -= 先复制继承来的那份再改，之后与全局独立。含空格或逗号的提示词用 config edit 一行一条填写，清空编辑器即为没有提示词。不设置时没有提示词，控制卡不显示下拉框和「发提示词」`,
		default: [],
		effect: "setting",
	},
	{
		name: "docMcpUrl",
		label: "会话文档",
		description:
			"智能机器人「文档」授权后的 streamableHTTP URL（工作台 → 智能机器人 → 可使用权限）。配置后，插件在企业微信里建一份文档，每个 session 一页，写最近的回复和通知，点控制卡的引用区打开。地址含 apikey：只能用 /wecom-aibot config --scope global edit 填写，查看时只显示是否已配置",
		effect: "document",
	},
];

export const SETTING_FIELDS = FIELDS.filter((spec): spec is SettingField => spec.effect === "setting");

/** Fields saved and removed as one group: a layer never pairs its half with another layer's. */
const PAIRED: readonly (readonly FieldName[])[] = [
	["botId", "secret"],
	["defaultChatId", "defaultChatType"],
];

export function fieldsWith(name: FieldName): readonly FieldName[] {
	return PAIRED.find((group) => group.includes(name)) ?? [name];
}

export function fieldNamed(name: string): FieldSpec | undefined {
	const wanted = name.toLowerCase();
	return FIELDS.find((spec) => spec.name.toLowerCase() === wanted);
}

const ALL = FIELDS.map((spec) => spec.name);
const GROUPS = ALL.filter((name) => fieldsWith(name)[0] === name).map(fieldsWith);
/** The credentials and the document address are typed only in `config edit`: a typed command stays in the input history. */
export const SETTABLE: readonly FieldName[] = ALL.filter(
	(name) => name !== "botId" && name !== "secret" && name !== "docMcpUrl",
);

/** One rule for the file, `config set` and `config edit`: what a 提示词 list may hold. */
export function promptsProblem(value: unknown): string | undefined {
	if (!Array.isArray(value)) return "必须是提示词字符串组成的数组";
	if (value.length > MAX_PROMPTS) return `最多 ${MAX_PROMPTS} 条提示词，现在 ${value.length} 条`;
	const seen = new Set<string>();
	for (const [index, prompt] of value.entries()) {
		const at = `第 ${index + 1} 条`;
		if (typeof prompt !== "string" || !prompt.trim()) return `${at}是空的`;
		if (prompt !== prompt.trim()) return `${at}首尾有空白`;
		if ([...prompt].length > MAX_PROMPT_LENGTH) return `${at}超过 ${MAX_PROMPT_LENGTH} 字`;
		if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(prompt)) return `${at}含换行或控制字符`;
		if (seen.has(prompt)) return `${at}与前面重复：${prompt}`;
		seen.add(prompt);
	}
	return undefined;
}

/** `config set controlPrompts=a,b`: split at ASCII commas only, so a Chinese comma stays inside a prompt. */
function parsePrompts(text: string): { prompts: string[] } | { problem: string } {
	const prompts = text.split(",").map((item) => item.trim());
	const problem = promptsProblem(prompts);
	return problem ? { problem: `controlPrompts ${problem}` } : { prompts };
}

/** Values are used as given; a userid or chatid never contains quotes or spaces, so such a value was pasted with something else. */
export function chatIdProblem(chatId: string): string | undefined {
	return /["'“”‘’`\s]/.test(chatId)
		? `chatid「${chatId}」含引号或空格；企微的 userid 和 chatid 不含这些字符，请只写 ID 本身`
		: undefined;
}

// ---------------------------------------------------------------- files

/** A file of its own: pi gives extensions no settings writer, and project settings cannot override credentials here. */
export const CONFIG_FILE = join(pluginDirectory(), "config.json");
export const SESSIONS_DIR = join(pluginDirectory(), "sessions");

export type Scope = "global" | { session: string };

export function layerFile(scope: Scope): string {
	return scope === "global" ? CONFIG_FILE : join(SESSIONS_DIR, `${sessionFileName(scope.session)}.json`);
}

/** pi's own (lowercase UUID) IDs name their file; any other ID is hashed, so no ID can form a path or a device name. */
function sessionFileName(sessionId: string): string {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)
		? sessionId
		: `id-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

function parseLayer(raw: Record<string, unknown>, scope: Scope): Layer {
	const file = layerFile(scope);
	const invalid = (field: string, problem: string) => new Error(`配置文件 ${file} 的字段 ${field} 无效：${problem}`);
	const layer: Record<string, unknown> = {};
	for (const spec of FIELDS) {
		const value = raw[spec.name];
		if (value === undefined) continue;
		if (spec.name === "controlPrompts") {
			const problem = promptsProblem(value);
			if (problem) throw invalid(spec.name, problem);
			layer[spec.name] = [...(value as string[])];
			continue;
		}
		const problem = fileValueProblem(spec, value, scope);
		if (problem) throw invalid(spec.name, problem);
		layer[spec.name] = value;
	}
	if ((layer.botId === undefined) !== (layer.secret === undefined))
		throw invalid(layer.botId === undefined ? "botId" : "secret", "botId 与 secret 必须成组配置");
	if (layer.defaultChatType !== undefined && layer.defaultChatId === undefined)
		throw invalid("defaultChatType", "必须与 defaultChatId 一起配置");
	const allowed = raw.allowedUserIds;
	if (allowed !== undefined) {
		if (scope !== "global") throw invalid("allowedUserIds", `只能写在全局配置 ${CONFIG_FILE} 中`);
		if (!Array.isArray(allowed) || allowed.some((id) => typeof id !== "string" || !id.trim()))
			throw invalid("allowedUserIds", "必须是 userid 字符串组成的数组");
		layer.allowedUserIds = [...allowed];
	}
	return layer as Layer;
}

/** What is wrong with a field's value as written in a layer's file. */
function fileValueProblem(spec: (typeof FIELDS)[number], value: unknown, scope: Scope): string | undefined {
	if (spec.choices)
		return spec.choices.some((choice) => choice.value === value)
			? undefined
			: `必须是 ${spec.choices.map((choice) => JSON.stringify(choice.value)).join(" 或 ")}`;
	if (typeof value !== "string" || !value.trim()) return "必须是非空字符串";
	if (spec.name === "defaultChatId") return chatIdProblem(value);
	if (spec.name === "docMcpUrl")
		return scope === "global" ? docUrlProblem(value) : `只能写在全局配置 ${CONFIG_FILE} 中`;
	return undefined;
}

export function readLayer(scope: Scope): Layer | undefined {
	const raw = readObject(layerFile(scope));
	return raw && parseLayer(raw, scope);
}

export function writeLayer(scope: Scope, layer: Layer): void {
	parseLayer({ ...layer }, scope);
	writeJson(layerFile(scope), layer, scope !== "global");
}

/** Patches the layer as it is on disk now, so other windows' and hand edits survive; `guard` may refuse first. */
export function patchLayer(scope: Scope, change: LayerChange, guard?: (current: Layer | undefined) => void): Layer {
	return rewriteLayer(scope, (raw) => {
		guard?.(raw && parseLayer(raw, scope));
		const next: Record<string, unknown> = { ...raw };
		for (const name of change.remove ?? []) delete next[name];
		return Object.assign(next, change.set);
	});
}

/**
 * The layer's file as it is on disk now, changed by `edit`, checked and written back; fields it does not know
 * are kept as they are. `edit` returning undefined leaves the file as it is.
 */
function rewriteLayer(
	scope: Scope,
	edit: (raw: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
): Layer {
	const file = layerFile(scope);
	const raw = readObject(file);
	const next = edit(raw);
	if (!next) return parseLayer(raw ?? {}, scope);
	const layer = parseLayer(next, scope);
	writeJson(file, next, scope !== "global");
	return layer;
}

/** Session override files are left alone: they belong to their sessions. */
export function clearConfig(): void {
	// force only tolerates a missing file; permissions, sharing violations, etc. must reach the caller.
	rmSync(CONFIG_FILE, { force: true });
}

/** whoami's 加入白名单: the global file's allowedUserIds gains one userid; everything else in it is kept. */
export function addAllowedUser(userid: string): void {
	rewriteLayer("global", (raw) => {
		const current: unknown[] = Array.isArray(raw?.allowedUserIds) ? raw.allowedUserIds : [];
		return current.includes(userid) ? undefined : { ...raw, allowedUserIds: [...current, userid] };
	});
}

function readObject(file: string): Record<string, unknown> | undefined {
	const text = readIfExists(file, (path) => readFileSync(path, "utf8"));
	return text === undefined ? undefined : parseObject(text, file);
}

function parseObject(text: string, what: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${what} 不是有效的 JSON：${errorMessage(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} 不是 JSON 对象`);
	return value as Record<string, unknown>;
}

function readIfExists<T>(file: string, read: (file: string) => T): T | undefined {
	try {
		return read(file);
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return undefined;
		throw new Error(`无法读取 ${file}：${errorMessage(error)}`);
	}
}

/** Written whole or not at all: a temporary file renamed over the old one. */
export function writeJson(file: string, value: object, privateDirectory: boolean): void {
	// The agent directory belongs to pi; only our files, and the folder named after session IDs, are private.
	mkdirSync(dirname(file), { recursive: true, mode: privateDirectory ? 0o700 : undefined });
	// A symlinked configuration stays a symlink: replace the file it points to.
	const target = existsSync(file) ? realpathSync(file) : file;
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

// ---------------------------------------------------------------- merge

export type Source = "session" | "global" | "default";

export interface Resolved {
	values: Partial<ManagedFields> & Settings;
	sources: Partial<Record<FieldName, Source>>;
	allowedUserIds?: string[];
}

/** built-in default < global < session; a group comes whole from the highest layer that has it. */
export function mergeLayers(global: Layer | undefined, session: Layer | undefined): Resolved {
	const values: Record<string, unknown> = {};
	const sources: Partial<Record<FieldName, Source>> = {};
	for (const spec of SETTING_FIELDS) {
		values[spec.name] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
		sources[spec.name] = "default";
	}
	const owner = (name: FieldName): [Source, Layer] | undefined =>
		session?.[name] !== undefined
			? ["session", session]
			: global?.[name] !== undefined
				? ["global", global]
				: undefined;
	for (const group of GROUPS) {
		const found = owner(group[0]);
		if (!found) continue;
		const [source, layer] = found;
		for (const name of group) {
			values[name] = layer[name];
			sources[name] = source;
		}
	}
	// A target saved without its type is a single chat. Defaults apply here only, never to a layer.
	if (values.defaultChatId !== undefined) values.defaultChatType ??= 1;
	return { values: values as Resolved["values"], sources, allowedUserIds: global?.allowedUserIds };
}

/** What a registration is made of; any change to it needs /wecom-aibot connect. */
export interface Connection {
	botId: string;
	secret: string;
	allowedUserIds?: string[];
	/** Where local runs and /wecom-aibot test send without an explicit target. */
	target?: ChatRef;
}

export function connectionOf(resolved: Resolved): Connection | undefined {
	const { botId, secret, defaultChatId: chatId, defaultChatType: chatType } = resolved.values;
	if (!botId || !secret) return undefined;
	return {
		botId,
		secret,
		allowedUserIds: resolved.allowedUserIds,
		target: chatId && chatType ? { chatId, chatType } : undefined,
	};
}

/** Equal keys can share a registration; settings are deliberately not part of it. No connection is "". */
/** The files now name another connection than the one this session adopted: connect would switch. */
export function pendingReconnect(resolved: Resolved | undefined, adopted: string | undefined): boolean {
	return !!resolved && adopted !== undefined && adopted !== connectionKey(connectionOf(resolved));
}

export function connectionKey(connection: Connection | undefined): string {
	if (!connection) return "";
	// An empty allowlist admits everyone, like none at all.
	const { botId, secret, allowedUserIds = [], target } = connection;
	return JSON.stringify([botId, secret, allowedUserIds, target?.chatId ?? null, target?.chatType ?? null]);
}

// ---------------------------------------------------------------- the current session

/**
 * Every read goes to disk, so other windows' and hand edits apply at the next use. A fork snapshots its
 * parent's overrides once (its file is written even when empty), then the two evolve independently.
 */
export class SessionConfig {
	private lastGood: Resolved | undefined;
	private warned = false;

	constructor(
		readonly sessionId: string,
		/** The parent's session file from the session header (fork, clone, `--fork`). */
		private readonly parentSessionFile: string | undefined,
		private readonly report: (message: string, type: "info" | "warning") => void,
	) {}

	read(): Resolved {
		const resolved = mergeLayers(readLayer("global"), this.ensure());
		this.lastGood = resolved;
		this.warned = false;
		return resolved;
	}

	get latest(): Resolved | undefined {
		return this.lastGood;
	}

	/** While connected: falls back to the last good read, warning once until a read succeeds; throws before any. */
	current(): Resolved {
		try {
			return this.read();
		} catch (error) {
			if (!this.lastGood) throw error;
			if (!this.warned)
				this.report(
					sentences(`企业微信配置无法使用：${errorMessage(error)}`, "继续使用上一次有效的配置"),
					"warning",
				);
			this.warned = true;
			return this.lastGood;
		}
	}

	layer(): Layer | undefined {
		return this.ensure();
	}

	patch(change: LayerChange, guard?: (current: Layer | undefined) => void): Layer {
		this.ensure();
		return patchLayer({ session: this.sessionId }, change, guard);
	}

	private ensure(): Layer | undefined {
		const scope = { session: this.sessionId };
		const own = readLayer(scope);
		if (own || !this.parentSessionFile) return own;
		const parentId = sessionIdIn(this.parentSessionFile);
		const inherited = parentId === undefined ? {} : (readLayer({ session: parentId }) ?? {});
		writeLayer(scope, inherited);
		const copied = FIELDS.filter((spec) => inherited[spec.name] !== undefined).map((spec) => spec.name);
		if (parentId === undefined)
			this.report("父会话文件已不存在，没有可继承的企业微信覆盖项；本 session 使用全局配置", "info");
		else if (copied.length)
			this.report(
				`已从父会话继承企业微信覆盖项：${copied.join("、")}。这是一次性快照，之后两个 session 各自独立；不需要时运行 /wecom-aibot config --scope session unset <字段>`,
				"info",
			);
		return inherited;
	}
}

/** The session ID in the header line of a pi session file. */
function sessionIdIn(sessionFile: string): string | undefined {
	const head = readIfExists(sessionFile, firstLine);
	if (head === undefined) return undefined;
	const what = `父会话 ${sessionFile} 的会话头`;
	const { id } = parseObject(head, what);
	if (typeof id !== "string" || !id) throw new Error(`${what}没有 session ID`);
	return id;
}

function firstLine(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024);
		return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0)).split("\n", 1)[0];
	} finally {
		closeSync(fd);
	}
}

// ---------------------------------------------------------------- command values

/** `controlPrompts+=a,b` adds to the list a layer uses now, `controlPrompts-=a` takes out of it. */
export interface PromptsEdit {
	op: "add" | "remove";
	prompts: string[];
}

export function parseAssignments(
	tokens: readonly string[],
): { set: Partial<ManagedFields>; prompts?: PromptsEdit } | { problems: string[] } {
	const problems: string[] = [];
	const set: Record<string, unknown> = {};
	let prompts: PromptsEdit | undefined;
	const seen = new Set<FieldName>();
	for (const token of tokens) {
		const equals = token.indexOf("=");
		if (equals < 0) {
			problems.push(`「${token}」缺少 =，写成 字段=值`);
			continue;
		}
		const sign = token[equals - 1];
		const op = sign === "+" ? "add" : sign === "-" ? "remove" : undefined;
		const typed = token.slice(0, op ? equals - 1 : equals);
		const text = token.slice(equals + 1);
		const spec = fieldNamed(typed);
		if (!spec) {
			problems.push(unknownField(typed, SETTABLE));
			continue;
		}
		if (!SETTABLE.includes(spec.name)) {
			problems.push(
				spec.name === "docMcpUrl"
					? "docMcpUrl 只能用 /wecom-aibot config --scope global edit 输入：地址含 apikey，命令会留在输入历史中"
					: `${spec.name} 只能用 /wecom-aibot config --scope <global|session> edit 输入：命令会留在输入历史中`,
			);
			continue;
		}
		if (op && spec.name !== "controlPrompts") {
			problems.push(`只有 controlPrompts 能用 += 和 -=；${spec.name} 写成 ${spec.name}=值`);
			continue;
		}
		if (seen.has(spec.name)) {
			problems.push(`${spec.name} 重复给出`);
			continue;
		}
		seen.add(spec.name);
		if (!text) {
			problems.push(
				op
					? `${spec.name}${sign}= 后面要写提示词`
					: `${spec.name} 缺少值；删除字段请用 /wecom-aibot config --scope <global|session> unset ${spec.name}`,
			);
			continue;
		}
		if (spec.name === "controlPrompts") {
			const parsed = parsePrompts(text);
			if ("problem" in parsed) problems.push(parsed.problem);
			else if (op) prompts = { op, prompts: parsed.prompts };
			else set[spec.name] = parsed.prompts;
			continue;
		}
		const choice = spec.choices?.find((item) => String(item.value).toLowerCase() === text.toLowerCase());
		const problem = spec.choices
			? choice
				? undefined
				: `${spec.name} 只能是 ${spec.choices.map((item) => item.value).join("、")}`
			: spec.name === "defaultChatId"
				? chatIdProblem(text)
				: undefined;
		if (problem) problems.push(problem);
		else set[spec.name] = choice ? choice.value : text;
	}
	if (set.defaultChatType !== undefined && set.defaultChatId === undefined)
		problems.push("defaultChatType 需要和 defaultChatId 一起给出，例如 defaultChatId=<群 chatid> defaultChatType=2");
	// Saved explicitly: the group replaces the layer's old type too.
	else if (set.defaultChatId !== undefined) set.defaultChatType ??= 1;
	if (problems.length) return { problems };
	return { set: set as Partial<ManagedFields>, ...(prompts ? { prompts } : {}) };
}

/**
 * The list after `edit`: an added prompt goes last, one already there is skipped; a removed one not there is
 * skipped. Both are named in `skipped`. More than MAX_PROMPTS is refused.
 */
export function applyPromptsEdit(
	current: readonly string[],
	edit: PromptsEdit,
): { prompts: string[]; skipped: string[] } | { problem: string } {
	const skipped: string[] = [];
	let prompts = [...current];
	for (const prompt of edit.prompts) {
		const present = prompts.includes(prompt);
		if (edit.op === "add" ? present : !present) skipped.push(prompt);
		else if (edit.op === "add") prompts.push(prompt);
		else prompts = prompts.filter((item) => item !== prompt);
	}
	if (prompts.length > MAX_PROMPTS)
		return {
			problem: `controlPrompts 最多 ${MAX_PROMPTS} 条，加上后有 ${prompts.length} 条；先用 controlPrompts-= 删掉几条`,
		};
	return { prompts, skipped };
}

export function parseRemovals(tokens: readonly string[]): { remove: FieldName[] } | { problems: string[] } {
	const problems: string[] = [];
	const remove = new Set<FieldName>();
	for (const token of tokens) {
		const spec = fieldNamed(token);
		if (spec) for (const name of fieldsWith(spec.name)) remove.add(name);
		else problems.push(token.includes("=") ? `unset 只写字段名，不带 =：${token}` : unknownField(token, ALL));
	}
	return problems.length ? { problems } : { remove: ALL.filter((name) => remove.has(name)) };
}

function unknownField(typed: string, names: readonly FieldName[]): string {
	if (typed.toLowerCase() === "allowedUserIds".toLowerCase())
		return `allowedUserIds 不由 config 管理，请直接编辑全局配置文件 ${CONFIG_FILE}`;
	return `未知字段 ${typed}；可用字段：${names.join("、")}`;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

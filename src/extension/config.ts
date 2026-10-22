/**
 * Configuration of the WeCom 智能机器人 extension: one table of fields shared by validation, help,
 * completion and the interactive editor; a global file and per-session override files; and the merge
 * that turns both into what the current session uses.
 *
 *   <agent-dir>/wecom-aibot/config.json              global defaults; allowedUserIds lives only here
 *   <agent-dir>/wecom-aibot/sessions/<session>.json  one session's explicit overrides
 *
 * Precedence: built-in default < global < session. The credentials (botId + secret) and the default
 * target (defaultChatId + defaultChatType) are each taken from one layer as a whole, so a session's
 * BotID never meets another bot's Secret. Files are private (0600 on POSIX) and replaced atomically;
 * a missing file means "no values here", an unreadable one is an error and never an empty layer.
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
import type { ChatRef } from "../shared/wecom-protocol.ts";

export type NotificationMode = "text" | "screenshot";
export type NotificationScope = "wecom-tasks" | "all-runs";

/** The fields `/wecom-aibot config` manages. */
export interface ManagedFields {
	botId: string;
	secret: string;
	defaultChatId: string;
	defaultChatType: 1 | 2;
	notificationMode: NotificationMode;
	notificationScope: NotificationScope;
	/** A pi theme name; without one the screenshot is what pi shows. */
	screenshotTheme: string;
}
export type FieldName = keyof ManagedFields;
/** Read where they are used, so a change applies without a new registration. */
export type Settings = Pick<ManagedFields, "notificationMode" | "notificationScope"> &
	Partial<Pick<ManagedFields, "screenshotTheme">>;
/** One layer's explicit values. The hand-edited allowlist exists only in the global layer. */
export type Layer = Partial<ManagedFields> & { allowedUserIds?: string[] };
/** A change to one layer: values to save and fields to remove. */
export interface LayerChange {
	set?: Partial<ManagedFields>;
	remove?: readonly FieldName[];
}

interface Choice<Value> {
	value: Value;
	description: string;
}

interface FieldBase {
	/** What the field is called in the editor and in help. */
	label: string;
	description: string;
}

/** Part of the registration: adopted by /wecom-aibot connect, never applied to a live one. */
export interface ConnectionField extends FieldBase {
	effect: "connection";
	name: Exclude<FieldName, keyof Settings>;
	/** The only valid values; without them the field takes non-empty text. */
	choices?: readonly Choice<ManagedFields[FieldName]>[];
	default?: undefined;
}

/** A setting with fixed values: always one of its choices, with a built-in default. */
export interface ChoiceField extends FieldBase {
	effect: "setting";
	name: "notificationMode" | "notificationScope";
	choices: readonly Choice<NotificationMode | NotificationScope>[];
	default: NotificationMode | NotificationScope;
}

/** pi's own themes are the values: the plugin brings none, and without one pi's current theme is used. */
export interface ThemeField extends FieldBase {
	effect: "setting";
	name: "screenshotTheme";
	choices?: undefined;
	default?: undefined;
}

/** Read again wherever it is used, so a change applies without a new registration. */
export type SettingField = ChoiceField | ThemeField;

export type FieldSpec = ConnectionField | SettingField;

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
		name: "notificationMode",
		label: "通知方式",
		description: "正式通知用文字还是当前终端截图",
		choices: [
			{ value: "text", description: "文字，支持 Markdown 排版" },
			{ value: "screenshot", description: "当前 pi 终端截图，可能包含工具输出等画面内容" },
		],
		default: "text",
		effect: "setting",
	},
	{
		name: "notificationScope",
		label: "自动结束通知范围",
		description: "哪些运行结束后自动通知；显式发送、部署测试和连接入口通知不受影响",
		choices: [
			{ value: "wecom-tasks", description: "仅自动回传企微发起的任务结果" },
			{ value: "all-runs", description: "已接入会话的每轮完整运行结束后都通知；企微任务不重复发送" },
		],
		default: "wecom-tasks",
		effect: "setting",
	},
	{
		name: "screenshotTheme",
		label: "截图主题",
		description:
			"截图用的 pi 主题名，如 dark、light 或已安装的自定义主题；不设置时跟随 pi 当前的界面主题。只影响截图，不改变 pi 本身的界面",
		effect: "setting",
	},
];

export const SETTING_FIELDS = FIELDS.filter((spec): spec is SettingField => spec.effect === "setting");

/** Fields saved and removed as one group: a layer never pairs its half with another layer's. */
const PAIRED: readonly (readonly FieldName[])[] = [
	["botId", "secret"],
	["defaultChatId", "defaultChatType"],
];

/** The field's group, or just the field. */
export function fieldsWith(name: FieldName): readonly FieldName[] {
	return PAIRED.find((group) => group.includes(name)) ?? [name];
}

export function fieldNamed(name: string): FieldSpec | undefined {
	const wanted = name.toLowerCase();
	return FIELDS.find((spec) => spec.name.toLowerCase() === wanted);
}

const ALL = FIELDS.map((spec) => spec.name);
/** Every group once, as listed by its first field. */
const GROUPS = ALL.filter((name) => fieldsWith(name)[0] === name).map(fieldsWith);
/** The credentials are typed only in `config edit`: a typed command stays in the input history. */
export const SETTABLE: readonly FieldName[] = ALL.filter((name) => name !== "botId" && name !== "secret");

/**
 * Fields earlier versions wrote and this one no longer reads. They are not migrated: reading ignores
 * them like any unknown field, and the next save of their layer drops them. Any other unknown field,
 * such as a newer version's, is kept.
 */
const OBSOLETE = ["sendMode", "notifyEveryRun", "enabled", "welcome", "screenMode", "imageHosts", "fontFiles"];

/** Values are used as given; a userid or chatid never contains quotes or spaces, so such a value was pasted with something else. */
export function chatIdProblem(chatId: string): string | undefined {
	return /["'“”‘’`\s]/.test(chatId)
		? `chatid「${chatId}」含引号或空格；企微的 userid 和 chatid 不含这些字符，请只写 ID 本身。`
		: undefined;
}

// ---------------------------------------------------------------- files

/** A file of its own: pi gives extensions no settings writer, and project settings cannot override credentials here. */
export const CONFIG_FILE = join(pluginDirectory(), "config.json");
export const SESSIONS_DIR = join(pluginDirectory(), "sessions");

/** Which layer: the global file, or one session's overrides. */
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

/**
 * One layer as stored. Every known field is checked with its name and file, groups are checked as
 * groups, and any other field is ignored.
 */
function parseLayer(raw: Record<string, unknown>, scope: Scope): Layer {
	const file = layerFile(scope);
	const invalid = (field: string, problem: string) => new Error(`配置文件 ${file} 的字段 ${field} 无效：${problem}`);
	const layer: Record<string, unknown> = {};
	for (const spec of FIELDS) {
		const value = raw[spec.name];
		if (value === undefined) continue;
		const problem = spec.choices
			? spec.choices.some((choice) => choice.value === value)
				? undefined
				: `必须是 ${spec.choices.map((choice) => JSON.stringify(choice.value)).join(" 或 ")}`
			: typeof value !== "string" || !value.trim()
				? "必须是非空字符串"
				: spec.name === "defaultChatId"
					? chatIdProblem(value)
					: undefined;
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

/** The layer as stored, or undefined when its file does not exist. */
export function readLayer(scope: Scope): Layer | undefined {
	const raw = readObject(layerFile(scope));
	return raw && parseLayer(raw, scope);
}

/** Replace one layer's file with exactly these values, validated first. */
export function writeLayer(scope: Scope, layer: Layer): void {
	parseLayer({ ...layer }, scope);
	writeJson(layerFile(scope), layer, scope !== "global");
}

/**
 * Change one layer as it is on disk now, not as it was when pi started: other windows and hand edits
 * survive, unknown fields are kept and obsolete ones dropped. `guard` sees the current layer and may
 * refuse; the result is validated before anything is written.
 */
export function patchLayer(scope: Scope, change: LayerChange, guard?: (current: Layer | undefined) => void): Layer {
	const file = layerFile(scope);
	const raw = readObject(file);
	guard?.(raw && parseLayer(raw, scope));
	const next: Record<string, unknown> = { ...raw };
	for (const name of [...OBSOLETE, ...(change.remove ?? [])]) delete next[name];
	Object.assign(next, change.set);
	const layer = parseLayer(next, scope);
	writeJson(file, next, scope !== "global");
	return layer;
}

/** Delete the global file. Session override files are left alone: they belong to their sessions. */
export function clearConfig(): void {
	// force only tolerates a missing file; permissions, sharing violations, etc. must reach the caller.
	rmSync(CONFIG_FILE, { force: true });
}

/** A file's JSON object, or undefined when the file does not exist. */
function readObject(file: string): Record<string, unknown> | undefined {
	const text = readIfExists(file, (path) => readFileSync(path, "utf8"));
	return text === undefined ? undefined : parseObject(text, file);
}

/** `what` names the text in the error, e.g. its file. */
function parseObject(text: string, what: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${what} 不是有效的 JSON：${errMsg(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} 不是 JSON 对象`);
	return value as Record<string, unknown>;
}

/** What `read` returns, or undefined when the file does not exist; every other failure names the file. */
function readIfExists<T>(file: string, read: (file: string) => T): T | undefined {
	try {
		return read(file);
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return undefined;
		throw new Error(`无法读取 ${file}：${errMsg(error)}`);
	}
}

/** Write a private temporary file and rename it over the target: a reader never sees a partial file. */
function writeJson(file: string, value: object, privateDirectory: boolean): void {
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

/** What the current session uses: each field's value and the layer it came from. */
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
		// A field without a built-in value (the screenshot theme) is simply absent: pi's own is used.
		if (spec.default !== undefined) values[spec.name] = spec.default;
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

/** The connection the merged files describe, or undefined without credentials. */
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
export function connectionKey(connection: Connection | undefined): string {
	if (!connection) return "";
	// An empty allowlist admits everyone, like none at all.
	const { botId, secret, allowedUserIds = [], target } = connection;
	return JSON.stringify([botId, secret, allowedUserIds, target?.chatId ?? null, target?.chatType ?? null]);
}

// ---------------------------------------------------------------- the current session

/**
 * The current session's view of both layers. Every read goes to disk, so another window's change or a
 * hand edit is seen at the next use. A fork (or clone) takes over a snapshot of its parent's overrides
 * the first time its layer is touched: its file is then always written, `{}` when the parent had none,
 * so a resume never copies again and the two sessions evolve independently. A broken parent layer is
 * an error, never a silent fall back to the global bot or target.
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

	/** Both layers as they are on disk now; throws when one cannot be used. */
	read(): Resolved {
		const resolved = mergeLayers(readLayer("global"), this.ensure());
		this.lastGood = resolved;
		this.warned = false;
		return resolved;
	}

	/** The last result read successfully, without reading again. */
	get latest(): Resolved | undefined {
		return this.lastGood;
	}

	/**
	 * For the places a value is used while connected: fresh when possible, otherwise the result the
	 * connection was made with, warning once until a read succeeds again. Before any good read it throws.
	 */
	current(): Resolved {
		try {
			return this.read();
		} catch (error) {
			if (!this.lastGood) throw error;
			if (!this.warned) this.report(`企业微信配置无法使用：${errMsg(error)}。继续使用上一次有效的配置。`, "warning");
			this.warned = true;
			return this.lastGood;
		}
	}

	/** This session's own layer. */
	layer(): Layer | undefined {
		return this.ensure();
	}

	/** Change this session's layer; a fork takes over its parent's overrides first, so none are lost. */
	patch(change: LayerChange): Layer {
		this.ensure();
		return patchLayer({ session: this.sessionId }, change);
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
			this.report("父会话文件已不存在，没有可继承的企业微信覆盖项；本 session 使用全局配置。", "info");
		else if (copied.length)
			this.report(
				`已从父会话继承企业微信覆盖项：${copied.join("、")}。这是一次性快照，之后两个 session 各自独立；不需要时运行 /wecom-aibot config session unset <字段>。`,
				"info",
			);
		return inherited;
	}
}

/** The session ID in the header line of a pi session file; undefined when the file does not exist. */
function sessionIdIn(sessionFile: string): string | undefined {
	const head = readIfExists(sessionFile, firstLine);
	if (head === undefined) return undefined;
	const what = `父会话 ${sessionFile} 的会话头`;
	const { id } = parseObject(head, what);
	if (typeof id !== "string" || !id) throw new Error(`${what}没有 session ID`);
	return id;
}

/** The first line only: a long session's history is never read. */
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

/** `config … set` tokens: the values to save, or every problem found (then nothing is saved). */
export function parseAssignments(tokens: readonly string[]): { set: Partial<ManagedFields> } | { problems: string[] } {
	const problems: string[] = [];
	const set: Record<string, unknown> = {};
	const seen = new Set<FieldName>();
	for (const token of tokens) {
		const equals = token.indexOf("=");
		if (equals < 0) {
			problems.push(`「${token}」缺少 =，写成 字段=值`);
			continue;
		}
		const typed = token.slice(0, equals);
		const text = token.slice(equals + 1);
		const spec = fieldNamed(typed);
		if (!spec) {
			problems.push(unknownField(typed, SETTABLE));
			continue;
		}
		if (!SETTABLE.includes(spec.name)) {
			problems.push(`${spec.name} 只能用 /wecom-aibot config <session|global> edit 输入：命令会留在输入历史中`);
			continue;
		}
		if (seen.has(spec.name)) {
			problems.push(`${spec.name} 重复给出`);
			continue;
		}
		seen.add(spec.name);
		if (!text) {
			problems.push(`${spec.name} 缺少值；清除 session 覆盖请用 /wecom-aibot config session unset ${spec.name}`);
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
	return problems.length ? { problems } : { set: set as Partial<ManagedFields> };
}

/** `config session unset` tokens: field names, each expanded to its whole group. */
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

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

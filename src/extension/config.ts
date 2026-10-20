/**
 * Configuration storage for the WeCom 智能机器人 extension.
 * Stored at <agent-dir>/wecom-aibot/config.json, in the same folder as the gateway socket this
 * extension also owns (created 0600 on POSIX).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pluginDirectory } from "../shared/agent-path.ts";

export type SendMode = "text" | "image";

export interface WeComConfig {
	/** 智能机器人 BotID. */
	botId: string;
	/** 长连接专用 Secret. */
	secret: string;
	/** Optional allowlist of userids. Empty/undefined means everyone. */
	allowedUserIds?: string[];
	/** Default destination for proactive notifications. */
	defaultChatId?: string;
	defaultChatType?: 1 | 2;
	/** text (default) sends Markdown; image sends automatic results as a rendered terminal image. */
	sendMode?: SendMode;
}

/** A file of its own: pi gives extensions no settings writer, and project settings cannot override credentials here. */
export const CONFIG_FILE = join(pluginDirectory(), "config.json");

const DEFAULTS: Omit<WeComConfig, "botId" | "secret"> = {
	sendMode: "text",
};

/** A corrupt file must not look like an unconfigured one: only ENOENT means "no configuration",
 * every other read error and every unusable value names the file and the field to fix. */
export function loadConfig(): WeComConfig | undefined {
	const found = readConfigFile();
	return found && normalize(found.value, found.file);
}

/**
 * Merge `patch` into the file as it is now, not into a snapshot taken when pi started:
 * other windows and hand edits (e.g. allowedUserIds) survive, and fields this version
 * does not know are kept. A patch without credentials never creates a configuration,
 * so a /wecom-aibot reset in another window is not undone. `expected` binds a delayed
 * interaction (e.g. whoami confirmation) to the credentials it started with.
 */
export function updateConfig(
	patch: Partial<WeComConfig>,
	expected?: Pick<WeComConfig, "botId" | "secret">,
): WeComConfig {
	let found: { file: string; value: unknown } | undefined;
	try {
		found = readConfigFile();
	} catch (error) {
		throw new Error(`${errMsg(error)}；请修正或删除该文件后重试。`);
	}
	// Compare validated values, and keep unknown fields by spreading the raw object into the write.
	const current = found ? normalize(found.value, found.file) : undefined;
	if (expected && (current?.botId !== expected.botId || current?.secret !== expected.secret)) {
		throw new Error(
			"机器人配置已改变或配置已删除，默认推送目标未保存；请运行 /wecom-aibot connect 后重新 /wecom-aibot whoami。",
		);
	}
	const next = { ...DEFAULTS, ...(found ? objectValue(found.value) : undefined), ...patch };
	const config = normalize(next, found?.file ?? CONFIG_FILE);
	if (!config) throw new Error("尚未配置，请先运行 /wecom-aibot setup");
	writeConfigFile(next);
	return config;
}

/** Replace the whole file. */
export function saveConfig(config: WeComConfig): void {
	writeConfigFile(config);
}

export function clearConfig(): void {
	// force only tolerates a missing file; permissions, sharing violations, etc. must reach the caller.
	rmSync(CONFIG_FILE, { force: true });
}

/** The parsed file, including fields this version does not know; undefined only when it does not exist. */
function readConfigFile(): { file: string; value: unknown } | undefined {
	const found = readConfigText();
	if (!found) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(found.text);
	} catch (error) {
		throw new Error(`${found.file} 不是有效的 JSON：${errMsg(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${found.file} 不是 JSON 对象`);
	return { file: found.file, value };
}

function readConfigText(): { file: string; text: string } | undefined {
	const file = CONFIG_FILE;
	try {
		return { file, text: readFileSync(file, "utf8") };
	} catch (error) {
		if (!isErrnoException(error) || error.code !== "ENOENT")
			throw new Error(`无法读取配置文件 ${file}：${errMsg(error)}`);
		return undefined;
	}
}

/**
 * One place decides what a stored value means. A wrong type is an error naming the field, never a silent
 * default: a string allowlist would otherwise become one userid per character on the gateway side.
 */
function normalize(value: unknown, file: string): WeComConfig | undefined {
	if (value === undefined) return undefined;
	const parsed = objectValue(value);
	if (!parsed) throw new Error(`配置文件 ${file} 的内容无效：必须是 JSON 对象`);
	const text = (name: string): string | undefined => {
		const raw = parsed[name];
		if (raw === undefined) return undefined;
		if (typeof raw !== "string") throw new Error(`配置文件 ${file} 的字段 ${name} 无效：必须是字符串`);
		return raw;
	};
	const botId = text("botId");
	const secret = text("secret");
	// A file without credentials is not a configuration; /wecom-aibot setup creates one.
	if (!botId || !secret) return undefined;
	const chatType = parsed.defaultChatType;
	if (chatType !== undefined && chatType !== 1 && chatType !== 2) {
		throw new Error(`配置文件 ${file} 的字段 defaultChatType 无效：必须是 1（单聊）或 2（群聊）`);
	}
	const sendMode = parsed.sendMode;
	if (sendMode !== undefined && sendMode !== "text" && sendMode !== "image") {
		throw new Error(`配置文件 ${file} 的字段 sendMode 无效：必须是 "text" 或 "image"`);
	}
	const allowed = parsed.allowedUserIds;
	if (
		allowed !== undefined &&
		(!Array.isArray(allowed) || allowed.some((id) => typeof id !== "string" || !id.trim()))
	) {
		throw new Error(`配置文件 ${file} 的字段 allowedUserIds 无效：必须是 userid 字符串组成的数组`);
	}
	return {
		botId,
		secret,
		allowedUserIds: Array.isArray(allowed) ? allowed.filter((id): id is string => typeof id === "string") : undefined,
		defaultChatId: text("defaultChatId")?.trim() || undefined,
		defaultChatType: chatType === 1 || chatType === 2 ? chatType : undefined,
		sendMode: sendMode === "image" ? "image" : "text",
	};
}

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A JSON object from disk; the shape is validated by normalize(), this only narrows the container. */
function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** Write a private temporary file and rename it over the target: a reader never sees a partial file. */
function writeConfigFile(value: object): void {
	// The agent directory belongs to pi; only this file is made private.
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	let target = CONFIG_FILE;
	// A symlinked configuration stays a symlink: replace the file it points to.
	try {
		target = realpathSync(CONFIG_FILE);
	} catch {
		/* not created yet */
	}
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

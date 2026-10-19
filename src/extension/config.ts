/**
 * Configuration storage for the WeCom 智能机器人 extension.
 * Stored at ~/.pi/agent/wecom-aibot.json, next to pi's settings.json but separate from it (created 0600 on POSIX).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SendMode = "text" | "image";

export interface WeComConfig {
	/** 智能机器人 BotID. */
	botId: string;
	/** 长连接专用 Secret. */
	secret: string;
	/** Welcome text replied on the enter_chat event. */
	welcome: string;
	/** Optional allowlist of userids. Empty/undefined means everyone. */
	allowedUserIds?: string[];
	/** Default destination for proactive notifications. */
	defaultChatId?: string;
	defaultChatType?: 1 | 2;
	/** text (default) sends Markdown; image sends automatic results as a rendered terminal image. */
	sendMode?: SendMode;
}

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = configuredAgentDir
	? resolve(configuredAgentDir.replace(/^~(?=$|[\\/])/, homedir()))
	: join(homedir(), ".pi", "agent");
/** A file of its own: pi gives extensions no settings writer, and project settings cannot override credentials here. */
export const CONFIG_FILE = join(agentDir, "wecom-aibot.json");
/** The pre-rename file name: still read once so an upgrade keeps the saved credentials. */
export const LEGACY_CONFIG_FILE = join(agentDir, "wecom-bot.json");

export const DEFAULT_WELCOME = "你好，我是 pi 智能助手。直接把问题或任务发给我即可。";

const DEFAULTS: Omit<WeComConfig, "botId" | "secret"> = {
	welcome: DEFAULT_WELCOME,
	sendMode: "text",
};

export function loadConfig(): WeComConfig | undefined {
	try {
		return normalize(readConfigFile());
	} catch {
		return undefined;
	}
}

/**
 * Merge `patch` into the file as it is now, not into a snapshot taken when pi started:
 * other windows and hand edits (e.g. allowedUserIds) survive, and fields this version
 * does not know are kept. A patch without credentials never creates a configuration,
 * so a /wecom-aibot logout in another window is not undone. `expected` binds a delayed
 * interaction (e.g. whoami confirmation) to the credentials it started with.
 */
export function updateConfig(patch: Partial<WeComConfig>, expected?: Pick<WeComConfig, "botId" | "secret">): WeComConfig {
	let current: Partial<WeComConfig> | undefined;
	try {
		current = readConfigFile();
	} catch (error) {
		throw new Error(`无法读取配置文件 ${CONFIG_FILE}（${error instanceof Error ? error.message : String(error)}）；请修正或删除该文件后重试。`);
	}
	if (expected && (current?.botId !== expected.botId || current.secret !== expected.secret)) {
		throw new Error("机器人配置已改变或配置已删除，默认推送目标未保存；请运行 /wecom-aibot connect 后重新 /wecom-aibot whoami。");
	}
	const next = { ...DEFAULTS, ...current, ...patch };
	const config = normalize(next);
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
	// A pre-rename file must not resurrect the credentials after a logout.
	rmSync(LEGACY_CONFIG_FILE, { force: true });
}

/** The parsed file, including fields this version does not know; undefined only when it does not exist. */
function readConfigFile(): Partial<WeComConfig> | undefined {
	const found = readConfigText();
	if (!found) return undefined;
	let value: unknown;
	try { value = JSON.parse(found.text); }
	catch { throw new Error(`${found.file} 不是有效的 JSON`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${found.file} 不是 JSON 对象`);
	// A pre-rename file is moved under the new name once, after its content has been validated.
	if (found.file === LEGACY_CONFIG_FILE) {
		try {
			writeConfigFile(value);
			rmSync(LEGACY_CONFIG_FILE, { force: true });
		} catch { /* read-only directory: keep using the legacy file rather than lose the Secret */ }
	}
	return value as Partial<WeComConfig>;
}

/** The new file, or the pre-rename one when the new one does not exist yet. */
function readConfigText(): { file: string; text: string } | undefined {
	for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
		try {
			return { file, text: readFileSync(file, "utf8") };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return undefined;
}

function normalize(parsed: Partial<WeComConfig> | undefined): WeComConfig | undefined {
	if (!parsed?.botId || !parsed?.secret) return undefined;
	// Legacy enabled is deliberately ignored: connection consent belongs only to the current session.
	return {
		botId: parsed.botId,
		secret: parsed.secret,
		welcome: parsed.welcome ?? DEFAULTS.welcome,
		allowedUserIds: parsed.allowedUserIds,
		defaultChatId: typeof parsed.defaultChatId === "string" ? parsed.defaultChatId.trim() || undefined : undefined,
		defaultChatType: parsed.defaultChatType === 1 || parsed.defaultChatType === 2 ? parsed.defaultChatType : undefined,
		// Only "image" opts in; a typo or an older value falls back to safe Markdown.
		sendMode: parsed.sendMode === "image" ? "image" : "text",
	};
}

/** Write a private temporary file and rename it over the target: a reader never sees a partial file. */
function writeConfigFile(value: object): void {
	// The agent directory belongs to pi; only this file is made private.
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	let target = CONFIG_FILE;
	// A symlinked configuration stays a symlink: replace the file it points to.
	try { target = realpathSync(CONFIG_FILE); } catch { /* not created yet */ }
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

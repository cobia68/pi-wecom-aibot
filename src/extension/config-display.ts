/** How configuration values are shown, the same in config show, status and every prompt: no credential in clear. */
import type { FieldName, Resolved, Source } from "./config.ts";

const SOURCE: Record<Source, string> = { session: "session", global: "global", default: "内置默认值" };

/** A value as shown anywhere: a Secret only says whether it is set, a BotID is masked. */
export function display(name: FieldName, value: unknown): string {
	if (name === "docMcpUrl") return value === undefined ? "未配置" : "已配置";
	if (Array.isArray(value)) return value.length ? value.map((item) => `「${item}」`).join("、") : "无";
	if (value === undefined) return "未设置";
	if (name === "secret") return "已配置";
	if (name === "botId") return maskBotId(String(value));
	if (name === "defaultChatType") return `${value}（${value === 2 ? "群聊" : "单聊"}）`;
	return String(value);
}

/** A resolved value with the layer it came from. */
export function describe(resolved: Resolved, name: FieldName): string {
	const source = resolved.sources[name];
	return `${display(name, resolved.values[name])}${source ? `（${SOURCE[source]}）` : ""}`;
}

export function maskBotId(value: string): string {
	if (value.length <= 8) return `${value.slice(0, 2)}****`;
	return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

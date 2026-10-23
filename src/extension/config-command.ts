/**
 * `/wecom-aibot config`: show, edit, set and unset the global layer or the current session's overrides, and
 * identify a chat with config whoami. Saving never connects or disconnects: settings are read where they are
 * used, and a change to the credentials, the default target or the allowlist waits for `/wecom-aibot connect`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ChatIdentity } from "../shared/gateway-protocol.ts";
import { sentences } from "../shared/text.ts";
import {
	type ConfigInvocation,
	type ConfigScope,
	columns,
	configSubcommandLines,
	configSubcommands,
	subcommandUsage,
	WHOAMI_WAIT_SECONDS,
} from "./commands.ts";
import {
	type ChoiceField,
	type Connection,
	chatIdProblem,
	connectionKey,
	connectionOf,
	FIELDS,
	type FieldName,
	fieldsWith,
	type Layer,
	type LayerChange,
	layerFile,
	type ManagedFields,
	mergeLayers,
	patchLayer,
	type Resolved,
	readLayer,
	SETTING_FIELDS,
	type SessionConfig,
	type Source,
	type ThemeField,
} from "./config.ts";

export interface ConfigHost {
	/** The current session's configuration; throws before pi started a session. */
	config(): SessionConfig;
	/** The connection key the formal registration uses; undefined when this session is not connected. */
	adopted(): string | undefined;
	/** A save was reported: the owner updates its footer and need not announce it again. */
	changed(resolved: Resolved): void;
	/** The chat that sends the one-time code, listening with this bot; undefined once it said why not. */
	identify(ctx: ExtensionContext, bot: Connection, seconds: number): Promise<ChatIdentity | undefined>;
}

/** A check of one layer as it is on disk right before writing; it throws to refuse. */
type Guard = (resolved: Resolved) => void;

interface Edit {
	change: LayerChange;
	guard?: Guard;
	note?: string;
}

/** Every action reads the files first, so a file that cannot be used stops it before anything is written. */
export async function runConfig(ctx: ExtensionContext, invocation: ConfigInvocation, host: ConfigHost): Promise<void> {
	try {
		await new ConfigCommand(ctx, host.config(), host).run(invocation);
	} catch (error) {
		ctx.ui.notify(`企业微信配置无法使用：${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

/** A value as shown anywhere: a Secret only says whether it is set, a BotID is masked. */
export function display(name: FieldName, value: unknown): string {
	if (value === undefined) return name === "screenshotTheme" ? "跟随 pi 当前主题" : "未设置";
	if (name === "secret") return "已配置";
	if (name === "botId") return mask(String(value));
	if (name === "defaultChatType") return `${value}（${value === 2 ? "群聊" : "单聊"}）`;
	return String(value);
}

export function pendingReconnect(resolved: Resolved | undefined, adopted: string | undefined): boolean {
	return !!resolved && adopted !== undefined && adopted !== connectionKey(connectionOf(resolved));
}

export function mask(value: string): string {
	if (value.length <= 8) return `${value.slice(0, 2)}****`;
	return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

class ConfigCommand {
	constructor(
		private readonly ctx: ExtensionContext,
		private readonly config: SessionConfig,
		private readonly host: ConfigHost,
	) {}

	async run(invocation: ConfigInvocation): Promise<void> {
		switch (invocation.action) {
			case "choose":
				return this.chooseSubcommand(invocation.scope);
			case "show":
				return invocation.scope ? this.showLayer(invocation.scope) : this.showMerged();
			case "edit":
				return this.edit(invocation.scope);
			case "set":
				return this.save(invocation.scope, { set: invocation.set });
			case "unset":
				return this.unset(invocation.scope, invocation.remove);
			case "whoami":
				return this.whoami(invocation.scope, invocation.seconds);
		}
	}

	private async chooseSubcommand(scope: ConfigScope | undefined): Promise<void> {
		const choices = configSubcommands(scope);
		if (!this.ctx.hasUI) {
			const example = `/wecom-aibot config ${subcommandUsage(choices[0])}`;
			this.notify(
				[`/wecom-aibot config 需要写明动作，例如 ${example}：`, ...configSubcommandLines(scope)].join("\n"),
			);
			return;
		}
		const labels = columns(choices.map((item) => [subcommandUsage(item), item.description] as const));
		const picked = await this.choose(
			scope === "global" ? "全局配置" : scope === "session" ? "当前 session 的覆盖项" : "企业微信配置",
			choices.map((item, index) => [labels[index], item]),
		);
		if (!picked) return;
		if ("run" in picked) await this.run(picked.run);
		else this.ctx.ui.setEditorText(`/wecom-aibot config ${picked.usage} `);
	}

	showMerged(): void {
		const resolved = this.config.read();
		const rows: [string, string][] = FIELDS.map((spec) => [spec.name, describe(resolved, spec.name)]);
		if (resolved.allowedUserIds?.length)
			rows.push(["allowedUserIds", `${resolved.allowedUserIds.join("、")}（global）`]);
		const adopted = this.host.adopted();
		const state =
			adopted === undefined
				? resolved.values.botId
					? "当前 session 未接入；配置齐全后运行 /wecom-aibot connect"
					: "未配置：运行 /wecom-aibot config --scope global edit 填写 BotID、Secret 和默认推送目标"
				: pendingReconnect(resolved, adopted)
					? "待重新接入：当前接入仍使用旧配置，运行 /wecom-aibot connect 后生效"
					: "当前接入与以上配置一致";
		this.notify(
			[
				"当前 session 的企业微信配置（合并结果）：",
				...table(rows),
				state,
				"修改：/wecom-aibot config --scope <global|session> set 字段=值 …，或 config --scope <global|session> edit",
			].join("\n"),
		);
	}

	showLayer(scope: ConfigScope): void {
		const layer = this.layer(scope);
		const rows: [string, string][] = FIELDS.filter((spec) => layer?.[spec.name] !== undefined).map((spec) => [
			spec.name,
			display(spec.name, layer?.[spec.name]),
		]);
		if (layer?.allowedUserIds?.length) rows.push(["allowedUserIds", layer.allowedUserIds.join("、")]);
		const empty = scope === "global" ? "  （未设置任何字段）" : "  （无覆盖项，全部继承全局或内置默认值）";
		this.notify(
			[
				scope === "global" ? "全局配置（显式保存的值）：" : "当前 session 的覆盖项：",
				...(rows.length ? table(rows) : [empty]),
				`文件：${this.file(scope)}`,
			].join("\n"),
		);
	}

	unset(scope: ConfigScope, fields: FieldName[]): void {
		const layer = this.layer(scope);
		const present = fields.filter((name) => layer?.[name] !== undefined);
		if (present.length) this.save(scope, { remove: present });
		else
			this.notify(`${scope === "global" ? "全局配置没有" : "当前 session 没有覆盖"} ${fields.join("、")}，无需修改`);
	}

	/** One notice for the whole report: pi shows consecutive notices in place of each other. */
	save(scope: ConfigScope, change: LayerChange, guard?: Guard, note?: string): void {
		const theme = change.set?.screenshotTheme;
		if (theme !== undefined && !this.piHasTheme(theme)) {
			this.notify(
				`pi 中没有主题 ${theme}，未做任何修改；可用 /wecom-aibot config --scope ${scope} edit 从 pi 的主题列表中选择`,
				"warning",
			);
			return;
		}
		const before = this.previous();
		if (scope === "global")
			patchLayer("global", change, guard && ((current) => guard(mergeLayers(current, undefined))));
		else this.config.patch(change, guard && ((current) => guard(mergeLayers(readLayer("global"), current))));
		const after = this.config.read();
		this.host.changed(after);
		const saved =
			scope === "global"
				? change.set
					? "已保存全局配置"
					: "已删除全局字段"
				: change.set
					? "已保存 session 覆盖"
					: "已删除 session 覆盖";
		this.notify([before ? this.report(saved, scope, change, before, after) : saved, note].filter(Boolean).join("\n"));
	}

	async edit(scope: ConfigScope): Promise<void> {
		if (!this.ctx.hasUI) {
			this.notify(
				sentences(
					`config edit 需要交互界面；请使用 /wecom-aibot config --scope ${scope} set 字段=值`,
					`凭据只能在交互界面输入，或直接编辑 ${this.file(scope)}`,
				),
				"warning",
			);
			return;
		}
		const resolved = this.config.read();
		const edited = resolved.values.botId
			? await this.chooseAndEdit(scope, resolved, this.layer(scope))
			: await this.firstRun(scope);
		if (edited) this.save(scope, edited.change, edited.guard, edited.note);
		else this.notify("已取消，配置未修改");
	}

	private async whoami(scope: ConfigScope | undefined, seconds: number): Promise<void> {
		const bot = this.bot(scope);
		if (!bot) {
			this.notify(
				scope === "global"
					? "全局配置还没有 BotID 和 Secret；先运行 /wecom-aibot config --scope global edit"
					: "还没有配置 BotID 和 Secret；先运行 /wecom-aibot config --scope global edit",
				"warning",
			);
			return;
		}
		const identity = await this.host.identify(this.ctx, bot, seconds);
		if (!identity) return;
		const command = (layer: string) =>
			`/wecom-aibot config --scope ${layer} set defaultChatId=${identity.chatId} defaultChatType=${identity.chatType}`;
		const allowlist = this.allowlistNote(identity);
		const report = (...lines: (string | false | undefined)[]) =>
			this.notify([found(identity), ...lines, allowlist].filter(Boolean).join("\n"));
		if (!scope) {
			report(`设为默认推送目标：${command("<global|session>")}`);
			return;
		}
		const layer = this.layer(scope);
		if (layer?.defaultChatId === identity.chatId && (layer.defaultChatType ?? 1) === identity.chatType) {
			report(`这已经是${scope === "global" ? "全局" : "当前 session "}的默认推送目标，配置未改动`);
			return;
		}
		if (!this.ctx.hasUI) {
			report(sentences("没有交互界面，未保存", `需要时运行 ${command(scope)}`));
			return;
		}
		const resolved = this.config.read();
		const current = scope === "global" ? mergeLayers(readLayer("global"), undefined).values : resolved.values;
		const replaced = current.defaultChatId
			? `将替换${scope === "global" ? "全局默认" : "当前 session 使用的目标"}：${current.defaultChatId}（${current.defaultChatType === 2 ? "群聊" : "单聊"}）`
			: scope === "global"
				? "当前没有全局默认推送目标"
				: "当前 session 还没有默认推送目标";
		const shadowed =
			scope === "global" &&
			resolved.sources.defaultChatId === "session" &&
			"当前 session 覆盖了默认推送目标，保存到全局后本 session 仍使用自己的目标";
		const consequence =
			this.host.adopted() === undefined
				? "保存后运行 /wecom-aibot connect 正式接入"
				: "保存不会断开当前接入；运行 /wecom-aibot connect 后改用新目标（会确认并清除当前 session 的排队任务和待发通知）";
		const ok = await this.ctx.ui.confirm(
			scope === "global" ? "设为全局默认推送目标？" : "设为当前 session 的默认推送目标？",
			[
				found(identity),
				sentences(replaced, shadowed),
				"wecom_send 和 /wecom-aibot test 省略目标时发到这里",
				consequence,
			].join("\n"),
		);
		if (!ok) {
			this.notify(sentences("未修改配置", `需要时运行 ${command(scope)}`));
			return;
		}
		this.save(
			scope,
			{ set: { defaultChatId: identity.chatId, defaultChatType: identity.chatType } },
			sameBotGuard(bot),
			allowlist,
		);
	}

	private bot(scope: ConfigScope | undefined): Connection | undefined {
		return connectionOf(scope === "global" ? mergeLayers(readLayer("global"), undefined) : this.config.read());
	}

	private allowlistNote(identity: ChatIdentity): string | undefined {
		const allowed = this.previous()?.allowedUserIds;
		if (allowed?.includes(identity.userid)) return undefined;
		return allowed?.length
			? `userid ${identity.userid} 不在 allowedUserIds 中：加入全局配置文件并运行 /wecom-aibot connect 后，才能给 pi 发任务`
			: sentences(
					"当前未配置 allowedUserIds：任何能给机器人发消息的人都能让 pi 执行任务",
					`建议在 ${this.file("global")} 中加入 "allowedUserIds": [${JSON.stringify(identity.userid)}]，然后运行 /wecom-aibot connect`,
				);
	}

	/** A save may be what repairs the files: when they cannot be read yet, the report only says it saved. */
	private previous(): Resolved | undefined {
		try {
			return this.config.read();
		} catch {
			return undefined;
		}
	}

	/** RPC and print modes list no themes: there the name is saved as given. */
	private piHasTheme(name: string): boolean {
		const themes = this.ctx.ui.getAllThemes();
		return !themes.length || themes.some((theme) => theme.name === name);
	}

	private layer(scope: ConfigScope): Layer | undefined {
		return scope === "global" ? readLayer("global") : this.config.layer();
	}

	private file(scope: ConfigScope): string {
		return layerFile(scope === "global" ? "global" : { session: this.config.sessionId });
	}

	private async firstRun(scope: ConfigScope): Promise<Edit | undefined> {
		const credentials = await this.askCredentials(undefined);
		if (!credentials) return undefined;
		// The target can be identified with the credentials just typed, so a wrong Secret shows at once.
		const target = await this.askTarget(scope, undefined, { skip: true, bot: credentials, unsaved: true });
		return target && { change: { set: { ...credentials, ...target.change.set } }, note: target.note };
	}

	private async chooseAndEdit(
		scope: ConfigScope,
		resolved: Resolved,
		layer: Layer | undefined,
	): Promise<Edit | undefined> {
		const overridden = (name: FieldName) => scope === "session" && layer?.[name] !== undefined;
		const { botId, secret, defaultChatId } = resolved.values;
		const plain = async (edit: Promise<LayerChange | undefined>): Promise<Edit | undefined> => {
			const change = await edit;
			return change && { change };
		};
		const edit = await this.choose<() => Promise<Edit | undefined>>(
			scope === "global" ? "编辑全局配置" : "编辑当前 session 的覆盖项",
			[
				[
					`机器人凭据：BotID ${describe(resolved, "botId")}，Secret ${display("secret", secret)}`,
					() => plain(this.editCredentials(botId, overridden("botId"))),
				],
				[
					`默认推送目标：${defaultChatId ? `${defaultChatId}，${describe(resolved, "defaultChatType")}` : "未设置"}`,
					() =>
						this.askTarget(scope, defaultChatId, { inherit: overridden("defaultChatId"), bot: this.bot(scope) }),
				],
				...SETTING_FIELDS.map((spec): [string, () => Promise<Edit | undefined>] => [
					`${spec.label}：${describe(resolved, spec.name)}`,
					() =>
						plain(
							spec.choices
								? this.editChoice(spec, resolved.values[spec.name], overridden(spec.name))
								: this.editTheme(spec, scope, resolved.values[spec.name], overridden(spec.name)),
						),
				]),
			],
		);
		return edit?.();
	}

	private async editCredentials(current: string | undefined, inherit: boolean): Promise<LayerChange | undefined> {
		const action = inherit
			? await this.choose<"enter" | LayerChange>("机器人凭据", [
					["重新输入 BotID 和 Secret", "enter"],
					["取消覆盖，继承全局凭据", { remove: fieldsWith("botId") }],
				])
			: "enter";
		if (action !== "enter") return action;
		const credentials = await this.askCredentials(current);
		return credentials && { set: credentials };
	}

	private async askCredentials(
		current: string | undefined,
	): Promise<Pick<ManagedFields, "botId" | "secret"> | undefined> {
		const typed = await this.ctx.ui.input(
			"企业微信 BotID",
			current ? `当前 ${mask(current)}；留空沿用` : "智能机器人 BotID",
		);
		if (typed === undefined) return undefined;
		const botId = typed.trim() || current;
		if (!botId) return undefined;
		const secret = (
			await this.ctx.ui.input("长连接 Secret", "智能机器人长连接专用 Secret；输入时会显示在屏幕上")
		)?.trim();
		return secret ? { botId, secret } : undefined;
	}

	/** `unsaved`: the bot's credentials are being typed now, so there is no saved bot to guard against. */
	private async askTarget(
		scope: ConfigScope,
		current: string | undefined,
		allow: { skip?: boolean; inherit?: boolean; bot?: Connection; unsaved?: boolean },
	): Promise<Edit | undefined> {
		const options: [string, () => Promise<Edit | "again" | undefined>][] = [];
		const { bot } = allow;
		if (bot)
			options.push([
				"发验证码识别",
				async () => {
					const identity = await this.host.identify(this.ctx, bot, WHOAMI_WAIT_SECONDS);
					if (!identity) return "again";
					return {
						change: { set: { defaultChatId: identity.chatId, defaultChatType: identity.chatType } },
						guard: allow.unsaved ? undefined : sameBotGuard(bot),
						note: [found(identity), this.allowlistNote(identity)].filter(Boolean).join("\n"),
					};
				},
			]);
		options.push(
			["手动填写单聊 userid", () => this.typeTarget(1)],
			["手动填写群聊 chatid", () => this.typeTarget(2)],
		);
		if (allow.inherit)
			options.push([
				"取消覆盖，继承全局默认目标",
				async () => ({ change: { remove: fieldsWith("defaultChatId") } }),
			]);
		if (allow.skip)
			options.push([
				`暂不设置（以后运行 /wecom-aibot config --scope ${scope} whoami 识别）`,
				async () => ({ change: { set: {} } }),
			]);
		const title = current ? `默认推送目标（当前 ${current}）` : "默认推送目标";
		for (;;) {
			const picked = await this.choose(title, options);
			const result = await picked?.();
			if (result !== "again") return result;
		}
	}

	private async typeTarget(chatType: 1 | 2): Promise<Edit | undefined> {
		const chatId = (
			await this.ctx.ui.input(
				chatType === 2 ? "群聊 chatid" : "单聊 userid",
				"原样保存；不清楚就按 Esc，之后运行 /wecom-aibot config whoami 识别",
			)
		)?.trim();
		if (!chatId) return undefined;
		const problem = chatIdProblem(chatId);
		if (problem) {
			this.notify(problem, "warning");
			return undefined;
		}
		return { change: { set: { defaultChatId: chatId, defaultChatType: chatType } } };
	}

	private editChoice(spec: ChoiceField, current: unknown, inherit: boolean): Promise<LayerChange | undefined> {
		const options = spec.choices.map((choice): [string, LayerChange] => [
			`${choice.value}：${choice.description}${choice.value === current ? "（当前）" : ""}`,
			{ set: { [spec.name]: choice.value } },
		]);
		if (inherit) options.push(["取消覆盖，重新继承全局值或内置默认值", { remove: [spec.name] }]);
		return this.choose(spec.label, options);
	}

	private editTheme(
		spec: ThemeField,
		scope: ConfigScope,
		current: string | undefined,
		inherit: boolean,
	): Promise<LayerChange | undefined> {
		const options = this.ctx.ui
			.getAllThemes()
			.map(({ name }): [string, LayerChange] => [
				`${name}${name === current ? "（当前）" : ""}`,
				{ set: { [spec.name]: name } },
			]);
		if (scope === "global")
			options.unshift([`跟随 pi 当前主题${current === undefined ? "（当前）" : ""}`, { remove: [spec.name] }]);
		if (inherit) options.push(["取消覆盖，重新继承全局值或跟随 pi 当前主题", { remove: [spec.name] }]);
		return this.choose(spec.label, options);
	}

	private async choose<T>(title: string, options: [label: string, value: T][]): Promise<T | undefined> {
		const picked = await this.ctx.ui.select(
			title,
			options.map(([label]) => label),
		);
		return options.find(([label]) => label === picked)?.[1];
	}

	private report(saved: string, scope: ConfigScope, change: LayerChange, before: Resolved, after: Resolved): string {
		const changes = FIELDS.filter(
			(spec) =>
				before.values[spec.name] !== after.values[spec.name] ||
				before.sources[spec.name] !== after.sources[spec.name],
		).map((spec) => {
			const from = describe(before, spec.name);
			const to = describe(after, spec.name);
			// A new Secret looks like the old one ("已配置"): say that it changed.
			return `${spec.name}：${from} → ${to === from ? "已更新" : to}`;
		});
		const lines = [changes.length ? `${saved}：${changes.join("；")}` : saved];
		const shadowed =
			scope === "global"
				? [...Object.keys(change.set ?? {}), ...(change.remove ?? [])].filter(
						(name) => after.sources[name as FieldName] === "session",
					)
				: [];
		if (shadowed.length)
			lines.push(
				`当前 session 覆盖了 ${shadowed.join("、")}，全局修改不影响本 session；需要跟随全局时运行 /wecom-aibot config --scope session unset ${shadowed[0]}`,
			);
		lines.push(this.conclusion(before, after));
		return lines.join("\n");
	}

	private conclusion(before: Resolved, after: Resolved): string {
		const settings = SETTING_FIELDS.some((spec) => before.values[spec.name] !== after.values[spec.name]);
		const connection = connectionKey(connectionOf(before)) !== connectionKey(connectionOf(after));
		const adopted = this.host.adopted();
		const pending = pendingReconnect(after, adopted);
		if (!settings && !connection)
			return pending
				? "当前 session 的合并结果不变；之前的修改仍待重新接入，运行 /wecom-aibot connect 后生效"
				: "当前 session 的合并结果不变，无需操作";
		const parts: string[] = [];
		if (settings) parts.push(adopted === undefined ? "通知设置下次使用时生效" : "通知设置已热更新");
		if (connection || pending)
			parts.push(
				adopted === undefined
					? "接入配置已保存；配置不等于接入，需要时运行 /wecom-aibot connect"
					: pending
						? "接入配置待重新接入：当前接入仍使用旧配置，运行 /wecom-aibot connect 后生效"
						: "接入配置与当前接入一致，无需重新接入",
			);
		return parts.join("；");
	}

	private notify(message: string, type: "info" | "warning" = "info"): void {
		this.ctx.ui.notify(message, type);
	}
}

function found(identity: ChatIdentity): string {
	return `已识别${identity.chatType === 2 ? "群聊" : "单聊"}：chatid=${identity.chatId}　chat_type=${identity.chatType}　userid=${identity.userid}`;
}

function sameBotGuard(bot: Pick<Connection, "botId" | "secret">): Guard {
	return (resolved) => {
		if (resolved.values.botId !== bot.botId || resolved.values.secret !== bot.secret)
			throw new Error("识别期间机器人配置已改变，默认推送目标未保存；请重新识别");
	};
}

const SOURCE: Record<Source, string> = { session: "session", global: "global", default: "内置默认值" };

/** All groups share one value column, measured in terminal cells so Chinese labels align. */
export function table(...groups: [string, string][][]): string[] {
	const shown = groups.filter((rows) => rows.length);
	const width = Math.max(0, ...shown.flat().map(([name]) => visibleWidth(name)));
	return shown.flatMap((rows, index) => [
		...(index ? [""] : []),
		...rows.map(([name, value]) => `  ${name}${" ".repeat(width - visibleWidth(name))}  ${value}`),
	]);
}

export function describe(resolved: Resolved, name: FieldName): string {
	const source = resolved.sources[name];
	return `${display(name, resolved.values[name])}${source ? `（${SOURCE[source]}）` : ""}`;
}

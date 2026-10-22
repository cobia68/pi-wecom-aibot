/**
 * `/wecom-aibot config`: show, edit, set and unset the global layer or the current session's overrides.
 * Saving never connects or disconnects: settings are read where they are used, and a change to the
 * credentials, the default target or the allowlist waits for `/wecom-aibot connect`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ConfigInvocation,
	type ConfigScope,
	configSubcommandLines,
	configSubcommands,
	subcommandUsage,
} from "./commands.ts";
import {
	type ChoiceField,
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
	patchLayer,
	type Resolved,
	readLayer,
	SETTING_FIELDS,
	type SessionConfig,
	type Source,
	type ThemeField,
} from "./config.ts";

/** What the command needs from the extension that owns the current session. */
export interface ConfigHost {
	/** The current session's configuration; throws before pi started a session. */
	config(): SessionConfig;
	/** The connection key the formal registration uses; undefined when this session is not connected. */
	adopted(): string | undefined;
	/** A save was reported: the owner updates its footer and need not announce it again. */
	changed(resolved: Resolved): void;
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

/** The registration waits for /wecom-aibot connect to adopt what the files now say. */
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
				return this.unset(invocation.remove);
		}
	}

	/**
	 * No action was given: nothing runs until one is chosen. A subcommand that needs values goes to the
	 * editor, to be completed (with completion) and submitted; Esc chooses nothing.
	 */
	private async chooseSubcommand(scope: ConfigScope | undefined): Promise<void> {
		const choices = configSubcommands(scope);
		if (!this.ctx.hasUI) {
			const example = `/wecom-aibot config ${subcommandUsage(choices[0])}`;
			const prefix = `/wecom-aibot config${scope ? ` ${scope}` : ""}`;
			this.notify([`${prefix} 需要写明子命令，例如 ${example}：`, ...configSubcommandLines(scope)].join("\n"));
			return;
		}
		const picked = await this.choose(
			scope === "global" ? "全局配置" : scope === "session" ? "当前 session 的覆盖项" : "企业微信配置",
			choices.map((item) => [`${subcommandUsage(item)} — ${item.description}`, item]),
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
					? "当前 session 未接入；配置齐全后运行 /wecom-aibot connect。"
					: "未配置：运行 /wecom-aibot config global edit 填写 BotID、Secret 和默认推送目标。"
				: pendingReconnect(resolved, adopted)
					? "待重新接入：当前接入仍使用旧配置，运行 /wecom-aibot connect 后生效。"
					: "当前接入与以上配置一致。";
		this.notify(
			[
				"当前 session 的企业微信配置（合并结果）：",
				...table(rows),
				state,
				"修改：/wecom-aibot config <session|global> set 字段=值 …，或 config <session|global> edit。",
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

	unset(fields: FieldName[]): void {
		const layer = this.layer("session");
		const present = fields.filter((name) => layer?.[name] !== undefined);
		if (present.length) this.save("session", { remove: present });
		else this.notify(`当前 session 没有覆盖 ${fields.join("、")}，无需修改。`);
	}

	/** Save one change to one layer, then say what it means for this session. */
	save(scope: ConfigScope, change: LayerChange): void {
		const theme = change.set?.screenshotTheme;
		if (theme !== undefined && !this.piHasTheme(theme)) {
			this.notify(
				`pi 中没有主题 ${theme}，未做任何修改；可用 /wecom-aibot config ${scope} edit 从 pi 的主题列表中选择。`,
				"warning",
			);
			return;
		}
		const before = this.previous();
		if (scope === "global") patchLayer("global", change);
		else this.config.patch(change);
		const after = this.config.read();
		this.host.changed(after);
		const saved = scope === "global" ? "已保存全局配置" : change.set ? "已保存 session 覆盖" : "已删除 session 覆盖";
		this.notify(before ? this.report(saved, scope, change, before, after) : `${saved}。`);
	}

	async edit(scope: ConfigScope): Promise<void> {
		if (!this.ctx.hasUI) {
			this.notify(
				`config ${scope} edit 需要交互界面；请使用 /wecom-aibot config ${scope} set 字段=值。凭据只能在交互界面输入，或直接编辑 ${this.file(scope)}。`,
				"warning",
			);
			return;
		}
		const resolved = this.config.read();
		const change = resolved.values.botId
			? await this.chooseAndEdit(scope, resolved, this.layer(scope))
			: await this.firstRun();
		if (change) this.save(scope, change);
		else this.notify("已取消，配置未修改。");
	}

	/**
	 * The merged result before a save, to report what the save changed. A save may be what repairs the
	 * files (a value mistyped by hand, say): when they cannot be read yet, the report only says it saved.
	 */
	private previous(): Resolved | undefined {
		try {
			return this.config.read();
		} catch {
			return undefined;
		}
	}

	/** Checked against pi's theme list. RPC and print list none: there the name is saved as given. */
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

	/** No credentials anywhere yet: BotID, Secret and the default target, saved together. */
	private async firstRun(): Promise<LayerChange | undefined> {
		const credentials = await this.askCredentials(undefined);
		if (!credentials) return undefined;
		const target = await this.askTarget(undefined, { skip: true });
		return target && { set: { ...credentials, ...target.set } };
	}

	private async chooseAndEdit(
		scope: ConfigScope,
		resolved: Resolved,
		layer: Layer | undefined,
	): Promise<LayerChange | undefined> {
		const overridden = (name: FieldName) => scope === "session" && layer?.[name] !== undefined;
		const { botId, secret, defaultChatId } = resolved.values;
		const edit = await this.choose<() => Promise<LayerChange | undefined>>(
			scope === "global" ? "编辑全局配置" : "编辑当前 session 的覆盖项",
			[
				[
					`机器人凭据：BotID ${describe(resolved, "botId")}，Secret ${display("secret", secret)}`,
					() => this.editCredentials(botId, overridden("botId")),
				],
				[
					`默认推送目标：${defaultChatId ? `${defaultChatId}，${describe(resolved, "defaultChatType")}` : "未设置"}`,
					() => this.askTarget(defaultChatId, { inherit: overridden("defaultChatId") }),
				],
				...SETTING_FIELDS.map((spec): [string, () => Promise<LayerChange | undefined>] => [
					`${spec.label}：${describe(resolved, spec.name)}`,
					() =>
						spec.choices
							? this.editChoice(spec, resolved.values[spec.name], overridden(spec.name))
							: this.editTheme(spec, scope, resolved.values[spec.name], overridden(spec.name)),
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

	/** Both or nothing: an empty BotID keeps the current one, an empty Secret or Esc cancels. */
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

	/** A userid or group chatid typed as is; `skip` keeps no target, `inherit` removes the session's override. */
	private async askTarget(
		current: string | undefined,
		allow: { skip?: boolean; inherit?: boolean },
	): Promise<LayerChange | undefined> {
		const options: [string, 1 | 2 | LayerChange][] = [
			["手动填写单聊 userid", 1],
			["手动填写群聊 chatid", 2],
		];
		if (allow.inherit) options.push(["取消覆盖，继承全局默认目标", { remove: fieldsWith("defaultChatId") }]);
		if (allow.skip) options.push(["暂不设置（以后运行 /wecom-aibot whoami 识别）", { set: {} }]);
		const picked = await this.choose(current ? `默认推送目标（当前 ${current}）` : "默认推送目标", options);
		// Esc, or a choice that is already the change.
		if (typeof picked !== "number") return picked;
		const chatId = (
			await this.ctx.ui.input(
				picked === 2 ? "群聊 chatid" : "单聊 userid",
				"原样保存；不清楚就按 Esc，之后运行 /wecom-aibot whoami 识别",
			)
		)?.trim();
		if (!chatId) return undefined;
		const problem = chatIdProblem(chatId);
		if (problem) {
			this.notify(problem, "warning");
			return undefined;
		}
		return { set: { defaultChatId: chatId, defaultChatType: picked } };
	}

	private editChoice(spec: ChoiceField, current: unknown, inherit: boolean): Promise<LayerChange | undefined> {
		const options = spec.choices.map((choice): [string, LayerChange] => [
			`${choice.value}：${choice.description}${choice.value === current ? "（当前）" : ""}`,
			{ set: { [spec.name]: choice.value } },
		]);
		if (inherit) options.push(["取消覆盖，重新继承全局值或内置默认值", { remove: [spec.name] }]);
		return this.choose(spec.label, options);
	}

	/** pi's own themes. The global layer can also follow pi's current theme; a session can drop its override. */
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

	/** One menu: the value paired with the chosen label, undefined on Esc. */
	private async choose<T>(title: string, options: [label: string, value: T][]): Promise<T | undefined> {
		const picked = await this.ctx.ui.select(
			title,
			options.map(([label]) => label),
		);
		return options.find(([label]) => label === picked)?.[1];
	}

	/** What the save changed in this session's merged result, and what that means for the registration. */
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
		const lines = [changes.length ? `${saved}：${changes.join("；")}。` : `${saved}。`];
		const shadowed =
			scope === "global"
				? Object.keys(change.set ?? {}).filter((name) => after.sources[name as FieldName] === "session")
				: [];
		if (shadowed.length)
			lines.push(
				`当前 session 覆盖了 ${shadowed.join("、")}，全局修改不影响本 session；需要跟随全局时运行 /wecom-aibot config session unset ${shadowed[0]}。`,
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
				? "当前 session 的合并结果不变；之前的修改仍待重新接入，运行 /wecom-aibot connect 后生效。"
				: "当前 session 的合并结果不变，无需操作。";
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
		return `${parts.join("；")}。`;
	}

	private notify(message: string, type: "info" | "warning" = "info"): void {
		this.ctx.ui.notify(message, type);
	}
}

const SOURCE: Record<Source, string> = { session: "session", global: "global", default: "内置默认值" };

/** `name  value` lines, the values in one column (field names are ASCII). */
function table(rows: [string, string][]): string[] {
	const width = Math.max(...rows.map(([name]) => name.length));
	return rows.map(([name, value]) => `  ${name.padEnd(width)}  ${value}`);
}

/** A merged field as shown: its value and the layer it came from. */
function describe(resolved: Resolved, name: FieldName): string {
	const source = resolved.sources[name];
	return `${display(name, resolved.values[name])}${source ? `（${SOURCE[source]}）` : ""}`;
}

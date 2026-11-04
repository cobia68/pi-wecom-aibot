/**
 * `/wecom-aibot config`: show, edit, set and unset the global layer, the working directory's or the current
 * session's overrides, and identify a chat with config whoami. Saving never connects or disconnects: settings
 * are read where they are used, and a change to the credentials, the default target or the allowlist waits for
 * `/wecom-aibot connect`.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_PROMPTS } from "../shared/control-card.ts";
import type { ChatIdentity } from "../shared/gateway-protocol.ts";
import { compareNames, errorMessage, sentences } from "../shared/text.ts";
import {
	type ConfigInvocation,
	type ConfigScope,
	columns,
	configSubcommandLines,
	configSubcommands,
	SCOPE_SLOT,
	subcommandUsage,
	table,
	WHOAMI_WAIT_SECONDS,
} from "./commands.ts";
import {
	addAllowedUser,
	applyPromptsEdit,
	type ChoiceField,
	type Connection,
	chatIdProblem,
	connectionKey,
	connectionOf,
	FIELDS,
	type FieldName,
	fieldsWith,
	LAYERS,
	type Layer,
	type LayerChange,
	layerFile,
	type ManagedFields,
	type PromptsEdit,
	type PromptsField,
	pendingReconnect,
	promptsProblem,
	type Resolved,
	readLayer,
	SETTING_FIELDS,
	type SessionConfig,
	type StartupField,
} from "./config.ts";
import { describe, display, maskBotId } from "./config-display.ts";
import { docUrlProblem } from "./doc-mcp.ts";

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

/** How each layer is named in the reports; a name ending in a Latin word carries its space before 的. */
const LAYER: Record<
	ConfigScope,
	{
		name: string;
		title: string;
		heading: string;
		empty: string;
		saved: string;
		removed: string;
		lacks: string;
		/** `target`: what the layer resolves to now; `none`: it has none. */
		target: string;
		none: string;
		/** The layers it inherits from, as an override's 取消覆盖 says them. */
		from: string;
	}
> = {
	global: {
		name: "全局",
		title: "全局配置",
		heading: "全局配置（显式保存的值）：",
		empty: "（未设置任何字段）",
		saved: "已保存全局配置",
		removed: "已删除全局字段",
		lacks: "全局配置没有",
		target: "全局默认",
		none: "当前没有全局默认推送目标",
		from: "",
	},
	project: {
		name: "当前目录",
		title: "当前目录的项目级配置",
		heading: "当前目录的项目级配置：",
		empty: "（无覆盖项，全部继承全局配置或内置默认值）",
		saved: "已保存项目级配置",
		removed: "已删除项目级配置的字段",
		lacks: "当前目录的项目级配置没有",
		target: "当前目录使用的目标",
		none: "当前目录还没有默认推送目标",
		from: "全局",
	},
	session: {
		name: "当前 session ",
		title: "当前 session 的覆盖项",
		heading: "当前 session 的覆盖项：",
		empty: "（无覆盖项，全部继承项目级、全局配置或内置默认值）",
		saved: "已保存 session 覆盖",
		removed: "已删除 session 覆盖",
		lacks: "当前 session 没有覆盖",
		target: "当前 session 使用的目标",
		none: "当前 session 还没有默认推送目标",
		from: "项目级或全局",
	},
};

/** The layers above `scope`: their values win over it. */
function above(scope: ConfigScope): readonly ConfigScope[] {
	return LAYERS.slice(LAYERS.indexOf(scope) + 1);
}

/** Every action reads the files first, so a file that cannot be used stops it before anything is written. */
export async function runConfig(ctx: ExtensionContext, invocation: ConfigInvocation, host: ConfigHost): Promise<void> {
	try {
		await new ConfigCommand(ctx, host.config(), host).run(invocation);
	} catch (error) {
		ctx.ui.notify(`企业微信配置无法使用：${errorMessage(error)}`, "error");
	}
}

class ConfigCommand {
	constructor(
		private readonly ctx: ExtensionContext,
		private readonly config: SessionConfig,
		private readonly host: ConfigHost,
	) {}

	async run(invocation: ConfigInvocation): Promise<void> {
		if (invocation.scope === "project") this.config.requireProjectTrust();
		switch (invocation.action) {
			case "choose":
				return this.chooseSubcommand(invocation.scope);
			case "show":
				return invocation.scope ? this.showLayer(invocation.scope) : this.showMerged();
			case "edit":
				return this.edit(invocation.scope);
			case "set":
				return invocation.prompts
					? this.editPromptList(invocation.scope, invocation.set, invocation.prompts)
					: this.save(invocation.scope, { set: invocation.set });
			case "unset":
				return this.unset(invocation.scope, invocation.remove);
			case "whoami":
				return this.whoami(invocation.scope, invocation.seconds);
		}
	}

	private async chooseSubcommand(scope: ConfigScope | undefined): Promise<void> {
		const choices = configSubcommands(scope);
		if (!this.ctx.hasUI) {
			// Alphabetical menus start with edit, but non-interactive users need a usable read-only example.
			const example = `/wecom-aibot config ${scope ? `--scope ${scope} ` : ""}show`;
			this.notify(
				[`/wecom-aibot config 需要写明动作，例如 ${example}：`, ...configSubcommandLines(scope)].join("\n"),
			);
			return;
		}
		const labels = columns(choices.map((item) => [subcommandUsage(item), item.description] as const));
		const picked = await this.choose(
			scope ? LAYER[scope].title : "企业微信配置",
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
			rows.push(["allowedUserIds", `${resolved.allowedUserIds.join("、")}（全局）`]);
		rows.sort(([a], [b]) => compareNames(a, b));
		const adopted = this.host.adopted();
		const state =
			adopted === undefined
				? resolved.values.botId
					? "当前 session 未接入；配置齐全后运行 /wecom-aibot connect"
					: "未配置：运行 /wecom-aibot config edit 填写 BotID、Secret 和默认推送目标"
				: pendingReconnect(resolved, adopted)
					? "待重新接入：当前接入仍使用旧配置，运行 /wecom-aibot connect 后生效"
					: "当前接入与以上配置一致";
		this.notify(
			[
				"当前 session 的企业微信配置（合并结果）：",
				...table(rows),
				state,
				`修改：/wecom-aibot config set 字段=值 …，或 config edit；不写 --scope 时改全局，只改一层时在动作前写 ${SCOPE_SLOT}`,
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
		rows.sort(([a], [b]) => compareNames(a, b));
		this.notify(
			[
				LAYER[scope].heading,
				...(rows.length ? table(rows) : [`  ${LAYER[scope].empty}`]),
				`文件：${this.file(scope)}`,
			].join("\n"),
		);
	}

	/**
	 * controlPrompts+= / -=: the list this layer uses now, changed. A project or session without its own list
	 * starts from the one it inherits and keeps the copy, independent of the layers below from then on.
	 */
	private editPromptList(scope: ConfigScope, set: Partial<ManagedFields>, edit: PromptsEdit): void {
		const own = this.layer(scope)?.controlPrompts;
		const current = own ?? this.config.below(scope).values.controlPrompts;
		const applied = applyPromptsEdit(current, edit);
		if ("problem" in applied) {
			this.notify(sentences(applied.problem, "未做任何修改"), "warning");
			return;
		}
		const skipped = applied.skipped.length
			? `${applied.skipped.map((prompt) => `「${prompt}」`).join("、")}${edit.op === "add" ? "已经在列表里" : "不在列表里"}，跳过`
			: undefined;
		const changed = applied.prompts.length !== current.length;
		if (!changed && !Object.keys(set).length) {
			this.notify(sentences(skipped, `controlPrompts 仍是 ${display("controlPrompts", current)}，无需修改`));
			return;
		}
		// An emptied list: the global layer drops the field, an override layer overrides with none, as in config edit.
		const change: LayerChange =
			changed && !applied.prompts.length && scope === "global"
				? { set, remove: ["controlPrompts"] }
				: { set: changed ? { ...set, controlPrompts: applied.prompts } : set };
		const copied =
			changed && scope !== "global" && own === undefined
				? sentences(
						current.length
							? `已把继承的 ${current.length} 条提示词复制到${LAYER[scope].name}再修改`
							: `${LAYER[scope].name}新建了自己的提示词列表`,
						`之后不再跟随继承来的列表，要重新继承时运行 /wecom-aibot config --scope ${scope} unset controlPrompts`,
					)
				: undefined;
		this.save(scope, change, undefined, [skipped, copied].filter(Boolean).join("\n") || undefined);
	}

	unset(scope: ConfigScope, fields: FieldName[]): void {
		const layer = this.layer(scope);
		const present = fields.filter((name) => layer?.[name] !== undefined);
		if (present.length) this.save(scope, { remove: present });
		else this.notify(`${LAYER[scope].lacks} ${fields.join("、")}，无需修改`);
	}

	/** One notice for the whole report: pi shows consecutive notices in place of each other. */
	save(scope: ConfigScope, change: LayerChange, guard?: Guard, note?: string): void {
		// A save may be what repairs the files: when they cannot be read yet, the report only says it saved. If
		// they still cannot be read after it, the read below throws.
		let before: Resolved | undefined;
		try {
			before = this.config.read();
		} catch {
			before = undefined;
		}
		this.config.patch(scope, change, guard && ((current) => guard(this.config.resolveWith(scope, current))));
		const after = this.config.read();
		this.host.changed(after);
		const saved = change.set ? LAYER[scope].saved : LAYER[scope].removed;
		this.notify([before ? this.report(saved, scope, change, before, after) : saved, note].filter(Boolean).join("\n"));
	}

	async edit(scope: ConfigScope): Promise<void> {
		if (!this.ctx.hasUI) {
			this.notify(
				sentences(
					`config edit 需要交互界面；请使用 /wecom-aibot config ${at(scope)}set 字段=值`,
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
					? "全局配置还没有 BotID 和 Secret；先运行 /wecom-aibot config edit"
					: "还没有配置 BotID 和 Secret；先运行 /wecom-aibot config edit",
				"warning",
			);
			return;
		}
		const identity = await this.host.identify(this.ctx, bot, seconds);
		if (!identity) return;
		const command = (layer: ConfigScope) =>
			`/wecom-aibot config ${at(layer)}set defaultChatId=${identity.chatId} defaultChatType=${identity.chatType}`;
		const allowlist = await this.offerAllowlist(identity);
		const report = (...lines: (string | false | undefined)[]) =>
			this.notify([found(identity), ...lines, allowlist].filter(Boolean).join("\n"));
		if (!scope) {
			report(
				`设为全局默认推送目标：${command("global")}；只设给当前目录或当前 session 时在 set 前写 --scope project 或 --scope session`,
			);
			return;
		}
		const layer = this.layer(scope);
		if (layer?.defaultChatId === identity.chatId && (layer.defaultChatType ?? 1) === identity.chatType) {
			report(`这已经是${LAYER[scope].name}的默认推送目标，配置未改动`);
			return;
		}
		if (!this.ctx.hasUI) {
			report(sentences("没有交互界面，未保存", `需要时运行 ${command(scope)}`));
			return;
		}
		const resolved = this.config.read();
		const current = this.config.upTo(scope).values;
		const replaced = current.defaultChatId
			? `将替换${LAYER[scope].target}：${current.defaultChatId}（${current.defaultChatType === 2 ? "群聊" : "单聊"}）`
			: LAYER[scope].none;
		const holder = resolved.sources.defaultChatId;
		const shadowed =
			holder !== undefined &&
			holder !== "default" &&
			above(scope).includes(holder) &&
			`${LAYER[holder].name}覆盖了默认推送目标，保存到${LAYER[scope].name}后当前 session 仍使用${LAYER[holder].name}的目标`;
		const consequence =
			this.host.adopted() === undefined
				? "保存后运行 /wecom-aibot connect 正式接入"
				: "保存不会断开当前接入；运行 /wecom-aibot connect 后改用新目标（会确认并清除当前 session 的排队任务和待发通知）";
		const ok = await this.ctx.ui.confirm(
			`设为${LAYER[scope].name}的默认推送目标？`,
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

	/** The bot a layer's whoami listens with: what the layers up to it resolve to. */
	private bot(scope: ConfigScope | undefined): Connection | undefined {
		return connectionOf(scope === undefined || scope === "session" ? this.config.read() : this.config.upTo(scope));
	}

	/**
	 * whoami found someone the allowlist leaves out: offer to add them to the global file. Without an allowlist
	 * anyone may send tasks, so starting one for a single person is left to a hand edit.
	 */
	private async offerAllowlist(identity: ChatIdentity): Promise<string | undefined> {
		const allowlist = readAllowlist();
		if ("problem" in allowlist || !allowlist.ids.length || allowlist.ids.includes(identity.userid) || !this.ctx.hasUI)
			return this.allowlistNote(identity, allowlist);
		const ok = await this.ctx.ui.confirm(
			`把 ${identity.userid} 加入 allowedUserIds？`,
			`写进全局配置 ${this.file("global")}；运行 /wecom-aibot connect 后，这个人才能给 pi 发任务`,
		);
		if (!ok) return this.allowlistNote(identity, allowlist);
		try {
			addAllowedUser(identity.userid);
		} catch (error) {
			return `没有加入 allowedUserIds：${errorMessage(error)}`;
		}
		const added = `已把 ${identity.userid} 加入 allowedUserIds；运行 /wecom-aibot connect 后生效`;
		let resolved: Resolved;
		try {
			resolved = this.config.read();
		} catch (error) {
			return sentences(added, `但配置现在无法读取：${errorMessage(error)}`);
		}
		this.host.changed(resolved);
		return added;
	}

	/** An unreadable allowlist is said so, never taken for none: none would invite anyone in. */
	private allowlistNote(identity: ChatIdentity, allowlist = readAllowlist()): string | undefined {
		if ("problem" in allowlist) return `无法确认 allowedUserIds：${allowlist.problem}`;
		if (allowlist.ids.includes(identity.userid)) return undefined;
		return allowlist.ids.length
			? `userid ${identity.userid} 不在 allowedUserIds 中：加入全局配置文件并运行 /wecom-aibot connect 后，才能给 pi 发任务`
			: sentences(
					"当前未配置 allowedUserIds：任何能给机器人发消息的人都能让 pi 执行任务",
					`建议在 ${this.file("global")} 中加入 "allowedUserIds": [${JSON.stringify(identity.userid)}]，然后运行 /wecom-aibot connect`,
				);
	}

	private layer(scope: ConfigScope): Layer | undefined {
		return this.config.layer(scope);
	}

	private file(scope: ConfigScope): string {
		return layerFile(this.config.scope(scope));
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
		const overridden = (name: FieldName) => scope !== "global" && layer?.[name] !== undefined;
		const { botId, secret, defaultChatId } = resolved.values;
		const plain = async (edit: Promise<LayerChange | undefined>): Promise<Edit | undefined> => {
			const change = await edit;
			return change && { change };
		};
		type Item = [name: FieldName, label: string, edit: () => Promise<Edit | undefined>];
		const items: Item[] = [
			[
				"botId",
				`机器人凭据：BotID ${describe(resolved, "botId")}，Secret ${display("secret", secret)}`,
				() => plain(this.editCredentials(botId, overridden("botId") && LAYER[scope].from)),
			],
			[
				"defaultChatId",
				`默认推送目标：${defaultChatId ? `${defaultChatId}，${describe(resolved, "defaultChatType")}` : "未设置"}`,
				() =>
					this.askTarget(scope, defaultChatId, {
						inherit: overridden("defaultChatId") && LAYER[scope].from,
						bot: this.bot(scope),
					}),
			],
			...FIELDS.filter((spec) => spec.effect === "setting" || spec.effect === "startup").map(
				(spec): Item => [
					spec.name,
					`${spec.label}：${describe(resolved, spec.name)}`,
					() =>
						plain(
							spec.name === "controlPrompts"
								? this.editPrompts(
										spec,
										scope,
										resolved.values.controlPrompts,
										overridden(spec.name) && LAYER[scope].from,
									)
								: this.editChoice(spec, resolved.values[spec.name], overridden(spec.name) && LAYER[scope].from),
						),
				],
			),
			// The document belongs to the bot, not to a session: it is global only.
			...(scope === "global"
				? [
						[
							"docMcpUrl",
							`会话文档：${display("docMcpUrl", resolved.values.docMcpUrl)}`,
							() => plain(this.editDocument(resolved.values.docMcpUrl !== undefined)),
						] as Item,
					]
				: []),
		];
		// Sort groups by their first field, without splitting credential or target editing into separate steps.
		const edit = await this.choose(
			`编辑${LAYER[scope].title}`,
			items.sort(([a], [b]) => compareNames(a, b)).map(([, label, run]) => [label, run]),
		);
		return edit?.();
	}

	/** The address is shown nowhere: it is typed fresh or removed. */
	private async editDocument(configured: boolean): Promise<LayerChange | undefined> {
		const action = configured
			? await this.choose<"enter" | LayerChange>("会话文档", [
					["重新输入地址", "enter"],
					["删除地址（linked 将提示未配置文档）", { remove: ["docMcpUrl"] }],
				])
			: "enter";
		if (action !== "enter") return action;
		const typed = (
			await this.ctx.ui.input(
				"会话文档地址",
				"工作台 → 智能机器人 → 编辑 → 可使用权限 → 授权后「查看使用方式」里的 streamableHTTP URL；含 apikey，输入时会显示在屏幕上",
			)
		)?.trim();
		if (!typed) return undefined;
		const problem = docUrlProblem(typed);
		if (problem) {
			this.notify(problem, "warning");
			return undefined;
		}
		return { set: { docMcpUrl: typed } };
	}

	/** `inherit`: this layer overrides the field; the layers it would inherit from, as 取消覆盖 says them. */
	private async editCredentials(
		current: string | undefined,
		inherit: string | false,
	): Promise<LayerChange | undefined> {
		const action = inherit
			? await this.choose<"enter" | LayerChange>("机器人凭据", [
					["重新输入 BotID 和 Secret", "enter"],
					[`取消覆盖，继承${inherit}凭据`, { remove: fieldsWith("botId") }],
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
			current ? `当前 ${maskBotId(current)}；留空沿用` : "智能机器人 BotID",
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
		allow: { skip?: boolean; inherit?: string | false; bot?: Connection; unsaved?: boolean },
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
				`取消覆盖，继承${allow.inherit}默认目标`,
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

	private editChoice(
		spec: ChoiceField | StartupField,
		current: unknown,
		inherit: string | false,
	): Promise<LayerChange | undefined> {
		const options = spec.choices.map((choice): [string, LayerChange] => [
			`${choice.value}：${choice.description}${choice.value === current ? "（当前）" : ""}`,
			{ set: { [spec.name]: choice.value } },
		]);
		if (inherit) options.push([`取消覆盖，重新继承${inherit}值或内置默认值`, { remove: [spec.name] }]);
		return this.choose(spec.label, options);
	}

	/**
	 * One prompt per line, in the dropdown's order. Esc saves nothing; an emptied editor means no prompts: the
	 * global layer drops the field (there is no default to fall back on), an override layer overrides with none.
	 */
	private async editPrompts(
		spec: PromptsField,
		scope: ConfigScope,
		current: readonly string[],
		inherit: string | false,
	): Promise<LayerChange | undefined> {
		if (inherit) {
			const action = await this.choose<"write" | LayerChange>(spec.label, [
				["编辑提示词（一行一条）", "write"],
				[`取消覆盖，重新继承${inherit}值`, { remove: [spec.name] }],
			]);
			if (action !== "write") return action;
		}
		const typed = await this.ctx.ui.editor(
			`${spec.label}：一行一条，最多 ${MAX_PROMPTS} 条，按顺序显示在下拉框里；下拉框只显示前 10 个字；清空即为没有提示词`,
			current.join("\n"),
		);
		if (typed === undefined) return undefined;
		const prompts = typed
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (!prompts.length) return scope === "global" ? { remove: [spec.name] } : { set: { [spec.name]: [] } };
		const problem = promptsProblem(prompts);
		if (problem) {
			this.notify(`${spec.name} ${problem}，未做任何修改`, "warning");
			return undefined;
		}
		return { set: { [spec.name]: prompts } };
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
				!same(before.values[spec.name], after.values[spec.name]) ||
				before.sources[spec.name] !== after.sources[spec.name],
		).map((spec) => {
			const from = describe(before, spec.name);
			const to = describe(after, spec.name);
			// A new Secret looks like the old one ("已配置"): say that it changed.
			return `${spec.name}：${from} → ${to === from ? "已更新" : to}`;
		});
		const lines = [changes.length ? `${saved}：${changes.join("；")}` : saved];
		const touched = [...Object.keys(change.set ?? {}), ...(change.remove ?? [])] as FieldName[];
		// A layer above this one still holds the field: the change does not reach this session.
		for (const holder of above(scope)) {
			const shadowed = touched.filter((name) => after.sources[name] === holder);
			if (shadowed.length)
				lines.push(
					`${LAYER[holder].name}覆盖了 ${shadowed.join("、")}，${LAYER[scope].name}的修改不影响当前 session；需要跟随时运行 /wecom-aibot config --scope ${holder} unset ${shadowed.join(" ")}`,
				);
		}
		lines.push(this.conclusion(before, after));
		return lines.join("\n");
	}

	private conclusion(before: Resolved, after: Resolved): string {
		const startup = before.values.autoConnect !== after.values.autoConnect;
		const settings = SETTING_FIELDS.some((spec) => !same(before.values[spec.name], after.values[spec.name]));
		const document = before.values.docMcpUrl !== after.values.docMcpUrl;
		const connection = connectionKey(connectionOf(before)) !== connectionKey(connectionOf(after));
		const adopted = this.host.adopted();
		const pending = pendingReconnect(after, adopted);
		if (!startup && !settings && !document && !connection)
			return pending
				? "当前 session 的合并结果不变；之前的修改仍待重新接入，运行 /wecom-aibot connect 后生效"
				: "当前 session 的合并结果不变，无需操作";
		const parts: string[] = [];
		if (startup) parts.push("autoConnect 在下次会话启动（含 /reload）时生效；当前接入状态不变");
		if (settings) parts.push(adopted === undefined ? "设置下次使用时生效" : "设置已热更新");
		if (document) parts.push("会话文档地址在下次发卡或点「刷新卡片」时生效");
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

/** The target as a command writes it: none for the global layer, which a write without one changes. */
function at(scope: ConfigScope): string {
	return scope === "global" ? "" : `--scope ${scope} `;
}

/** Values read from two files: a list compares by its items, not by identity. */
function same(a: unknown, b: unknown): boolean {
	return a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));
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

/** The global allowlist as its file holds it now; none at all is the empty list, both admit everyone. */
type Allowlist = { ids: readonly string[] } | { problem: string };

function readAllowlist(): Allowlist {
	try {
		return { ids: readLayer("global")?.allowedUserIds ?? [] };
	} catch (error) {
		return { problem: errorMessage(error) };
	}
}

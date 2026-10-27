/** 切换模型's models: their order, their labels, and the pages of ten WeCom's dropdown shows them in. */
import { createHash } from "node:crypto";
import { clamp } from "../shared/card.ts";
import { MODEL_OPTION_TEXT } from "../shared/control-card.ts";

/** WeCom's dropdown takes ten options. */
const MODEL_PAGE = 10;
const NAME_KEPT = 12;

export interface ModelChoice {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelOption {
	id: string;
	text: string;
	model: ModelChoice;
}

export interface ModelOptions {
	options: ModelOption[];
	selected?: string;
}

type ModelRef = Pick<ModelChoice, "provider" | "id">;

/**
 * The one in use first, then the others with its name, then each name in pi's order with its models. A name
 * several providers serve shows the provider, without the leading parts they all share.
 */
export function modelOptions(models: readonly ModelChoice[], current?: ModelRef): ModelOptions {
	const same = (model: ModelRef) => !!current && model.provider === current.provider && model.id === current.id;
	const label = (model: ModelChoice) => model.name || model.id;
	const groups = new Map<string, ModelChoice[]>();
	const inUse = models.find(same);
	if (inUse) groups.set(label(inUse), []);
	for (const model of models) {
		const group = groups.get(label(model));
		if (group) group.push(model);
		else groups.set(label(model), [model]);
	}
	const options = [...groups.values()]
		.flatMap((group) => [...group.filter(same), ...group.filter((model) => !same(model))])
		.map((model) => {
			const group = groups.get(label(model)) ?? [];
			return {
				id: `m-${createHash("sha256").update(`${model.provider}\n${model.id}`).digest("hex").slice(0, 16)}`,
				text:
					group.length > 1
						? servedBy(label(model), relayName(model.provider, group))
						: clamp(label(model), MODEL_OPTION_TEXT),
				model,
			};
		});
	const selected = options.find((option) => same(option.model))?.id;
	return { options, ...(selected ? { selected } : {}) };
}

/** One page, clamped. Off the page of the model in use nothing is selected, so WeCom shows the first. */
export function modelPage(all: ModelOptions, page = 0): ModelOptions & { page: number; pages: number } {
	const pages = Math.max(1, Math.ceil(all.options.length / MODEL_PAGE));
	const shown = Math.min(pages - 1, Math.max(0, Math.trunc(page) || 0));
	const options = all.options.slice(shown * MODEL_PAGE, (shown + 1) * MODEL_PAGE);
	const selected = options.find((option) => option.id === all.selected)?.id;
	return { options, ...(selected ? { selected } : {}), page: shown, pages };
}

/** welfare-agentrouter-fbw among welfare-* relays is agentrouter-fbw. */
function relayName(provider: string, group: readonly ModelChoice[]): string {
	const parts = group.map((model) => model.provider.split("-"));
	let common = 0;
	while (parts.every((part) => part.length > common + 1 && part[common] === parts[0][common])) common += 1;
	return provider.split("-").slice(common).join("-") || provider;
}

/** 「name · provider」: the provider tells them apart, so the name is cut first, down to NAME_KEPT. */
function servedBy(name: string, provider: string): string {
	const room = MODEL_OPTION_TEXT - 3;
	const length = [...name].length;
	const nameRoom = Math.max(Math.min(length, NAME_KEPT), room - [...provider].length);
	return `${clamp(name, nameRoom)} · ${clamp(provider, room - Math.min(nameRoom, length))}`;
}

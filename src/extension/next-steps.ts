/**
 * Next steps a reply offers as the prompts of the card it is published on: one hidden comment, normally at the
 * reply's end, <!-- wecom_next ["运行测试", "提交改动"] -->. Nothing sent to WeCom carries it; pi's terminal does.
 */
import { MAX_PROMPT_LENGTH, MAX_PROMPTS } from "../shared/control-card.ts";

const MARKER = /<!--\s*wecom_next\b([\s\S]*?)-->/g;
/** A comment the terminal wrapped over more lines than this is not followed further. */
const MAX_WRAPPED_LINES = 4;

/** The reply without the comment, and its steps: the last comment wins; a malformed one offers none. */
export function splitNextSteps(text: string): { text: string; steps: string[] } {
	let payload: string | undefined;
	const rest = text.replace(MARKER, (_comment, inner: string) => {
		payload = inner;
		return "";
	});
	if (payload === undefined) return { text, steps: [] };
	return { text: rest.trim(), steps: parseSteps(payload) };
}

export function withoutNextSteps(text: string): string {
	return splitNextSteps(text).text;
}

/** The card's quote is the terminal's last lines: the comment's lines, as pi drew them, are left out. */
export function withoutNextStepLines(lines: readonly string[]): string[] {
	const kept: string[] = [];
	let inside = 0;
	for (const line of lines) {
		if (!inside && line.includes("wecom_next")) inside = 1;
		if (!inside) {
			kept.push(line);
			continue;
		}
		inside = line.includes("-->") || inside >= MAX_WRAPPED_LINES ? 0 : inside + 1;
	}
	return kept;
}

function parseSteps(payload: string): string[] {
	let value: unknown;
	try {
		value = JSON.parse(payload.trim());
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const steps: string[] = [];
	for (const item of value) {
		const step = typeof item === "string" ? item.trim() : "";
		if (!step || [...step].length > MAX_PROMPT_LENGTH || steps.includes(step)) continue;
		steps.push(step);
		if (steps.length >= MAX_PROMPTS) break;
	}
	return steps;
}

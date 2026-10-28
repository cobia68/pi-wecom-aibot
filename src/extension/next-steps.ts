/**
 * Next steps a reply offers as the prompts of the card it is published on: one hidden comment, normally at the
 * reply's end, <!-- wecom_next ["运行测试", "提交改动"] -->. Nothing sent to WeCom carries it; pi's terminal does.
 */
import { MAX_PROMPT_LENGTH, MAX_PROMPTS } from "../shared/control-card.ts";
import { errorMessage } from "../shared/text.ts";

const MARKER = /<!--\s*wecom_next\b([\s\S]*?)-->/g;
/** A comment the terminal wrapped over more lines than this is not followed further. */
const MAX_WRAPPED_LINES = 4;

export interface NextSteps {
	text: string;
	steps: string[];
	/** Why the comment offered fewer steps than it wrote; the comment is taken out all the same. */
	problem?: string;
}

/** The reply without the comment, and its steps: the last comment wins; a malformed one offers none, and says why. */
export function splitNextSteps(text: string): NextSteps {
	let payload: string | undefined;
	const rest = text.replace(MARKER, (_comment, inner: string) => {
		payload = inner;
		return "";
	});
	if (payload === undefined) return { text, steps: [] };
	return { text: rest.trim(), ...parseSteps(payload) };
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

/** Empty and repeated steps are left out quietly; anything else left out is a problem. */
function parseSteps(payload: string): { steps: string[]; problem?: string } {
	let value: unknown;
	try {
		value = JSON.parse(payload.trim());
	} catch (error) {
		return { steps: [], problem: `wecom_next 不是有效的 JSON：${errorMessage(error)}` };
	}
	if (!Array.isArray(value)) return { steps: [], problem: "wecom_next 应是字符串数组" };
	const steps: string[] = [];
	let dropped = 0;
	for (const item of value) {
		if (typeof item !== "string") {
			dropped++;
			continue;
		}
		const step = item.trim();
		if (!step || steps.includes(step)) continue;
		if ([...step].length > MAX_PROMPT_LENGTH || steps.length >= MAX_PROMPTS) dropped++;
		else steps.push(step);
	}
	return dropped
		? {
				steps,
				problem: `wecom_next 有 ${dropped} 项未采用：只取字符串，每项最多 ${MAX_PROMPT_LENGTH} 字，最多 ${MAX_PROMPTS} 项`,
			}
		: { steps };
}

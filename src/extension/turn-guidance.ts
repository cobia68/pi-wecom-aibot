/**
 * What a run is told when WeCom will read its answer. The section is set for that run and removed from every
 * other: pi keeps prompt sections from one run to the next.
 */
import type { ContentDisplay } from "./config.ts";

export const WECOM_SECTION = "wecom";

/** message: a WeCom message's task; card: a control card's prompt; local: a terminal run reported to WeCom. */
export type TurnOrigin = "message" | "card" | "local";

const READ =
	"It is read on a phone: lead with the conclusion, put the essential result in the first three short non-empty lines, and avoid wide tables.";
const DISPLAY: Record<ContentDisplay, string> = {
	linked:
		"The answer is written to this session's document page in Markdown. If the page cannot be written in time, the card falls back to a plain-text quote of the answer's opening (only three lines visible on a phone).",
	inline:
		"The card shows the answer's opening in its plain-text quote, not a document page or a separate Markdown message. Only three lines are visible on a phone; Markdown formatting is removed and code blocks become [代码].",
};
const SECRETS = "Never write secrets, tokens or the document address into it.";
const NEXT =
	'To offer next steps on that card, end the answer with one hidden comment such as <!-- wecom_next ["运行测试", "提交改动"] -->: at most 10 prompts; the card shows the first 10 characters of each and sends the chosen one whole.';

const OPENING: Record<TurnOrigin, string> = {
	message:
		"This turn is a task sent from WeCom (企业微信). Your final answer is published to that chat as this session's card. Do not call wecom_send for it.",
	card: "This turn was started from a WeCom (企业微信) control card. Your final answer is published to that chat as a card.",
	local: "This session is connected to WeCom (企业微信): when this run ends, its final answer is published to the default chat as a card.",
};

export function turnGuidance(origin: TurnOrigin | undefined, display: ContentDisplay = "inline"): string | undefined {
	return origin && [OPENING[origin], DISPLAY[display], READ, SECRETS, NEXT].join("\n");
}

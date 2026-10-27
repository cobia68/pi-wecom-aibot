/**
 * What a run is told when WeCom will read its answer. The section is set for that run and removed from every
 * other: pi keeps prompt sections from one run to the next.
 */
export const WECOM_SECTION = "wecom";

/** message: a WeCom message's task; card: a control card's prompt; local: a terminal run reported to WeCom. */
export type TurnOrigin = "message" | "card" | "local";

const READ = "It is read on a phone, in WeCom's Markdown: lead with the conclusion, keep it short, avoid wide tables.";
const SECRETS = "Never write secrets, tokens or the document address into it.";
const NEXT =
	'To offer next steps on that card, end the answer with one hidden comment such as <!-- wecom_next ["运行测试", "提交改动"] -->: at most 10 prompts; the card shows the first 10 characters of each and sends the chosen one whole.';

const OPENING: Record<TurnOrigin, string> = {
	message:
		"This turn is a task sent from WeCom (企业微信). Your final answer is published to that chat as this session's card; its page shows the answer whole. Do not call wecom_send for it.",
	card: "This turn was started from a WeCom (企业微信) control card. Your final answer is published to that chat as a card; its page shows the answer whole.",
	local: "This session is connected to WeCom (企业微信): when this run ends, its final answer is published to the default chat as a card.",
};

export function turnGuidance(origin: TurnOrigin | undefined): string | undefined {
	return origin && [OPENING[origin], READ, SECRETS, NEXT].join("\n");
}

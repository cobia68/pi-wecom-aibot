/**
 * Text both sides write. Chinese UI text: a paragraph never ends in a full stop; the sentences inside one keep
 * theirs.
 */

/** The non-empty sentences joined with 。 and none at the end, so composed text follows the rule too. */
export function sentences(...parts: (string | false | null | undefined)[]): string {
	return parts
		.map((part) => (part ? part.trim().replace(/。+$/, "") : ""))
		.filter(Boolean)
		.join("。");
}

/** What a caught value says: an Error's message, anything else as text. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

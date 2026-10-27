import type { AutocompleteProvider } from "@earendil-works/pi-tui";

/** The cursor is in /wecom-aibot's arguments. pi reads only the first line as a command, ending its name at a space. */
export function isArgumentTab(lines: string[], cursorLine: number, cursorCol: number): boolean {
	return cursorLine === 0 && /^\/wecom-aibot /.test((lines[0] ?? "").slice(0, cursorCol).trimStart());
}

/**
 * pi turns Tab in an argument into forced file completion. /wecom-aibot takes no files, so its arguments are
 * completed by the command alone; pi's own trigger check would also drop Tab right after "/wecom-aibot ".
 */
export function argumentTabCompletion(current: AutocompleteProvider): AutocompleteProvider {
	return {
		getSuggestions: (lines, cursorLine, cursorCol, options) =>
			current.getSuggestions(lines, cursorLine, cursorCol, {
				...options,
				force: options.force && !isArgumentTab(lines, cursorLine, cursorCol),
			}),
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
			isArgumentTab(lines, cursorLine, cursorCol) ||
			(current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true),
		...(current.triggerCharacters && { triggerCharacters: current.triggerCharacters }),
	};
}

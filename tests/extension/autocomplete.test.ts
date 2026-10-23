/** Tab inside /wecom-aibot arguments: the command's own completions, not the cwd's files. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	Editor,
	type TUI,
} from "@earendil-works/pi-tui";
import { isWecomArgumentTab, wecomTabCompletion } from "../../src/extension/autocomplete.ts";
import { completeWecom } from "../../src/extension/commands.ts";

/** A provider that records how the wrapper calls it and answers with one fixed result. */
function recorder(result: AutocompleteSuggestions | null): {
	provider: AutocompleteProvider;
	forces: (boolean | undefined)[];
} {
	const forces: (boolean | undefined)[] = [];
	const provider: AutocompleteProvider = {
		getSuggestions: (_lines, _cursorLine, _cursorCol, options) => {
			forces.push(options.force);
			return Promise.resolve(result);
		},
		applyCompletion: (lines, cursorLine, cursorCol, item) => ({
			lines,
			cursorLine,
			cursorCol: cursorCol + item.value.length,
		}),
	};
	return { provider, forces };
}

function values(suggestions: AutocompleteSuggestions | null): string[] {
	return suggestions ? suggestions.items.map((item) => item.value) : [];
}

const cwd = mkdtempSync(join(tmpdir(), "wecom-tab-"));
mkdirSync(join(cwd, "tests"));
after(() => rmSync(cwd, { recursive: true, force: true }));

/** pi's real provider with /wecom-aibot behind it, over a cwd whose only entry is tests/. */
function realProvider(): AutocompleteProvider {
	return new CombinedAutocompleteProvider(
		[{ name: "wecom-aibot", description: "", getArgumentCompletions: (prefix) => completeWecom(prefix, () => []) }],
		cwd,
	);
}

/** Types `text` into pi's real editor and presses Tab, so the editor's own trigger check and auto-apply run too. */
async function pressTab(text: string, times = 1): Promise<{ text: string; listed: boolean; rendered: string }> {
	const id = (s: string) => s;
	const editor = new Editor({ requestRender() {}, terminal: { rows: 40 } } as unknown as TUI, {
		borderColor: id,
		selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
	});
	editor.setAutocompleteProvider(wecomTabCompletion(realProvider()));
	editor.setText(text);
	for (let i = 0; i < times; i++) {
		editor.handleInput("\t");
		await tick();
	}
	return { text: editor.getText(), listed: editor.isShowingAutocomplete(), rendered: editor.render(120).join("\n") };
}

test("only a completed /wecom-aibot command name on the first line opens the argument context", () => {
	const isTab = (text: string) => isWecomArgumentTab([text], 0, text.length);
	assert.equal(isTab("/wecom-aibot "), true);
	assert.equal(isTab("/wecom-aibot c"), true);
	assert.equal(isTab("  /wecom-aibot config "), true);
	assert.equal(isTab("/wecom-aibot"), false);
	assert.equal(isTab("/wecom-aibot\tstatus"), false, "pi ends a command name only at a space");
	assert.equal(isTab("/wecom-aib "), false);
	assert.equal(isTab("/wecom-aibotx "), false);
	assert.equal(isTab("/wecom-aibot:sub "), false);
	assert.equal(isTab(""), false);
	assert.equal(
		isWecomArgumentTab(["note", "/wecom-aibot "], 1, 13),
		false,
		"pi reads only the first line as a command",
	);
});

test("Tab after the command name lists subcommands instead of files", async () => {
	const top = await pressTab("/wecom-aibot ");
	assert.equal(top.text, "/wecom-aibot ");
	assert.equal(top.listed, true);
	const provider = wecomTabCompletion(realProvider());
	const text = "/wecom-aibot ";
	const suggestions = await provider.getSuggestions([text], 0, text.length, {
		signal: new AbortController().signal,
		force: true,
	});
	assert.deepEqual(suggestions, { items: completeWecom("", () => []), prefix: "" });
});

test("Tab keeps completing deeper argument levels", async () => {
	const provider = wecomTabCompletion(realProvider());
	const text = "/wecom-aibot config s";
	const suggestions = await provider.getSuggestions([text], 0, text.length, {
		signal: new AbortController().signal,
		force: true,
	});
	assert.deepEqual(values(suggestions), ["config show ", "config set "]);
});

test("a chosen word that can be followed gets its space, so the next Tab goes a level deeper", async () => {
	// One match is applied by the first Tab; the second lists config's actions and options.
	assert.equal((await pressTab("/wecom-aibot conf")).text, "/wecom-aibot config ");
	const deeper = await pressTab("/wecom-aibot conf", 2);
	assert.equal(deeper.text, "/wecom-aibot config ");
	assert.equal(deeper.listed, true);
	assert.match(deeper.rendered, /→ show /);
	assert.match(deeper.rendered, /\(1\/7\)/, "five actions, --scope and --help");
	// Two matches: the first Tab lists them, the second applies the selected one with its space.
	assert.equal((await pressTab("/wecom-aibot c", 2)).text, "/wecom-aibot config ");
	assert.equal((await pressTab("/wecom-aibot config sh", 2)).text, "/wecom-aibot config show ");
	// --help ends the command, so it gets no space.
	assert.equal((await pressTab("/wecom-aibot --h")).text, "/wecom-aibot --help");
	assert.equal((await pressTab("/wecom-aibot status ")).text, "/wecom-aibot status --help");
});

test("the wrapper drops force only inside the argument context", async () => {
	const { provider: current, forces } = recorder({ items: [{ value: "status", label: "status" }], prefix: "" });
	const provider = wecomTabCompletion(current);

	await provider.getSuggestions(["/wecom-aibot "], 0, 13, { signal: new AbortController().signal, force: true });
	await provider.getSuggestions(["/wecom-aib"], 0, 10, { signal: new AbortController().signal, force: true });
	await provider.getSuggestions(["/wecom-aibot "], 0, 13, { signal: new AbortController().signal, force: false });

	assert.deepEqual(forces, [false, true, false]);
});

test("Tab after a complete argument completes nothing, even when a file matches", async () => {
	const done = await pressTab("/wecom-aibot test");
	assert.equal(done.text, "/wecom-aibot test");
	assert.equal(done.listed, false);
	const options = await pressTab("/wecom-aibot test ");
	assert.equal(options.text, "/wecom-aibot test ");
	assert.equal(options.listed, true);
	assert.match(options.rendered, /--chat-type/);
	assert.doesNotMatch(options.rendered, /tests\//);
});

test("Tab elsewhere keeps pi's file completion", async () => {
	assert.equal((await pressTab("see tes")).text, "see tests/");
	assert.equal((await pressTab("see tes")).listed, false);
	const later = await pressTab("note\n/wecom-aibot tes");
	assert.equal(later.text, "note\n/wecom-aibot tests/", "a later line is plain text, not a command");
	assert.equal(later.listed, false);
});

test("completion is applied by the provider the wrapper wraps", () => {
	const item: AutocompleteItem = { value: "config", label: "config" };
	const provider = wecomTabCompletion(realProvider());
	const text = "/wecom-aibot c";
	const result = provider.applyCompletion([text], 0, text.length, item, "c");
	assert.deepEqual(result.lines, ["/wecom-aibot config"]);
	assert.equal(result.cursorCol, "/wecom-aibot config".length);
});

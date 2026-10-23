/** The full-stop rule: a paragraph never ends in 。, the sentences inside one keep theirs. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sentences } from "../../src/shared/text.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name))
		.map((entry) => join(entry.parentPath, entry.name));
}

test("sentences joins the non-empty parts with 。 and ends without one", () => {
	assert.equal(sentences("配置未改动", ""), "配置未改动");
	assert.equal(sentences("配置未改动", "本 session 仍使用自己的目标"), "配置未改动。本 session 仍使用自己的目标");
	assert.equal(sentences("上游诊断。", undefined, false, null, "请重试。"), "上游诊断。请重试");
	assert.equal(sentences(), "");
});

test("no string literal in the source ends a paragraph with 。", () => {
	// 。 right before a closing quote or a line break, optionally followed by closing brackets. A lone "。"
	// literal (a joiner) is not a paragraph; comments are not UI text.
	const ending = /(?<!["'`])。[）」』)]*(?:["'`]|\\n)/;
	const offenders: string[] = [];
	for (const file of sourceFiles(join(root, "src")))
		for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
			if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
			if (ending.test(line)) offenders.push(`${file.slice(root.length)}:${index + 1}: ${line.trim()}`);
		}
	assert.deepEqual(offenders, []);
});

test("no paragraph, list item or table cell in the docs ends with 。", () => {
	// Every line of these files is its own paragraph (they are not hard-wrapped); code blocks are examples.
	const offenders: string[] = [];
	for (const name of ["README.md", "plan.md"]) {
		const file = join(root, name);
		if (!existsSync(file)) continue;
		let fenced = false;
		for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
			if (/^\s*```/.test(line)) {
				fenced = !fenced;
				continue;
			}
			if (fenced) continue;
			const pieces = line.trim().startsWith("|") ? line.split("|") : [line];
			for (const piece of pieces.flatMap((cell) => cell.split(/<br\s*\/?>/))) {
				const text = piece.trim().replace(/(?:\*\*|__|[*_）」』)\]]|<\/[a-z]+>)+$/i, "");
				if (text.endsWith("。")) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
			}
		}
	}
	assert.deepEqual([...new Set(offenders)], []);
});

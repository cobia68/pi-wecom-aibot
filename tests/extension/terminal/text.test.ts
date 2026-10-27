import assert from "node:assert/strict";
import { test } from "node:test";
import { maskSecrets, maskText, parseAnsiLine, plainLines } from "../../../src/extension/terminal/text.ts";

const plain = (rows: ReturnType<typeof parseAnsiLine>[]) => rows.map((row) => row.map((cell) => cell.text).join(""));

test("ANSI parsing keeps grapheme widths and drops styling, control strings and hyperlinks", () => {
	const cells = parseAnsiLine(
		"\x1b[1;3;4;9;31;44ma中👨‍👩‍👧e\u0301\x1b[0m!\x1b]8;;https://private.invalid\x07链接\x1b]8;;\x07\x1b_pi:c\x07\x1b_Gpayload\x1b\\",
	);
	assert.deepEqual(
		cells.slice(0, 4).map((cell) => [cell.text, cell.width]),
		[
			["a", 1],
			["中", 2],
			["👨‍👩‍👧", 2],
			["é", 1],
		],
	);
	assert.deepEqual(cells[0], { text: "a", width: 1 }, "styling is dropped");
	assert.deepEqual(cells[4], { text: "!", width: 1 });
	assert.equal(cells.map((cell) => cell.text).join(""), "a中👨‍👩‍👧é!链接");
	assert.equal(plain([parseAnsiLine("a\tb\r\x00")])[0], "a   b");
});

test("only SGR 8 hides text: a colour value of 8 never does, and 28 or a reset shows it again", () => {
	const cells = parseAnsiLine("A\x1b[38;5;8mB\x1b[48:5:8mC\x1b[38;2;8;8;8mD\x1b[8mE\x1b[28mF\x1b[8mG\x1b[mH");
	assert.equal(cells.map((cell) => cell.text).join(""), "ABCDEFGH");
	assert.deepEqual(
		cells.map((cell) => cell.hidden ?? false),
		[false, false, false, false, true, false, true, false],
	);
	assert.deepEqual(plainLines(["A\x1b[8mSECRET\x1b[28mB"]), ["A      B"]);
});

test("known secrets are masked across colour changes and padded line wraps without changing cell widths", () => {
	const rows = [parseAnsiLine('  "token": "abc\x1b[31mDEF'), parseAnsiLine('   123456" 中秘密 ! s3')];
	const original = structuredClone(rows);
	const masked = maskSecrets(rows, ["abcDEF123456", "中秘密", "s3", ""]);
	assert.deepEqual(plain(masked), ['  "token": "******', '   ******" ****** ! **']);
	assert.deepEqual(
		masked.map((row) => row.reduce((n, cell) => n + cell.width, 0)),
		rows.map((row) => row.reduce((n, cell) => n + cell.width, 0)),
	);
	assert.deepEqual(rows, original, "masking never changes the live rendered cells");
});

test("plain lines keep their words, drop styling and blank edges, blank hidden text and mask known secrets", () => {
	const lines = [
		"",
		"\x1b[1;32m✔ passed\x1b[0m   ",
		"key \x1b[31msec\x1b[0mret-1 end",
		"hidden \x1b[8mXYZ\x1b[28m shown",
		"  ",
		"",
	];
	assert.deepEqual(plainLines(lines, ["secret-1"]), ["✔ passed", "key ******** end", "hidden     shown"]);
	assert.deepEqual(plainLines(["  ", ""]), []);
});

test("known secrets in a reply are masked as in the terminal lines; line breaks and Markdown stay", () => {
	assert.equal(maskText("key: SECRET-1\n`SECRET-1`", ["SECRET-1"]), "key: ********\n`********`");
	assert.equal(maskText("wrapped SECR\nET-1 here", ["SECRET-1"]), "wrapped ****\n**** here", "across a line break");
	assert.equal(maskText("nothing to hide", []), "nothing to hide");
});

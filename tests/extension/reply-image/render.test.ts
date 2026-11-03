import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadFonts } from "../../../src/extension/reply-image/fonts.ts";
import {
	MAX_REPLY_IMAGE_PAGES,
	REPLY_COLUMNS,
	ReplyImageRenderer,
	replyImagePages,
	withReplyImageFile,
} from "../../../src/extension/reply-image/index.ts";
import {
	cellsToSvg,
	contrast,
	headerColors,
	MAX_CONTENT_ROWS,
	parseAnsiLine,
	renderReplyPage,
	TARGET_PNG_WIDTH,
} from "../../../src/extension/reply-image/render.ts";

const metrics = { advance: 0.6, ascent: 0.8, descent: 0.2, lineGap: 0.2 };
const palette = { accent: "#2357a3", muted: "#526170", warning: "#8f4000", link: "#075985", variable: "#5b21b6" };
const options = { families: ["monospace"], metrics, foreground: "#182330", background: "#ffffff", palette };
const source = {
	sessionId: "session-original",
	provider: "original-provider",
	modelName: "original-model",
	directoryName: "project",
};

test("the retired ANSI renderer preserves styles and wide graphemes but drops terminal links and image escape protocols", () => {
	const cells = parseAnsiLine(
		"\x1b[1;3;4;9;38;2;1;2;3mA中👨‍👩‍👧e\u0301\x1b[0m!\x1b]8;;https://private.invalid\x07link\x1b]8;;\x07\x1b_Gpayload\x1b\\",
	);
	assert.deepEqual(
		cells.slice(0, 4).map((cell) => [cell.text, cell.width]),
		[
			["A", 1],
			["中", 2],
			["👨‍👩‍👧", 2],
			["é", 1],
		],
	);
	assert.equal(cells[0].fg, "#010203");
	assert.equal(cells[0].bold, true);
	assert.equal(cells[0].italic, true);
	assert.equal(cells[0].underline, true);
	assert.equal(cells[0].strike, true);
	assert.deepEqual(cells[4], { text: "!", width: 1 });
	assert.equal(cells.map((cell) => cell.text).join(""), "A中👨‍👩‍👧é!link");
});

test("long replies retain every row in order, including the beginning and the end, across multiple images", () => {
	const lines = Array.from(
		{ length: MAX_CONTENT_ROWS * 2 + 3 },
		(_, i) => `unique-line-${i.toString().padStart(4, "0")}`,
	);
	const pages = replyImagePages(`\`\`\`text\n${lines.join("\n")}\n\`\`\``);
	assert.equal(pages.length, 3);
	assert.ok(pages.every((page) => page.lines.length <= MAX_CONTENT_ROWS));
	const shown = pages
		.flatMap((page) => page.lines)
		.map(stripTerminalSequences)
		.join("\n");
	assert.deepEqual(shown.match(/unique-line-\d{4}/g), lines);
	assert.doesNotMatch(shown, /截断/);
});

test("Markdown headings, code, tables, Unicode and long tokens fit a fixed width without clipping", () => {
	const long = `BEGIN${"界a🙂".repeat(200)}END`;
	const body = `# **标题**\n\n- 第一项\n- 第二项\n\n| 列一 | 列二 |\n| --- | --- |\n| 中文 | value |\n\n\`\`\`ts\n${long}\n\`\`\`\n\n<!-- wecom_next ["隐藏提示词"] -->`;
	const rows = replyImagePages(body).flatMap((page) => page.lines);
	assert.ok(rows.every((row) => visibleWidth(row) <= REPLY_COLUMNS));
	const text = rows.map(stripTerminalSequences).join("\n");
	assert.match(text, /标题/);
	assert.match(text, /第一项/);
	assert.match(text, /列一/);
	assert.match(text, /BEGIN/);
	assert.match(text, /END/);
	assert.equal((text.match(/界/g) ?? []).length, 200);
	assert.equal((text.match(/🙂/g) ?? []).length, 200);
	assert.doesNotMatch(text, /wecom_next|隐藏提示词|\ufffd/);
	assert.ok(
		rows.some((row) => row.includes("\x1b[1m")),
		"Markdown emphasis keeps its style",
	);
});

test("HTML, remote images, local files and terminal escape strings cannot become SVG resources", (t) => {
	t.mock.method(globalThis, "fetch", () => assert.fail("rendering must never fetch user content"));
	const pages = replyImagePages(
		"<script>alert(1)</script>\n\n![picture](https://private.invalid/image.png)\n\n![secret](file:///etc/passwd)\n\n\x1b_Gsecret\x1b\\ END",
	);
	const svg = pages.map((page) => cellsToSvg(page.lines.map(parseAnsiLine), page.columns, options)).join("");
	assert.doesNotMatch(svg, /<script|<image|foreignObject|href=|_Gsecret/);
	assert.match(svg, /&lt;script&gt;/);
	assert.match(svg, /END/);
	const unsafeFont = cellsToSvg([parseAnsiLine('<&"')], 80, { ...options, families: ['Mono"Unsafe'] });
	assert.match(unsafeFont, /&lt;&amp;&quot;/);
	assert.match(unsafeFont, /Mono&quot;Unsafe/);
});

test("short images grow with content; overflowing pages fail instead of silently keeping a tail", () => {
	const svg = (count: number) =>
		cellsToSvg(
			Array.from({ length: count }, () => parseAnsiLine("line")),
			80,
			options,
		);
	const height = (text: string) => Number(/^<svg[^>]* height="(\d+)"/.exec(text)?.[1]);
	assert.ok(height(svg(3)) > height(svg(1)));
	assert.ok(height(svg(MAX_CONTENT_ROWS)) < 8000);
	assert.throws(() => svg(MAX_CONTENT_ROWS + 1), /分页行数/);
	assert.throws(
		() => replyImagePages(`\`\`\`\n${"line\n".repeat(MAX_CONTENT_ROWS * MAX_REPLY_IMAGE_PAGES)}\`\`\``),
		/查看全文/,
	);
	assert.throws(() => replyImagePages("\n\n"), /没有可渲染/);
});

test("the original source appears in the header, with SVG icons and readable contrast", () => {
	const header = {
		directory: source.directoryName,
		provider: source.provider,
		model: source.modelName,
		session: source.sessionId,
		badge: "全文 1/2",
		badgeIcon: "message-square-code" as const,
	};
	const svg = cellsToSvg([parseAnsiLine("body")], 80, { ...options, header });
	for (const value of Object.values(source)) assert.ok(svg.includes(value), value);
	assert.match(svg, /全文 1\/2/);
	assert.match(svg, /#F09082/);
	assert.match(svg, /#4D9ABF/);
	assert.match(svg, /#F1BE58/);
	assert.equal((svg.match(/viewBox="0 0 24 24"/g) ?? []).length, 4);
	const colors = headerColors(options);
	assert.ok(colors.values.every((value) => contrast(value, colors.band) >= 7));
	assert.ok(contrast(colors.prefix, colors.band) >= 4.5);
});

test("missing Chinese fonts fail with guidance before rasterisation instead of sending an empty-glyph image", async () => {
	await assert.rejects(
		renderReplyPage(
			{ lines: ["中文"], columns: 80, ...options },
			{
				fonts: { platform: "linux", buffers: [], families: [], sansFamilies: [], metrics, hasCjk: false },
			},
		),
		/CJK/,
	);
});

test("real WASM produces a PNG with visible glyphs at a content-sized height", async (t) => {
	let fonts: ReturnType<typeof loadFonts>;
	try {
		fonts = loadFonts();
	} catch {
		t.skip("no system fonts available; discovery is tested separately");
		return;
	}
	const page = { lines: ["Visible A123 <code>"], columns: 80, ...options };
	const png = Buffer.from(await renderReplyPage(page, { fonts }));
	assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(png.readUInt32BE(16), TARGET_PNG_WIDTH);
	assert.ok(png.readUInt32BE(20) < 400, "short replies are not padded to a terminal-sized canvas");
	const longer = Buffer.from(await renderReplyPage({ ...page, lines: [...page.lines, "second row"] }, { fonts }));
	assert.ok(longer.readUInt32BE(20) > png.readUInt32BE(20));
	const hidden = await renderReplyPage({ ...page, lines: ["\x1b[8mVisible A123 <code>"] }, { fonts });
	assert.notDeepEqual(png, Buffer.from(hidden));
});

test("an already cancelled image read does not discover fonts or render", async () => {
	const signal = AbortSignal.abort();
	await assert.rejects(new ReplyImageRenderer().render({ source, text: "reply" }, signal).next(), {
		name: "AbortError",
	});
});

for (const fail of [false, true])
	test(`temporary image files are private and cleaned after ${fail ? "failure" : "delivery"}`, async () => {
		let path = "";
		const png = new Uint8Array([1, 2, 3]);
		const pending = withReplyImageFile({ png, index: 1, total: 3 }, async (file) => {
			path = file.path;
			assert.equal(file.filename, "pi-reply-2-of-3.png");
			assert.deepEqual(await readFile(path), Buffer.from(png));
			if (process.platform !== "win32") {
				assert.equal((await stat(path)).mode & 0o077, 0);
				assert.equal((await stat(dirname(path))).mode & 0o077, 0);
			}
			if (fail) throw new Error("send failed");
		});
		if (fail) await assert.rejects(pending, /send failed/);
		else await pending;
		await assert.rejects(stat(path), { code: "ENOENT" });
		await assert.rejects(stat(dirname(path)), { code: "ENOENT" });
	});

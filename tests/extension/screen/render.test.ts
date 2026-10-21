import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type FontEnvironment,
	findEmojiFont,
	findFonts,
	loadFonts,
	readFontInfo,
} from "../../../src/extension/screen/fonts.ts";
import {
	cellMetrics,
	cellsToSvg,
	MAX_CONTENT_ROWS,
	maskSecrets,
	parseAnsiLine,
	renderScreenPng,
	TARGET_PNG_HEIGHT,
	TARGET_PNG_WIDTH,
} from "../../../src/extension/screen/render.ts";

const metrics = { advance: 0.6, ascent: 0.8, descent: 0.2, lineGap: 0.2 };
const palette = { accent: "#ff00ff", muted: "#999999", dim: "#777777", warning: "#ffaa00" };
const plain = (rows: ReturnType<typeof parseAnsiLine>[]) => rows.map((row) => row.map((cell) => cell.text).join(""));

/** Minimal sfnt tables for the font parser, not a rasterisation fixture. */
function font(family: string, cjk = false, format = 12): Uint8Array {
	const data = Buffer.alloc(512);
	data.writeUInt32BE(0x00010000, 0);
	data.writeUInt16BE(5, 4);
	for (const [i, [tag, at]] of (
		[
			["name", 100],
			["head", 180],
			["hhea", 220],
			["OS/2", 260],
			["cmap", 300],
		] as const
	).entries()) {
		data.write(tag, 12 + i * 16);
		data.writeUInt32BE(at, 20 + i * 16);
	}
	data.writeUInt16BE(1, 102);
	data.writeUInt16BE(18, 104);
	data.writeUInt16BE(3, 106); // Windows Unicode, English family name.
	data.writeUInt16BE(1, 108);
	data.writeUInt16BE(0x0409, 110);
	data.writeUInt16BE(1, 112);
	data.writeUInt16BE(family.length * 2, 114);
	[...family].forEach((char, i) => {
		data.writeUInt16BE(char.charCodeAt(0), 118 + i * 2);
	});
	data.writeUInt16BE(1000, 198);
	data.writeInt16BE(800, 224);
	data.writeInt16BE(-200, 226);
	data.writeInt16BE(200, 228);
	data.writeInt16BE(600, 262);
	data.writeUInt16BE(1, 302);
	data.writeUInt16BE(3, 304);
	data.writeUInt16BE(format === 12 ? 10 : 1, 306);
	data.writeUInt32BE(12, 308);
	const code = cjk ? 0x4e2d : 65;
	data.writeUInt16BE(format, 312);
	if (format === 12) {
		data.writeUInt32BE(28, 316);
		data.writeUInt32BE(1, 324);
		data.writeUInt32BE(code, 328);
		data.writeUInt32BE(code, 332);
		data.writeUInt32BE(1, 336);
	} else {
		data.writeUInt16BE(32, 314);
		data.writeUInt16BE(4, 318);
		data.writeUInt16BE(code, 326);
		data.writeUInt16BE(0xffff, 328);
		data.writeUInt16BE(code, 332);
		data.writeUInt16BE(0xffff, 334);
		data.writeInt16BE(1 - code, 336);
		data.writeInt16BE(1, 338);
	}
	return data;
}

function fontCollection(faces: Uint8Array[]): Uint8Array {
	const headerSize = 12 + faces.length * 4;
	const collection = Buffer.alloc(headerSize + faces.reduce((size, face) => size + face.length, 0));
	collection.write("ttcf");
	collection.writeUInt32BE(0x00010000, 4);
	collection.writeUInt32BE(faces.length, 8);
	let at = headerSize;
	faces.forEach((face, i) => {
		collection.writeUInt32BE(at, 12 + i * 4);
		collection.set(face, at);
		for (let table = 0; table < 5; table++) {
			const offset = at + 20 + table * 16;
			collection.writeUInt32BE(collection.readUInt32BE(offset) + at, offset);
		}
		at += face.length;
	});
	return collection;
}

function environment(
	platform: NodeJS.Platform,
	files: string[],
	extra: Partial<FontEnvironment> = {},
): FontEnvironment {
	return {
		platform,
		env: {},
		home: "/home/test",
		exists: (path) => files.includes(path),
		run: () => undefined,
		...extra,
	};
}

test("the card header is set in the proportional font, with the badge in the theme's accent", () => {
	const header = { title: "project", badge: "会话通知", subtitle: "provider · model", caption: "session: abc" };
	const svg = cellsToSvg([parseAnsiLine("body")], 20, {
		families: ["monospace"],
		sansFamilies: ["Sans"],
		metrics,
		foreground: "#eeeeee",
		background: "#111111",
		palette,
		header,
	});
	// Title, subtitle and badge take the proportional stack; only the caption stays monospace.
	assert.match(svg, /font-family="'Sans', monospace" font-size="17" font-weight="600"/);
	assert.match(svg, /font-family="'Sans', monospace" font-size="12\.5"/);
	assert.match(svg, /font-family="'Sans', monospace" font-size="11\.5" fill="#ff00ff">会话通知</);
	assert.match(svg, /font-family="monospace" font-size="11\.5"/);
	assert.match(svg, /#F09082/, "the header carries pi's mark, not a font glyph");
	assert.match(svg, /#4D9ABF/);
	assert.match(svg, /#F1BE58/);
	assert.match(svg, /font-size="15"/, "the terminal grid keeps its own size");
});

test("without a monochrome emoji font the header drops its leading icons instead of drawing boxes", () => {
	const svg = cellsToSvg([parseAnsiLine("body")], 40, {
		families: ["monospace"],
		metrics,
		foreground: "#eeeeee",
		background: "#101010",
		palette,
		header: { title: "🔔 project", badge: "会话通知", subtitle: "🏷️ provider · model", caption: "🆔 session: abc" },
	});
	assert.doesNotMatch(svg, /🔔|🏷️|🆔/, "no emoji glyph is drawn when the system has none");
	assert.match(svg, />project</);
	assert.match(svg, />provider · model</);
	assert.match(svg, />session: abc</);
});

test("Windows finds Noto Emoji under the variable-font file name or in the user font directory", () => {
	const system = "C:\\Windows\\Fonts\\NotoEmoji-VariableFont_wght.ttf";
	const user = "C:\\Users\\test\\AppData\\Local\\Microsoft\\Windows\\Fonts\\NotoEmoji-Regular.ttf";
	const systemEnv = environment("win32", [system], {
		list: (dir) => (dir === "C:\\Windows\\Fonts" ? ["NotoEmoji-VariableFont_wght.ttf"] : []),
	});
	assert.equal(findEmojiFont(systemEnv), system);
	const userEnv = environment("win32", [user], {
		env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
		list: (dir) => (dir.toLowerCase().endsWith("\\fonts") ? ["NotoEmoji-Regular.ttf"] : []),
	});
	assert.equal(findEmojiFont(userEnv), user);
	assert.equal(
		findEmojiFont(environment("win32", ["C:\\Windows\\Fonts\\seguiemj.ttf"], { list: () => ["seguiemj.ttf"] })),
		undefined,
		"Segoe UI Emoji is color and cannot be used by the rasteriser",
	);
});

test("the warning tone marks an aborted run, and no header leaves the band out", () => {
	const options = { families: ["monospace"], metrics, foreground: "#eeeeee", background: "#111111", palette };
	const aborted = cellsToSvg([parseAnsiLine("body")], 20, {
		...options,
		header: {
			title: "project",
			badge: "已中止",
			tone: "warning" as const,
			subtitle: "provider · model",
			caption: "session: abc",
		},
	});
	assert.match(aborted, /font-size="11\.5" fill="#ffaa00">已中止</);
	assert.doesNotMatch(
		cellsToSvg([parseAnsiLine("body")], 20, options),
		/clipPath/,
		"without a header there is no band",
	);
});

test("ANSI parsing retains grapheme widths and text styles, dropping control strings and hyperlinks", () => {
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
	assert.deepEqual(cells[0], {
		text: "a",
		width: 1,
		bold: true,
		italic: true,
		underline: true,
		strike: true,
		fg: "#cd3131",
		bg: "#2472c8",
	});
	assert.deepEqual(cells[4], { text: "!", width: 1 });
	assert.equal(cells.map((cell) => cell.text).join(""), "a中👨‍👩‍👧é!链接");
	assert.equal(plain([parseAnsiLine("a\tb\r\x00")])[0], "a   b");
});

test("ANSI colour handling covers 256-colour, truecolour, colon forms, inverse and selective resets", () => {
	const cells = parseAnsiLine("\x1b[38;5;196;48;2;1;2;3mA\x1b[38:2::4:5:6;7;2mB\x1b[27;22;39;49mC\x1b[8mD\x1b[28mE");
	assert.equal(cells[0].fg, "#ff0000");
	assert.equal(cells[0].bg, "#010203");
	assert.equal(cells[1].fg, "#040506");
	assert.equal(cells[1].inverse, true);
	assert.equal(cells[1].dim, true);
	assert.equal(cells[2].fg, undefined);
	assert.equal(cells[2].bg, undefined);
	assert.equal(cells[2].inverse, false);
	assert.equal(cells[3].hidden, true);
	assert.equal(cells[4].hidden, false);
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

test("SVG escapes text and font names while retaining cell backgrounds and decorations", () => {
	const svg = cellsToSvg([parseAnsiLine('\x1b[1;4;9;7m<&"\x1b[0m中文')], 20, {
		families: ['Mono"Unsafe', "monospace"],
		metrics,
		foreground: "#eeeeee",
		background: "#101010",
		palette,
	});
	assert.match(svg, /&lt;&amp;&quot;/);
	assert.match(svg, /Mono&quot;Unsafe/);
	assert.match(svg, /font-weight="bold"/);
	assert.match(svg, /fill="#eeeeee"/);
	assert.match(svg, /text-anchor="middle"/);
	assert.equal((svg.match(/<rect /g) ?? []).length, 8, "canvas, inverse background, underline and strike bars");
	assert.ok(cellMetrics({ ...metrics, advance: 100 }).width <= 15 * 0.75);
});

test("monochrome Noto Emoji is accepted while color emoji fonts are ignored", () => {
	const mono = "/home/test/.local/share/fonts/noto-emoji/NotoEmoji.ttf";
	assert.equal(findEmojiFont(environment("linux", [mono])), mono);
	const color = "/usr/share/fonts/truetype/noto/NotoColorEmoji-Regular.ttf";
	assert.equal(findEmojiFont(environment("linux", [color], { run: () => color })), undefined);
});

test("Windows discovers Microsoft YaHei in system or per-user fonts without using fontconfig", () => {
	const noCommands = { run: () => assert.fail("Windows must use native font locations") };
	const windows = environment(
		"win32",
		["C:\\Windows\\Fonts\\consola.ttf", "C:\\Windows\\Fonts\\simsun.ttc", "C:\\Windows\\Fonts\\msyh.ttc"],
		noCommands,
	);
	assert.deepEqual(findFonts(windows), {
		mono: "C:\\Windows\\Fonts\\consola.ttf",
		cjk: "C:\\Windows\\Fonts\\msyh.ttc",
	});
	const userFonts = "D:\\Users\\tester\\AppData\\Local\\Microsoft\\Windows\\Fonts";
	const user = environment("win32", [`${userFonts}\\msyh.ttf`], {
		...noCommands,
		env: { WINDIR: "D:\\Windows", LOCALAPPDATA: "D:\\Users\\tester\\AppData\\Local" },
	});
	assert.equal(findFonts(user).cjk, `${userFonts}\\msyh.ttf`);
	assert.equal(findFonts(environment("win32", ["C:\\Windows\\Fonts\\simsun.ttc"], noCommands)).cjk, undefined);
});

test("macOS discovers the system PingFang font without replacing it with unrelated CJK fonts", () => {
	const noCommands = { run: () => assert.fail("macOS must use native font locations") };
	const mac = environment(
		"darwin",
		["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/PingFang.ttc"],
		noCommands,
	);
	assert.deepEqual(findFonts(mac), {
		mono: "/System/Library/Fonts/Menlo.ttc",
		cjk: "/System/Library/Fonts/PingFang.ttc",
	});
	assert.equal(findFonts(environment("darwin", ["/System/Library/Fonts/Songti.ttc"], noCommands)).cjk, undefined);
});

test("macOS finds PingFang in versioned system font assets when the traditional path is absent", () => {
	const root = "/System/Library/AssetsV2";
	const asset = `${root}/com_apple_MobileAsset_Font7/installed.asset/AssetData/PingFang.ttc`;
	const directories: Record<string, string[]> = {
		[root]: ["unrelated-assets", "com_apple_MobileAsset_Font7"],
		[`${root}/com_apple_MobileAsset_Font7`]: ["metadata.xml", "installed.asset"],
	};
	const mac = environment("darwin", [asset], {
		run: () => assert.fail("font lookup must not run or download another program"),
		list: (directory) => {
			assert.ok(directory in directories, directory);
			return directories[directory];
		},
	});
	assert.equal(findFonts(mac).cjk, asset);
});

test("Linux ranks installed CJK fonts and never mistakes a Latin monospace match for CJK coverage", () => {
	const linux = environment(
		"linux",
		["/fonts/mono.ttf", "/fonts/wqy-microhei.ttc", "/fonts/NotoSansCJK-Regular.ttc"],
		{
			run: (command) =>
				command === "fc-match"
					? "/fonts/mono.ttf"
					: "/fonts/wqy-microhei.ttc: \n/fonts/NotoSansCJK-Regular.ttc: \n",
		},
	);
	assert.deepEqual(findFonts(linux), { mono: "/fonts/mono.ttf", cjk: "/fonts/NotoSansCJK-Regular.ttc" });
	const latinOnly = environment("linux", ["/fonts/mono.ttf"], {
		run: (command) => (command === "fc-match" ? "/fonts/mono.ttf" : ""),
	});
	assert.deepEqual(findFonts(latinOnly), { mono: "/fonts/mono.ttf", cjk: undefined });
	assert.deepEqual(findFonts(environment("linux", [])), { mono: undefined, cjk: undefined });
});

test("sfnt metrics, family names and real CJK coverage are read from Unicode cmap formats 4 and 12", () => {
	for (const format of [4, 12]) {
		const info = readFontInfo(font("Fixture Mono", true, format));
		assert.deepEqual(info.families, ["Fixture Mono"]);
		assert.deepEqual(info.metrics, metrics);
		assert.equal(info.hasCjk, true);
		assert.equal(readFontInfo(font("Latin", false, format)).hasCjk, false);
	}
	assert.deepEqual(readFontInfo(new Uint8Array()), { families: [], metrics: undefined, hasCjk: false });
});

test("TTC collections read each face using absolute table offsets", () => {
	const info = readFontInfo(fontCollection([font("Fixture Mono"), font("Fixture CJK", true)]));
	assert.deepEqual(info.families, ["Fixture Mono", "Fixture CJK"]);
	assert.deepEqual(info.metrics, metrics);
	assert.equal(info.hasCjk, true);
});

test("Windows loads YaHei regular and bold, preferring its main family while retaining monospace metrics", () => {
	const files: Record<string, Uint8Array> = {
		"C:\\Windows\\Fonts\\consola.ttf": font("Consolas"),
		"C:\\Windows\\Fonts\\msyh.ttc": fontCollection([font("Microsoft YaHei UI", true), font("Microsoft YaHei", true)]),
		"C:\\Windows\\Fonts\\msyhbd.ttc": font("Microsoft YaHei", true),
	};
	const paths: string[] = [];
	const fonts = loadFonts(environment("win32", Object.keys(files)), (path) => {
		paths.push(path);
		assert.ok(path in files, path);
		return files[path];
	});
	assert.deepEqual(paths, Object.keys(files));
	assert.deepEqual(fonts.families, ["Consolas", "Microsoft YaHei", "Microsoft YaHei UI", "monospace"]);
	assert.equal(fonts.platform, "win32");
	assert.equal(fonts.hasCjk, true);
	assert.deepEqual(fonts.metrics, metrics);
});

test("macOS prefers PingFang SC even when that family occurs after the first eight TTC faces", () => {
	const collection = fontCollection([
		...Array.from({ length: 9 }, () => font("PingFang TC", true)),
		font("PingFang HK", true),
		font("PingFang SC", true),
	]);
	const files: Record<string, Uint8Array> = {
		"/System/Library/Fonts/Menlo.ttc": font("Menlo"),
		"/System/Library/Fonts/PingFang.ttc": collection,
	};
	const fonts = loadFonts(environment("darwin", Object.keys(files)), (path) => files[path]);
	assert.deepEqual(fonts.families, ["Menlo", "PingFang SC", "PingFang TC", "PingFang HK", "monospace"]);
	assert.equal(fonts.platform, "darwin");
	assert.equal(fonts.hasCjk, true);
});

test("a discovered font that cannot be read or parsed is skipped, and no font at all is one error", () => {
	const unreadable = environment("linux", [
		"/usr/share/fonts/TTF/DejaVuSansMono.ttf",
		"/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc",
	]);
	const fonts = loadFonts(unreadable, (path) => {
		if (path.endsWith("wqy-microhei.ttc")) throw new Error("permission denied");
		return font("Fixture Mono");
	});
	assert.deepEqual(fonts.families, ["Fixture Mono", "monospace"]);
	assert.throws(
		() => loadFonts(environment("linux", ["/usr/share/fonts/mono.ttf"]), () => new Uint8Array()),
		/系统字体/,
	);
	assert.throws(() => loadFonts(environment("linux", [])), /系统字体/);
});

test("rendering refuses empty screens before loading fonts", async () => {
	await assert.rejects(
		renderScreenPng({ lines: ["   "], columns: 80, foreground: "#eeeeee", background: "#000000", palette }),
		/画面是空的/,
	);
});

for (const [platform, expected] of [
	["win32", /微软雅黑/],
	["darwin", /苹方/],
	["linux", /CJK/],
] as const) {
	test(`missing Chinese fonts give actionable ${platform} guidance before loading WASM`, async () => {
		const env = environment(platform, []);
		const check = (error: Error) => {
			assert.match(error.message, expected);
			if (platform === "linux") {
				assert.match(error.message, /安装/);
				assert.match(error.message, /fonts-noto-cjk/);
				assert.match(error.message, /pacman -S noto-fonts-cjk/);
			} else assert.doesNotMatch(error.message, /Linux|apt install|pacman/);
			return true;
		};
		assert.throws(() => loadFonts(env), check);
		const latin = environment(
			platform,
			platform === "win32"
				? ["C:\\Windows\\Fonts\\cour.ttf"]
				: platform === "darwin"
					? ["/System/Library/Fonts/Courier New.ttf"]
					: ["/usr/share/fonts/TTF/DejaVuSansMono.ttf"],
		);
		const fonts = loadFonts(latin, () => font("Latin"));
		assert.equal(fonts.hasCjk, false);
		await assert.rejects(
			renderScreenPng(
				{ lines: ["中文"], columns: 80, foreground: "#eeeeee", background: "#000000", palette },
				{ fonts },
			),
			check,
		);
	});
}

test("Linux can still render an English-only screen when no CJK font is available", async (t) => {
	const mono = findFonts().mono;
	if (!mono) {
		t.skip("no system monospace font is installed");
		return;
	}
	const fonts = loadFonts(environment("linux", [mono]), (path) => readFileSync(path));
	if (fonts.hasCjk) {
		t.skip("the system monospace font already covers Chinese");
		return;
	}
	const image = await renderScreenPng(
		{ lines: ["English only 123"], columns: 30, foreground: "#eeeeee", background: "#000000", palette },
		{ fonts },
	);
	assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("real WASM renders visible glyphs into PNG and bounds very wide screens", async (t) => {
	let fonts: ReturnType<typeof loadFonts>;
	try {
		fonts = loadFonts();
	} catch {
		t.skip("no system font installed; font discovery and missing-font behaviour are tested above");
		return;
	}
	const screen = {
		lines: ["Screen render: A123 <code>"],
		columns: 500,
		foreground: "#eeeeee",
		background: "#101010",
		palette,
	};
	const image = Buffer.from(await renderScreenPng(screen, { fonts }));
	assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(image.readUInt32BE(16), TARGET_PNG_WIDTH);
	assert.equal(image.readUInt32BE(20), TARGET_PNG_HEIGHT, "very wide content still fills the fixed canvas");
	const hidden = await renderScreenPng({ ...screen, lines: [`\x1b[8m${screen.lines[0]}`] }, { fonts });
	assert.notDeepEqual(image, Buffer.from(hidden), "the image must contain glyphs, not just a background rectangle");
});

test("every image is exactly TARGET_PNG_WIDTH × TARGET_PNG_HEIGHT, so two pi windows look alike", async (t) => {
	let fonts: ReturnType<typeof loadFonts>;
	try {
		fonts = loadFonts();
	} catch {
		t.skip("no system font installed");
		return;
	}
	for (const columns of [40, 60, 80, 100, 120, 140, 160]) {
		for (const rows of [1, 5, 40, MAX_CONTENT_ROWS, MAX_CONTENT_ROWS + 20]) {
			const png = Buffer.from(
				await renderScreenPng(
					{
						lines: Array.from({ length: rows }, (_, i) => `截图宽度归一化 line-${i}`),
						columns,
						foreground: "#eeeeee",
						background: "#101010",
						palette,
					},
					{ fonts },
				),
			);
			assert.equal(png.readUInt32BE(16), TARGET_PNG_WIDTH, `${columns} columns, ${rows} rows: width`);
			assert.equal(png.readUInt32BE(20), TARGET_PNG_HEIGHT, `${columns} columns, ${rows} rows: height`);
		}
	}
});

test("only the newest MAX_CONTENT_ROWS rows are kept, and a short screen pads the rest with background", async (t) => {
	let fonts: ReturnType<typeof loadFonts>;
	try {
		fonts = loadFonts();
	} catch {
		t.skip("no system font installed");
		return;
	}
	const render = (lines: string[]) =>
		renderScreenPng({ lines, columns: 80, foreground: "#eeeeee", background: "#101010", palette }, { fonts });
	const rows = Array.from({ length: MAX_CONTENT_ROWS }, (_, i) => `keep-${i}`);
	const newest = Buffer.from(await render(rows));
	const overflowing = Buffer.from(await render(["dropped-old-row", ...rows]));
	assert.deepEqual(overflowing, newest, "the oldest row is cut, not squeezed");
	const short = Buffer.from(await render(["keep-0"]));
	assert.notDeepEqual(short, Buffer.from(await render(["keep-0", "one more"])));
	assert.equal(short.readUInt32BE(20), TARGET_PNG_HEIGHT, "a short screen keeps its empty rows");
});

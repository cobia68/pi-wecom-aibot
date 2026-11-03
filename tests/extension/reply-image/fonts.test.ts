import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type FontEnvironment,
	findEmojiFont,
	findFonts,
	loadFonts,
	readFontInfo,
} from "../../../src/extension/reply-image/fonts.ts";

/** Font-discovery/parser fixtures retained from the retired screen renderer; no system fonts or commands needed. */
const metrics = { advance: 0.6, ascent: 0.8, descent: 0.2, lineGap: 0.2 };
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
	data.writeUInt16BE(3, 106);
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

function collection(faces: Uint8Array[]): Uint8Array {
	const headerSize = 12 + faces.length * 4;
	const data = Buffer.alloc(headerSize + faces.reduce((size, face) => size + face.length, 0));
	data.write("ttcf");
	data.writeUInt32BE(0x00010000, 4);
	data.writeUInt32BE(faces.length, 8);
	let at = headerSize;
	faces.forEach((face, i) => {
		data.writeUInt32BE(at, 12 + i * 4);
		data.set(face, at);
		for (let table = 0; table < 5; table++) {
			const offset = at + 20 + table * 16;
			data.writeUInt32BE(data.readUInt32BE(offset) + at, offset);
		}
		at += face.length;
	});
	return data;
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

test("Windows and macOS use native font locations, not fontconfig or downloads", () => {
	const noCommands = { run: () => assert.fail("native font locations only") };
	assert.deepEqual(
		findFonts(environment("win32", ["C:\\Windows\\Fonts\\consola.ttf", "C:\\Windows\\Fonts\\msyh.ttc"], noCommands)),
		{
			mono: "C:\\Windows\\Fonts\\consola.ttf",
			cjk: "C:\\Windows\\Fonts\\msyh.ttc",
		},
	);
	const userFonts = "D:\\Users\\tester\\AppData\\Local\\Microsoft\\Windows\\Fonts";
	assert.equal(
		findFonts(
			environment("win32", [`${userFonts}\\msyh.ttf`], {
				...noCommands,
				env: { WINDIR: "D:\\Windows", LOCALAPPDATA: "D:\\Users\\tester\\AppData\\Local" },
			}),
		).cjk,
		`${userFonts}\\msyh.ttf`,
	);
	assert.deepEqual(
		findFonts(
			environment("darwin", ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/PingFang.ttc"], noCommands),
		),
		{
			mono: "/System/Library/Fonts/Menlo.ttc",
			cjk: "/System/Library/Fonts/PingFang.ttc",
		},
	);
});

test("macOS discovers PingFang in versioned system font assets", () => {
	const root = "/System/Library/AssetsV2";
	const asset = `${root}/com_apple_MobileAsset_Font7/installed.asset/AssetData/PingFang.ttc`;
	const directories: Record<string, string[]> = {
		[root]: ["unrelated", "com_apple_MobileAsset_Font7"],
		[`${root}/com_apple_MobileAsset_Font7`]: ["metadata.xml", "installed.asset"],
	};
	assert.equal(
		findFonts(environment("darwin", [asset], { list: (directory) => directories[directory] ?? [] })).cjk,
		asset,
	);
});

test("Linux ranks CJK fonts, preferring regular sans, and never treats a Latin match as Chinese coverage", () => {
	const linux = environment(
		"linux",
		["/fonts/mono.ttf", "/fonts/wqy-microhei.ttc", "/fonts/NotoSansCJK-Regular.ttc", "/fonts/NotoSansCJK-Bold.ttc"],
		{
			run: (command) =>
				command === "fc-match"
					? "/fonts/mono.ttf"
					: "/fonts/wqy-microhei.ttc:\n/fonts/NotoSansCJK-Bold.ttc:\n/fonts/NotoSansCJK-Regular.ttc:\n",
		},
	);
	assert.deepEqual(findFonts(linux), { mono: "/fonts/mono.ttf", cjk: "/fonts/NotoSansCJK-Regular.ttc" });
	assert.deepEqual(
		findFonts(
			environment("linux", ["/fonts/mono.ttf"], {
				run: (command) => (command === "fc-match" ? "/fonts/mono.ttf" : ""),
			}),
		),
		{
			mono: "/fonts/mono.ttf",
			cjk: undefined,
		},
	);
});

test("sfnt cmap formats 4 and 12 are checked for actual Chinese glyphs, and malformed fonts fail safely", () => {
	for (const format of [4, 12]) {
		assert.deepEqual(readFontInfo(font("Fixture Mono", true, format)), {
			families: ["Fixture Mono"],
			metrics,
			hasCjk: true,
		});
		assert.equal(readFontInfo(font("Latin", false, format)).hasCjk, false);
	}
	assert.deepEqual(readFontInfo(new Uint8Array()), { families: [], metrics: undefined, hasCjk: false });
});

test("TTC tables use absolute offsets and PingFang SC can occur after the first eight faces", () => {
	const data = collection([...Array.from({ length: 9 }, () => font("PingFang TC", true)), font("PingFang SC", true)]);
	assert.deepEqual(readFontInfo(data), { families: ["PingFang TC", "PingFang SC"], metrics, hasCjk: true });
	const files: Record<string, Uint8Array> = {
		"/System/Library/Fonts/Menlo.ttc": font("Menlo"),
		"/System/Library/Fonts/PingFang.ttc": data,
	};
	const fonts = loadFonts(environment("darwin", Object.keys(files)), (path) => files[path]);
	assert.deepEqual(fonts.families, ["Menlo", "PingFang SC", "PingFang TC", "monospace"]);
	assert.equal(fonts.hasCjk, true);
});

test("Windows loads YaHei regular and bold, preserving monospace metrics", () => {
	const files: Record<string, Uint8Array> = {
		"C:\\Windows\\Fonts\\consola.ttf": font("Consolas"),
		"C:\\Windows\\Fonts\\msyh.ttc": collection([font("Microsoft YaHei UI", true), font("Microsoft YaHei", true)]),
		"C:\\Windows\\Fonts\\msyhbd.ttc": font("Microsoft YaHei", true),
	};
	const fonts = loadFonts(environment("win32", Object.keys(files)), (path) => files[path]);
	assert.equal(fonts.buffers.length, 3);
	assert.deepEqual(fonts.families, ["Consolas", "Microsoft YaHei", "Microsoft YaHei UI", "monospace"]);
	assert.deepEqual(fonts.metrics, metrics);
});

test("font read failures are skipped, and no available font gives an actionable error", () => {
	const fonts = loadFonts(
		environment("linux", [
			"/usr/share/fonts/TTF/DejaVuSansMono.ttf",
			"/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
		]),
		(path) => {
			if (path.endsWith(".ttc")) throw new Error("unreadable");
			return font("Fixture Mono");
		},
	);
	assert.deepEqual(fonts.families, ["Fixture Mono", "monospace"]);
	for (const [platform, message] of [
		["win32", /微软雅黑/],
		["darwin", /苹方/],
		["linux", /CJK/],
	] as const)
		assert.throws(() => loadFonts(environment(platform, [])), message);
});

test("only monochrome emoji fonts are used, including Windows variable-font names", () => {
	const mono = "/home/test/.local/share/fonts/noto-emoji/NotoEmoji.ttf";
	assert.equal(findEmojiFont(environment("linux", [mono])), mono);
	const color = "/fonts/NotoColorEmoji-Regular.ttf";
	assert.equal(findEmojiFont(environment("linux", [color], { run: () => color })), undefined);
	const variable = "C:\\Windows\\Fonts\\NotoEmoji-VariableFont_wght.ttf";
	assert.equal(
		findEmojiFont(environment("win32", [variable], { list: () => ["NotoEmoji-VariableFont_wght.ttf"] })),
		variable,
	);
});

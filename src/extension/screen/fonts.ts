/**
 * Font discovery and sfnt parsing for the screen renderer. WebAssembly cannot see system fonts, so the
 * fonts are found here and read into buffers, with a CJK font so Chinese text renders.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface FontMetrics {
	/** Advance of the monospace font, in em. */
	advance: number;
	ascent: number;
	descent: number;
	lineGap: number;
}
export interface FontEnvironment {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string;
	exists(path: string): boolean;
	/** Native font asset directories; an unreadable directory is an empty list. */
	list?(directory: string): string[];
	/** Run a command and return stdout; undefined when it is missing or fails. */
	run(command: string, args: string[]): string | undefined;
}

export interface FontSet {
	/** The font host, when known, for platform-specific missing-font guidance. */
	platform?: NodeJS.Platform;
	buffers: Uint8Array[];
	/** Font-family list: monospace first, then fallbacks for CJK and symbols. */
	families: string[];
	/** The CJK font's families, the header's proportional type; empty without a CJK font. */
	sansFamilies: string[];
	metrics: FontMetrics;
	/** At least one loaded font has a Chinese glyph (not merely a matching file name). */
	hasCjk: boolean;
}

const systemEnvironment: FontEnvironment = {
	platform: process.platform,
	env: process.env,
	home: homedir(),
	exists: existsSync,
	list(directory) {
		try {
			return readdirSync(directory);
		} catch {
			return [];
		}
	},
	run(command, args) {
		try {
			return execFileSync(command, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return undefined;
		}
	},
};

/** Recent macOS releases may store PingFang in a versioned system font asset. */
function findPingFangAsset(environment: FontEnvironment): string | undefined {
	const root = "/System/Library/AssetsV2";
	for (const directory of (environment.list?.(root) ?? [])
		.filter((name) => /^com_apple_MobileAsset_Font\d+$/.test(name))
		.sort()) {
		const fonts = posix.join(root, directory);
		for (const asset of (environment.list?.(fonts) ?? []).filter((name) => name.endsWith(".asset")).sort()) {
			const file = posix.join(fonts, asset, "AssetData", "PingFang.ttc");
			if (environment.exists(file)) return file;
		}
	}
	return undefined;
}

export function missingCjkFontMessage(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32")
		return "没有找到可用的微软雅黑（Microsoft YaHei）中文字体；请在 Windows 字体设置中启用或恢复系统微软雅黑后重试";
	if (platform === "darwin")
		return "没有找到可用的苹方（PingFang SC）中文字体；请在 macOS 字体册中启用或恢复系统苹方后重试";
	if (platform === "linux")
		return "Linux 没有找到可用的 CJK 中文字体，请安装系统字体后重试。Debian/Ubuntu：sudo apt install fonts-noto-cjk fontconfig；Arch：sudo pacman -S noto-fonts-cjk fontconfig。";
	return "当前系统没有找到可用的 CJK 中文字体；请安装支持中文的系统字体后重试";
}

/** System fonts only: monospace for terminal alignment, YaHei/PingFang on Windows/macOS, installed CJK on Linux. */
export function findFonts(environment: FontEnvironment = systemEnvironment): { mono?: string; cjk?: string } {
	const { platform, env, home, exists } = environment;
	const firstIn = (join: (...parts: string[]) => string, dirs: string[], names: string[]) => {
		for (const name of names)
			for (const dir of dirs) {
				const path = join(dir, name);
				if (exists(path)) return path;
			}
		return undefined;
	};
	if (platform === "win32") {
		const dirs = [win32.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "Fonts")];
		if (env.LOCALAPPDATA) dirs.push(win32.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
		return {
			mono: firstIn(win32.join, dirs, ["consola.ttf", "CascadiaMono.ttf", "lucon.ttf", "cour.ttf"]),
			cjk: firstIn(win32.join, dirs, ["msyh.ttc", "msyh.ttf"]),
		};
	}
	if (platform === "darwin") {
		const dirs = [
			"/System/Library/Fonts",
			"/System/Library/Fonts/Supplemental",
			"/Library/Fonts",
			posix.join(home, "Library", "Fonts"),
		];
		return {
			mono: firstIn(posix.join, dirs, ["Menlo.ttc", "Monaco.ttf", "SFNSMono.ttf", "Courier New.ttf"]),
			cjk: firstIn(posix.join, dirs, ["PingFang.ttc"]) ?? findPingFangAsset(environment),
		};
	}
	const matched = environment.run("fc-match", ["-f", "%{file}", "monospace"])?.trim();
	const mono =
		matched && exists(matched)
			? matched
			: [
					"/usr/share/fonts/TTF/DejaVuSansMono.ttf",
					"/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
					"/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
					"/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf",
					"/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf",
				].find(exists);
	const listed = (environment.run("fc-list", [":lang=zh", "file"]) ?? "")
		.split("\n")
		.map((line) => line.trim().replace(/:\s*$/, ""))
		.filter((path) => path && exists(path));
	const rank = (path: string) => {
		const name = posix.basename(path).toLowerCase();
		const family = [
			/notosanscjk|notosanssc|noto.*cjk/,
			/sourcehansans/,
			/wqy-microhei/,
			/wqy-zenhei/,
			/droidsansfallback/,
		].findIndex((pattern) => pattern.test(name));
		// The regular sans face first: other weights (Arch ships DemiLight beside Regular), then serif and monospace variants.
		const variant = /serif|mono/.test(name) ? 2 : /thin|light|medium|bold|black|heavy/.test(name) ? 1 : 0;
		return (family === -1 ? 9 : family) * 3 + variant;
	};
	const cjk =
		listed.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ??
		[
			"/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc",
			"/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
			"/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
			"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
			"/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
		].find(exists);
	return { mono, cjk };
}

/** A monochrome emoji font; color emoji fonts (COLR/sbix) are not rendered reliably by resvg. */
export function findEmojiFont(environment: FontEnvironment = systemEnvironment): string | undefined {
	const { platform, env, home, exists } = environment;
	const names = ["NotoEmoji-Regular.ttf", "NotoEmoji.ttf"];
	const firstIn = (join: (...parts: string[]) => string, dirs: string[]) => {
		for (const name of names)
			for (const dir of dirs) {
				const path = join(dir, name);
				if (exists(path)) return path;
			}
		return undefined;
	};
	if (platform === "win32") {
		const dirs = [win32.join(env.WINDIR || env.SystemRoot || "C:\\Windows", "Fonts")];
		if (env.LOCALAPPDATA) dirs.push(win32.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
		// Windows ships only the color Segoe UI Emoji; a manually installed Noto Emoji may use the
		// variable-font file name, so look at what is actually in the font directories.
		const listed = dirs.flatMap((dir) =>
			(environment.list?.(dir) ?? [])
				.filter((name) => /^NotoEmoji.*\.(?:ttf|otf)$/i.test(name))
				.map((name) => win32.join(dir, name)),
		);
		return firstIn(win32.join, dirs) ?? listed[0];
	}
	if (platform === "darwin") {
		return firstIn(posix.join, [
			"/Library/Fonts",
			posix.join(home, "Library/Fonts"),
			"/System/Library/Fonts/Supplemental",
		]);
	}
	const known = [
		posix.join(home, ".local/share/fonts/noto-emoji/NotoEmoji.ttf"),
		posix.join(home, ".local/share/fonts/NotoEmoji.ttf"),
		"/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
		"/usr/share/fonts/noto/NotoEmoji-Regular.ttf",
		"/usr/share/fonts/truetype/noto-emoji/NotoEmoji-Regular.ttf",
		"/usr/share/fonts/noto-emoji/NotoEmoji-Regular.ttf",
	].find(exists);
	if (known) return known;
	const listed = (environment.run("fc-list", [":family=Noto Emoji", "file"]) ?? "")
		.split("\n")
		.map((line) => line.trim().replace(/:\s*$/, ""))
		.filter((path) => path && exists(path));
	return listed.find((path) => !/color.*emoji|emoji.*color|seguiemj|apple color emoji/i.test(path));
}

/** Read the fonts discovered on this system, skipping any that do not parse as a font. */
export function loadFonts(
	environment: FontEnvironment = systemEnvironment,
	read: (path: string) => Uint8Array = readFileSync,
): FontSet {
	const found = findFonts(environment);
	const buffers: Uint8Array[] = [];
	const families: string[] = [];
	const seen = new Set<string>();
	const pathApi = environment.platform === "win32" ? win32 : posix;
	let metrics: FontMetrics | undefined;
	let hasCjk = false;
	let sansFamilies: string[] = [];
	const add = (file: string, preferredFamilies: readonly string[] = []) => {
		const path = pathApi.normalize(file.replace(/^~(?=$|[\\/])/, environment.home));
		const key = environment.platform === "win32" ? path.toLowerCase() : path;
		if (seen.has(key)) return;
		seen.add(key);
		let data: Uint8Array;
		try {
			data = read(path);
		} catch {
			return;
		}
		const info = readFontInfo(data);
		if (!info.families.length) return;
		buffers.push(data);
		families.push(...preferredFamilies.filter((family) => info.families.includes(family)), ...info.families);
		metrics ??= info.metrics;
		hasCjk ||= info.hasCjk;
	};
	const mono = found.mono;
	if (mono) {
		add(mono);
		// resvg needs actual bold/italic faces; it does not synthesize every missing style.
		const variants = /consola\.ttf$/i.test(mono)
			? ["consolab.ttf", "consolai.ttf", "consolaz.ttf"].map((name) => pathApi.join(pathApi.dirname(mono), name))
			: ["Bold", "Italic", "BoldItalic", "Oblique", "BoldOblique"].map((style) =>
					mono.replace(/(?:-Regular)?\.ttf$/i, `-${style}.ttf`),
				);
		for (const path of variants) if (path !== mono && environment.exists(path)) add(path);
	}
	if (found.cjk) {
		const preferred =
			environment.platform === "win32"
				? ["Microsoft YaHei", "Microsoft YaHei UI"]
				: environment.platform === "darwin"
					? ["PingFang SC"]
					: ["Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC"];
		const before = families.length;
		add(found.cjk, preferred);
		// Bold Chinese needs the bold file beside the regular one; PingFang's collection already has its weights.
		const bold =
			environment.platform === "win32"
				? found.cjk.replace(/msyh\.(ttc|ttf)$/i, "msyhbd.$1")
				: found.cjk.replace(/-Regular(\.(?:otf|ttf|ttc))$/i, "-Bold$1");
		if (bold !== found.cjk && environment.exists(bold)) add(bold, preferred);
		sansFamilies = families.slice(before);
	}
	// Emoji last: ordinary text keeps the monospace/CJK metrics while resvg falls back for emoji.
	const emoji = findEmojiFont(environment);
	const beforeEmoji = families.length;
	if (emoji) add(emoji, ["Noto Emoji"]);
	const emojiFamilies = families.slice(beforeEmoji);
	if (!buffers.length) throw new Error(`找不到可用的系统字体。${missingCjkFontMessage(environment.platform)}`);
	return {
		platform: environment.platform,
		buffers,
		families: [...new Set([...families.slice(0, beforeEmoji), "monospace", ...emojiFamilies])],
		sansFamilies: [...new Set(sansFamilies)],
		metrics: metrics ?? { advance: 0.6, ascent: 0.8, descent: 0.2, lineGap: 0 },
		hasCjk,
	};
}

/** PingFang contains multiple weights and regional families; keep parsing bounded without stopping at eight faces. */
const MAX_FONT_FACES = 32;

/**
 * Family names and monospace metrics from a TrueType/OpenType font or collection, read from the
 * sfnt tables. Malformed data yields what was read so far rather than an exception.
 */
export function readFontInfo(data: Uint8Array): { families: string[]; metrics?: FontMetrics; hasCjk: boolean } {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const families: string[] = [];
	let metrics: FontMetrics | undefined;
	let hasCjk = false;
	try {
		const faces =
			view.getUint32(0) === 0x74746366
				? Array.from({ length: Math.min(view.getUint32(8), MAX_FONT_FACES) }, (_, index) =>
						view.getUint32(12 + index * 4),
					)
				: [0];
		for (const face of faces) {
			const tables = new Map<string, number>();
			const count = view.getUint16(face + 4);
			for (let i = 0; i < count; i++) {
				const at = face + 12 + i * 16;
				tables.set(String.fromCharCode(...data.subarray(at, at + 4)), view.getUint32(at + 8));
			}
			const name = tables.get("name");
			if (name !== undefined) families.push(...nameRecords(view, data, name));
			metrics ??= faceMetrics(view, tables);
			const cmap = tables.get("cmap");
			if (cmap !== undefined) hasCjk ||= cmapHasGlyph(view, cmap, 0x4e2d); // 中
		}
	} catch (error) {
		// Malformed font data reads out of range; a parser bug surfaces instead of looking like "no CJK font".
		if (!(error instanceof RangeError)) throw error;
	}
	return { families: [...new Set(families)], metrics, hasCjk };
}

/** The Unicode cmap formats used by modern TrueType/OpenType fonts (BMP and full Unicode). */
function cmapHasGlyph(view: DataView, table: number, code: number): boolean {
	for (let i = 0; i < view.getUint16(table + 2); i++) {
		const record = table + 4 + i * 8;
		const platform = view.getUint16(record);
		const encoding = view.getUint16(record + 2);
		if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
		const at = table + view.getUint32(record + 4);
		const format = view.getUint16(at);
		if (format === 12) {
			const count = Math.min(view.getUint32(at + 12), 100_000);
			for (let j = 0; j < count; j++) {
				const group = at + 16 + j * 12;
				const start = view.getUint32(group);
				if (code >= start && code <= view.getUint32(group + 4) && view.getUint32(group + 8) + code - start !== 0)
					return true;
			}
		} else if (format === 4) {
			const count = view.getUint16(at + 6) / 2;
			for (let j = 0; j < count; j++) {
				const end = view.getUint16(at + 14 + j * 2);
				const start = view.getUint16(at + 16 + count * 2 + j * 2);
				if (code < start || code > end) continue;
				const delta = view.getInt16(at + 16 + count * 4 + j * 2);
				const rangeAt = at + 16 + count * 6 + j * 2;
				const range = view.getUint16(rangeAt);
				const glyph = range ? view.getUint16(rangeAt + range + 2 * (code - start)) : code;
				if ((!range || glyph !== 0) && ((glyph + delta) & 0xffff) !== 0) return true;
			}
		}
	}
	return false;
}

/** Name IDs 16 (typographic family) and 1 (family); English Windows names first. */
function nameRecords(view: DataView, data: Uint8Array, table: number): string[] {
	const count = view.getUint16(table + 2);
	const strings = table + view.getUint16(table + 4);
	const found: { text: string; rank: number }[] = [];
	for (let i = 0; i < count; i++) {
		const at = table + 6 + i * 12;
		const platform = view.getUint16(at);
		const language = view.getUint16(at + 4);
		const nameId = view.getUint16(at + 6);
		if (nameId !== 1 && nameId !== 16) continue;
		const bytes = data.subarray(
			strings + view.getUint16(at + 10),
			strings + view.getUint16(at + 10) + view.getUint16(at + 8),
		);
		let text: string;
		if (platform === 3 || platform === 0) {
			text = "";
			for (let j = 0; j + 1 < bytes.length; j += 2) text += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
		} else if (platform === 1 && bytes.every((byte) => byte < 0x80)) {
			text = String.fromCharCode(...bytes);
		} else continue;
		text = text.trim();
		if (!text) continue;
		const english = (platform === 3 && language === 0x0409) || (platform === 1 && language === 0);
		found.push({ text, rank: (english ? 0 : 2) + (nameId === 16 ? 0 : 1) });
	}
	return found.sort((a, b) => a.rank - b.rank).map((record) => record.text);
}

function faceMetrics(view: DataView, tables: Map<string, number>): FontMetrics | undefined {
	const head = tables.get("head");
	const hhea = tables.get("hhea");
	if (head === undefined || hhea === undefined) return undefined;
	const unitsPerEm = view.getUint16(head + 18);
	if (!unitsPerEm) return undefined;
	const os2 = tables.get("OS/2");
	const advanceUnits = os2 !== undefined ? view.getInt16(os2 + 2) : view.getUint16(hhea + 10);
	return {
		advance: advanceUnits / unitsPerEm,
		ascent: view.getInt16(hhea + 4) / unitsPerEm,
		descent: Math.abs(view.getInt16(hhea + 6)) / unitsPerEm,
		lineGap: Math.max(0, view.getInt16(hhea + 8)) / unitsPerEm,
	};
}

// ---------------------------------------------------------------- PNG

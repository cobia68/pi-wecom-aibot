/**
 * Draw captured terminal lines as a PNG: ANSI styles become a grid of cells, the grid becomes SVG,
 * and resvg's WebAssembly build rasterises it, so every platform renders the same way without a
 * browser or native binary. WebAssembly cannot see system fonts: the fonts are found here and read
 * into buffers, with a CJK font so Chinese text renders. Runs in pi only; the gateway never loads it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface CapturedScreen {
	/** Terminal lines with ANSI styling, top to bottom. */
	lines: string[];
	columns: number;
	/** The terminal's default colours as #rrggbb. */
	foreground: string;
	background: string;
}

export interface Cell {
	/** One grapheme; "" for the second column of nothing. */
	text: string;
	/** Terminal columns: 1 or 2. */
	width: 1 | 2;
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	inverse?: boolean;
	hidden?: boolean;
}

type Style = Omit<Cell, "text" | "width">;

// ---------------------------------------------------------------- ANSI → cells

/** CSI (SGR and the rest), OSC, string sequences such as APC (pi's cursor markers, image protocols), other escapes. */
const ESCAPE = /\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/y;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function parseAnsiLine(line: string): Cell[] {
	const cells: Cell[] = [];
	const style: Style = {};
	let text = "";
	const flush = () => {
		if (!text) return;
		for (const { segment } of graphemes.segment(text)) {
			const width = visibleWidth(segment);
			if (width <= 0) continue;
			cells.push({ text: segment, width: width >= 2 ? 2 : 1, ...style });
		}
		text = "";
	};
	let i = 0;
	while (i < line.length) {
		const char = line[i];
		if (char === "\x1b") {
			flush();
			ESCAPE.lastIndex = i;
			const match = ESCAPE.exec(line);
			if (!match || match[0].length === 0) { i++; continue; }
			if (match[3] === "m" && !match[2] && !/[<=>?]/.test(match[1] ?? "")) applySgr(style, match[1] ?? "");
			i += match[0].length;
			continue;
		}
		if (char === "\t") text += "   ";
		else if (char >= " " && char !== "\x7f" && !(char >= "\x80" && char <= "\x9f")) text += char;
		i++;
	}
	flush();
	return cells;
}

const BASE16 = [
	"#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
	"#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function hex(r: number, g: number, b: number): string {
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function rgb(r: number, g: number, b: number): string | undefined {
	return [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? hex(r, g, b) : undefined;
}

function color256(n: number): string | undefined {
	if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
	if (n < 16) return BASE16[n];
	if (n < 232) {
		const steps = [0, 95, 135, 175, 215, 255];
		const k = n - 16;
		return hex(steps[Math.floor(k / 36)], steps[Math.floor(k / 6) % 6], steps[k % 6]);
	}
	const grey = 8 + (n - 232) * 10;
	return hex(grey, grey, grey);
}

function applySgr(style: Style, params: string): void {
	const groups = (params === "" ? "0" : params).split(";").map((group) => group.split(":").map((part) => part === "" ? 0 : Number(part)));
	for (let i = 0; i < groups.length; i++) {
		const sub = groups[i];
		const code = sub[0];
		if (code === 38 || code === 48 || code === 58) {
			let color: string | undefined;
			if (sub.length > 1) {
				// Colon form: 38:5:n, 38:2:r:g:b, or 38:2:colorspace:r:g:b.
				if (sub[1] === 5) color = color256(sub[2]);
				else if (sub[1] === 2) color = sub.length >= 6 ? rgb(sub[3], sub[4], sub[5]) : rgb(sub[2], sub[3], sub[4]);
			} else if (groups[i + 1]?.[0] === 5) {
				color = color256(groups[i + 2]?.[0] ?? -1);
				i += 2;
			} else if (groups[i + 1]?.[0] === 2) {
				color = rgb(groups[i + 2]?.[0] ?? -1, groups[i + 3]?.[0] ?? -1, groups[i + 4]?.[0] ?? -1);
				i += 4;
			}
			if (color && code === 38) style.fg = color;
			else if (color && code === 48) style.bg = color;
			continue;
		}
		if (code === 0) for (const key of Object.keys(style) as (keyof Style)[]) delete style[key];
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 22) { style.bold = false; style.dim = false; }
		else if (code === 3) style.italic = true;
		else if (code === 23) style.italic = false;
		else if (code === 4) style.underline = sub[1] !== 0;
		else if (code === 21) style.underline = true;
		else if (code === 24) style.underline = false;
		else if (code === 7) style.inverse = true;
		else if (code === 27) style.inverse = false;
		else if (code === 8) style.hidden = true;
		else if (code === 28) style.hidden = false;
		else if (code === 9) style.strike = true;
		else if (code === 29) style.strike = false;
		else if (code >= 30 && code <= 37) style.fg = BASE16[code - 30];
		else if (code >= 90 && code <= 97) style.fg = BASE16[code - 82];
		else if (code === 39) delete style.fg;
		else if (code >= 40 && code <= 47) style.bg = BASE16[code - 40];
		else if (code >= 100 && code <= 107) style.bg = BASE16[code - 92];
		else if (code === 49) delete style.bg;
	}
}

/**
 * Mask known credentials after ANSI parsing. Match across styling, line wraps and inserted padding;
 * replace whole graphemes with the same number of terminal cells. This is best-effort protection
 * for known values only, not a general secret scanner.
 */
export function maskSecrets(rows: Cell[][], secrets: readonly string[]): Cell[][] {
	const needles = new Set<string>();
	for (const secret of secrets) {
		if (!secret) continue;
		const forms = [secret, JSON.stringify(secret).slice(1, -1)];
		try { forms.push(encodeURIComponent(secret)); } catch { /* raw form remains available */ }
		for (const form of forms) if (form.replace(/\s/g, "")) needles.add(form.replace(/\s/g, ""));
	}
	if (!needles.size) return rows;
	let joined = "";
	const positions: { row: number; cell: number }[] = [];
	rows.forEach((cells, row) => cells.forEach((cell, index) => {
		const text = cell.text.replace(/\s/g, "");
		joined += text;
		for (let i = 0; i < text.length; i++) positions.push({ row, cell: index });
	}));
	const masked = rows.map(() => new Set<number>());
	for (const needle of needles) {
		for (let at = joined.indexOf(needle); at !== -1; at = joined.indexOf(needle, at + 1)) {
			for (let i = at; i < at + needle.length; i++) masked[positions[i].row].add(positions[i].cell);
		}
	}
	return rows.map((cells, row) => cells.flatMap((cell, index) => {
		if (!masked[row].has(index)) return [cell];
		const star = { ...cell, text: "*", width: 1 as const };
		return cell.width === 2 ? [star, { ...star }] : [star];
	}));
}

// ---------------------------------------------------------------- cells → SVG

export interface FontMetrics {
	/** Advance of the monospace font, in em. */
	advance: number;
	ascent: number;
	descent: number;
	lineGap: number;
}

export interface SvgOptions {
	families: string[];
	metrics: FontMetrics;
	foreground: string;
	background: string;
	fontSize?: number;
}

const FONT_SIZE = 15;
const PADDING = 12;

/** Cell metrics from the monospace font, clamped so an odd font cannot break the layout. */
export function cellMetrics(metrics: FontMetrics, fontSize = FONT_SIZE) {
	const width = fontSize * Math.min(0.75, Math.max(0.45, metrics.advance || 0.6));
	const natural = (metrics.ascent || 0.8) + (metrics.descent || 0.2) + (metrics.lineGap || 0);
	const height = Math.round(fontSize * Math.min(1.6, Math.max(1.15, natural)));
	const ascent = metrics.ascent || 0.8;
	const descent = metrics.descent || 0.2;
	// Centre the font's ascent+descent box in the line.
	const baseline = (height - fontSize * (ascent + descent)) / 2 + fontSize * ascent;
	return { width, height, baseline };
}

export function cellsToSvg(rows: Cell[][], columns: number, options: SvgOptions): string {
	const fontSize = options.fontSize ?? FONT_SIZE;
	const cell = cellMetrics(options.metrics, fontSize);
	const used = Math.max(columns, ...rows.map((cells) => cells.reduce((sum, c) => sum + c.width, 0)));
	const width = Math.ceil(PADDING * 2 + used * cell.width);
	const height = Math.ceil(PADDING * 2 + Math.max(1, rows.length) * cell.height);
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="100%" height="100%" fill="${options.background}"/>`,
		`<g font-family="${escapeXml(fontFamilyList(options.families))}" font-size="${fontSize}">`,
	];
	const x = (col: number) => round(PADDING + col * cell.width);
	rows.forEach((cells, row) => {
		const top = PADDING + row * cell.height;
		const baseline = round(top + cell.baseline);
		let col = 0;
		const placed = cells.map((c) => {
			const at = { c, col, fg: (c.inverse ? c.bg : c.fg) ?? (c.inverse ? options.background : options.foreground), bg: c.inverse ? (c.fg ?? options.foreground) : c.bg };
			col += c.width;
			return at;
		});
		// Backgrounds, merged per colour.
		for (let i = 0; i < placed.length;) {
			const bg = placed[i].bg;
			let j = i + 1;
			while (j < placed.length && placed[j].bg === bg) j++;
			if (bg) {
				const end = placed[j - 1].col + placed[j - 1].c.width;
				out.push(`<rect x="${x(placed[i].col)}" y="${top}" width="${round((end - placed[i].col) * cell.width)}" height="${cell.height}" fill="${bg}"/>`);
			}
			i = j;
		}
		// Underline and strike-through as thin bars.
		for (const p of placed) {
			if (p.c.hidden) continue;
			if (p.c.underline) out.push(`<rect x="${x(p.col)}" y="${round(baseline + fontSize * 0.12)}" width="${round(p.c.width * cell.width)}" height="1" fill="${p.fg}"/>`);
			if (p.c.strike) out.push(`<rect x="${x(p.col)}" y="${round(baseline - fontSize * 0.3)}" width="${round(p.c.width * cell.width)}" height="1" fill="${p.fg}"/>`);
		}
		// Text: narrow single-unit characters share one element with explicit positions; others stand alone, centred.
		for (let i = 0; i < placed.length;) {
			const p = placed[i];
			const visible = !p.c.hidden && p.c.text.trim() !== "";
			if (!visible) { i++; continue; }
			const attrs = textAttributes(p.fg, p.c);
			if (p.c.width === 1 && p.c.text.length === 1) {
				const run = [p];
				let j = i + 1;
				while (j < placed.length) {
					const q = placed[j];
					if (q.c.width !== 1 || q.c.text.length !== 1 || q.c.hidden || q.c.text === " " || textAttributes(q.fg, q.c) !== attrs) break;
					run.push(q);
					j++;
				}
				out.push(`<text x="${run.map((r) => x(r.col)).join(" ")}" y="${baseline}"${attrs}>${escapeXml(run.map((r) => r.c.text).join(""))}</text>`);
				i = j;
			} else {
				out.push(`<text x="${round(PADDING + (p.col + p.c.width / 2) * cell.width)}" y="${baseline}" text-anchor="middle"${attrs}>${escapeXml(p.c.text)}</text>`);
				i++;
			}
		}
	});
	out.push("</g></svg>");
	return out.join("");
}

function textAttributes(fill: string, c: Cell): string {
	return ` fill="${fill}"${c.bold ? ' font-weight="bold"' : ""}${c.italic ? ' font-style="italic"' : ""}${c.dim ? ' fill-opacity="0.6"' : ""}`;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function escapeXml(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fontFamilyList(families: string[]): string {
	return families.map((family) => family === "monospace" ? family : `'${family.replace(/['\\]/g, "")}'`).join(", ");
}

// ---------------------------------------------------------------- fonts

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
		try { return readdirSync(directory); }
		catch { return []; }
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
	for (const directory of (environment.list?.(root) ?? []).filter((name) => /^com_apple_MobileAsset_Font\d+$/.test(name)).sort()) {
		const fonts = posix.join(root, directory);
		for (const asset of (environment.list?.(fonts) ?? []).filter((name) => name.endsWith(".asset")).sort()) {
			const file = posix.join(fonts, asset, "AssetData", "PingFang.ttc");
			if (environment.exists(file)) return file;
		}
	}
	return undefined;
}

function missingCjkFontMessage(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return "没有找到可用的微软雅黑（Microsoft YaHei）中文字体；请在 Windows 字体设置中启用或恢复系统微软雅黑后重试 /wecom screen";
	if (platform === "darwin") return "没有找到可用的苹方（PingFang SC）中文字体；请在 macOS 字体册中启用或恢复系统苹方后重试 /wecom screen";
	if (platform === "linux") return "Linux 没有找到可用的 CJK 中文字体，请安装系统字体后重试 /wecom screen。Debian/Ubuntu：sudo apt install fonts-noto-cjk fontconfig；Arch：sudo pacman -S noto-fonts-cjk fontconfig。";
	return "当前系统没有找到可用的 CJK 中文字体；请安装支持中文的系统字体后重试 /wecom screen";
}

/** System fonts only: monospace for terminal alignment, YaHei/PingFang on Windows/macOS, installed CJK on Linux. */
export function findFonts(environment: FontEnvironment = systemEnvironment): { mono?: string; cjk?: string } {
	const { platform, env, home, exists } = environment;
	const firstIn = (join: (...parts: string[]) => string, dirs: string[], names: string[]) => {
		for (const name of names) for (const dir of dirs) {
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
		const dirs = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", posix.join(home, "Library", "Fonts")];
		return {
			mono: firstIn(posix.join, dirs, ["Menlo.ttc", "Monaco.ttf", "SFNSMono.ttf", "Courier New.ttf"]),
			cjk: firstIn(posix.join, dirs, ["PingFang.ttc"]) ?? findPingFangAsset(environment),
		};
	}
	const matched = environment.run("fc-match", ["-f", "%{file}", "monospace"])?.trim();
	const mono = matched && exists(matched) ? matched : [
		"/usr/share/fonts/TTF/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
		"/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf", "/usr/share/fonts/liberation-mono/LiberationMono-Regular.ttf",
		"/usr/share/fonts/Adwaita/AdwaitaMono-Regular.ttf",
	].find(exists);
	const listed = (environment.run("fc-list", [":lang=zh", "file"]) ?? "")
		.split("\n").map((line) => line.trim().replace(/:\s*$/, "")).filter((path) => path && exists(path));
	const rank = (path: string) => {
		const name = posix.basename(path).toLowerCase();
		const family = [/notosanscjk|notosanssc|noto.*cjk/, /sourcehansans/, /wqy-microhei/, /wqy-zenhei/, /droidsansfallback/].findIndex((pattern) => pattern.test(name));
		return (family === -1 ? 9 : family) * 2 + (/bold|black|heavy/.test(name) ? 1 : 0);
	};
	const cjk = listed.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? [
		"/usr/share/fonts/wenquanyi/wqy-microhei/wqy-microhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
		"/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
		"/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
	].find(exists);
	return { mono, cjk };
}

/** Read the configured fonts first, then the discovered ones. A configured file that cannot be read is an error. */
export function loadFonts(configured: readonly string[] = [], environment: FontEnvironment = systemEnvironment, read: (path: string) => Uint8Array = readFileSync): FontSet {
	const found = findFonts(environment);
	const buffers: Uint8Array[] = [];
	const families: string[] = [];
	const seen = new Set<string>();
	const pathApi = environment.platform === "win32" ? win32 : posix;
	let metrics: FontMetrics | undefined;
	let hasCjk = false;
	const add = (file: string, required: boolean, preferredFamilies: readonly string[] = []) => {
		const path = pathApi.normalize(file.replace(/^~(?=$|[\\/])/, environment.home));
		const key = environment.platform === "win32" ? path.toLowerCase() : path;
		if (seen.has(key)) return;
		seen.add(key);
		let data: Uint8Array;
		try {
			data = read(path);
		} catch (error) {
			if (required) throw new Error(`无法读取 fontFiles 中的字体 ${path}（${error instanceof Error ? error.message : String(error)}）`);
			return;
		}
		const info = readFontInfo(data);
		if (!info.families.length) {
			if (required) throw new Error(`fontFiles 中的 ${path} 不是可用的 TTF、TTC 或 OTF 字体`);
			return;
		}
		buffers.push(data);
		families.push(...preferredFamilies.filter((family) => info.families.includes(family)), ...info.families);
		metrics ??= info.metrics;
		hasCjk ||= info.hasCjk;
	};
	for (const path of configured) add(path, true);
	if (found.mono) {
		add(found.mono, false);
		// resvg needs actual bold/italic faces; it does not synthesize every missing style.
		const variants = /consola\.ttf$/i.test(found.mono)
			? ["consolab.ttf", "consolai.ttf", "consolaz.ttf"].map((name) => pathApi.join(pathApi.dirname(found.mono!), name))
			: ["Bold", "Italic", "BoldItalic", "Oblique", "BoldOblique"].map((style) => found.mono!.replace(/(?:-Regular)?\.ttf$/i, `-${style}.ttf`));
		for (const path of variants) if (path !== found.mono && environment.exists(path)) add(path, false);
	}
	if (found.cjk) {
		const preferred = environment.platform === "win32" ? ["Microsoft YaHei", "Microsoft YaHei UI"]
			: environment.platform === "darwin" ? ["PingFang SC"] : ["Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC"];
		add(found.cjk, false, preferred);
		if (environment.platform === "win32") {
			const bold = found.cjk.replace(/msyh\.(ttc|ttf)$/i, "msyhbd.$1");
			if (bold !== found.cjk && environment.exists(bold)) add(bold, false, preferred);
		}
	}
	if (!buffers.length) throw new Error(`找不到可用的系统字体。${missingCjkFontMessage(environment.platform)}`);
	return {
		platform: environment.platform,
		buffers,
		families: [...new Set([...families, "monospace"])],
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
		const faces = view.getUint32(0) === 0x74746366
			? Array.from({ length: Math.min(view.getUint32(8), MAX_FONT_FACES) }, (_, index) => view.getUint32(12 + index * 4))
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
	} catch {
		/* keep what was read */
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
				if (code >= start && code <= view.getUint32(group + 4) && view.getUint32(group + 8) + code - start !== 0) return true;
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
		const bytes = data.subarray(strings + view.getUint16(at + 10), strings + view.getUint16(at + 10) + view.getUint16(at + 8));
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

const MAX_PNG_WIDTH = 2400;
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

interface ResvgModule {
	initWasm(module: Uint8Array): Promise<void>;
	Resvg: new (svg: string, options?: object) => { render(): { asPng(): Uint8Array; free(): void }; free(): void };
}

let resvg: Promise<ResvgModule> | undefined;

/** Load and initialise resvg once per process; a reload reuses the initialised module. */
function loadResvg(): Promise<ResvgModule> {
	resvg ??= (async () => {
		const require = createRequire(import.meta.url);
		const module = require("@resvg/resvg-wasm") as ResvgModule;
		try {
			await module.initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
		} catch (error) {
			if (!(error instanceof Error && /already initialized/i.test(error.message))) throw error;
		}
		return module;
	})().catch((error: unknown) => {
		resvg = undefined;
		throw new Error(`无法加载图片渲染组件 @resvg/resvg-wasm（${error instanceof Error ? error.message : String(error)}）；请在插件目录运行 npm install`);
	});
	return resvg;
}

export interface RenderOptions {
	/** Font files from the configuration, tried before the discovered ones. */
	fontFiles?: readonly string[];
	/** Values masked in the image. */
	secrets?: readonly string[];
	/** Overrides for tests. */
	fonts?: FontSet;
}

/** Render the captured screen to a PNG. */
export async function renderScreenPng(screen: CapturedScreen, options: RenderOptions = {}): Promise<Uint8Array> {
	const rows = trimBlankRows(maskSecrets(screen.lines.map(parseAnsiLine), options.secrets ?? []));
	if (!rows.length) throw new Error("当前终端画面是空的");
	const fonts = options.fonts ?? loadFonts(options.fontFiles);
	if (!fonts.hasCjk && rows.some((cells) => cells.some((cell) => CJK.test(cell.text)))) {
		throw new Error(missingCjkFontMessage(fonts.platform));
	}
	const svg = cellsToSvg(rows, screen.columns, { families: fonts.families, metrics: fonts.metrics, foreground: screen.foreground, background: screen.background });
	const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 1);
	const { Resvg } = await loadResvg();
	const renderer = new Resvg(svg, {
		font: { fontBuffers: fonts.buffers, defaultFontFamily: fonts.families[0], monospaceFamily: fonts.families[0] },
		fitTo: { mode: "zoom", value: Math.min(2, MAX_PNG_WIDTH / width) },
	});
	try {
		const image = renderer.render();
		try {
			return image.asPng();
		} finally {
			image.free();
		}
	} finally {
		renderer.free();
	}
}

/** Blank lines at the top and bottom carry nothing. */
function trimBlankRows(rows: Cell[][]): Cell[][] {
	const blank = (cells: Cell[]) => cells.every((cell) => !cell.text.trim() && !cell.bg && !cell.inverse);
	let start = 0;
	let end = rows.length;
	while (start < end && blank(rows[start])) start++;
	while (end > start && blank(rows[end - 1])) end--;
	return rows.slice(start, end);
}

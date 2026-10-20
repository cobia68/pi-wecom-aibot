/**
 * Draw captured terminal lines as a PNG: ANSI styles become a grid of cells, the grid becomes SVG,
 * and resvg's WebAssembly build rasterises it, so every platform renders the same way without a
 * browser or native binary. Fonts are discovered in fonts.ts. Runs in pi only; the gateway never loads it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type FontMetrics, type FontSet, loadFonts, missingCjkFontMessage } from "./fonts.ts";

export interface CapturedScreen {
	/** Terminal lines with ANSI styling, top to bottom. */
	lines: string[];
	columns: number;
	/** The terminal's default colours as #rrggbb. */
	foreground: string;
	background: string;
	/** Theme colours for the header; the capture always reads them from the active theme. */
	palette: ScreenPalette;
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
/** Every mutable style field, for SGR 0. */
const STYLE_KEYS = [
	"fg",
	"bg",
	"bold",
	"dim",
	"italic",
	"underline",
	"strike",
	"inverse",
	"hidden",
] as const satisfies readonly (keyof Style)[];

// ---------------------------------------------------------------- ANSI → cells

/** CSI (SGR and the rest), OSC, string sequences such as APC (pi's cursor markers, image protocols), other escapes. */
const ESCAPE =
	/\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/y;
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
			if (!match || match[0].length === 0) {
				i++;
				continue;
			}
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
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#ffffff",
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
	const groups = (params === "" ? "0" : params)
		.split(";")
		.map((group) => group.split(":").map((part) => (part === "" ? 0 : Number(part))));
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
		if (code === 0) for (const key of STYLE_KEYS) delete style[key];
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 3) style.italic = true;
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
		try {
			forms.push(encodeURIComponent(secret));
		} catch {
			/* raw form remains available */
		}
		for (const form of forms) if (form.replace(/\s/g, "")) needles.add(form.replace(/\s/g, ""));
	}
	if (!needles.size) return rows;
	let joined = "";
	const positions: { row: number; cell: number }[] = [];
	rows.forEach((cells, row) => {
		cells.forEach((cell, index) => {
			const text = cell.text.replace(/\s/g, "");
			joined += text;
			for (let i = 0; i < text.length; i++) positions.push({ row, cell: index });
		});
	});
	const masked = rows.map(() => new Set<number>());
	for (const needle of needles) {
		for (let at = joined.indexOf(needle); at !== -1; at = joined.indexOf(needle, at + 1)) {
			for (let i = at; i < at + needle.length; i++) masked[positions[i].row].add(positions[i].cell);
		}
	}
	return rows.map((cells, row) =>
		cells.flatMap((cell, index) => {
			if (!masked[row].has(index)) return [cell];
			const star = { ...cell, text: "*", width: 1 as const };
			return cell.width === 2 ? [star, { ...star }] : [star];
		}),
	);
}

// ---------------------------------------------------------------- cells → SVG

/** Theme colours as #rrggbb; the capture reads all of them from pi's theme. */
export interface ScreenPalette {
	accent: string;
	muted: string;
	dim: string;
	warning: string;
}

/** A card header above the terminal grid, set in proportional type instead of terminal cells. */
export interface ScreenHeader {
	/** The bold first line. */
	title: string;
	/** A short status pill at the right of the title. */
	badge: string;
	/** The pill's colour: the theme accent (default) or its warning colour. */
	tone?: "accent" | "warning";
	/** A muted line under the title. */
	subtitle: string;
	/** The smallest line, set monospace: an identifier people compare or copy. */
	caption: string;
}

export interface SvgOptions {
	/** The terminal grid's font stack, monospace first. */
	families: string[];
	/** The header's proportional stack, tried before `families`. */
	sansFamilies?: readonly string[];
	metrics: FontMetrics;
	foreground: string;
	background: string;
	palette: ScreenPalette;
	header?: ScreenHeader;
	/** Families that have the emoji glyphs; the header's leading icons use these alone. */
	emojiFamilies?: readonly string[];
	/** The emoji font's advance in em. */
	emojiAdvance?: number;
	fontSize?: number;
	lineHeight?: number;
}

const FONT_SIZE = 15;
/** Margins around the grid; the header band is full-bleed. */
const PADDING_X = 24;
const PADDING_Y = 20;
/** Rows filled edge to edge with one background (messages, tool output) become blocks with round corners. */
const BLOCK_RADIUS = 6;
/** Wide glyphs grow toward their two cells, at most by this factor: monospace Latin is wider than half a CJK em. */
const WIDE_SCALE = 1.12;

/** Cell metrics from the monospace font, clamped so an odd font cannot break the layout. */
export function cellMetrics(metrics: FontMetrics, fontSize = FONT_SIZE, lineHeight?: number) {
	const width = fontSize * Math.min(0.75, Math.max(0.45, metrics.advance || 0.6));
	const natural = (metrics.ascent || 0.8) + (metrics.descent || 0.2) + (metrics.lineGap || 0);
	const height = Math.round(fontSize * (lineHeight ?? Math.min(1.6, Math.max(1.15, natural))));
	const ascent = metrics.ascent || 0.8;
	const descent = metrics.descent || 0.2;
	// Centre the font's ascent+descent box in the line.
	const baseline = (height - fontSize * (ascent + descent)) / 2 + fontSize * ascent;
	return { width, height, baseline };
}

interface Placed {
	c: Cell;
	col: number;
	fg: string;
	bg?: string;
}

export function cellsToSvg(rows: Cell[][], columns: number, options: SvgOptions): string {
	const fontSize = options.fontSize ?? FONT_SIZE;
	const cell = cellMetrics(options.metrics, fontSize, options.lineHeight);
	const used = Math.max(columns, ...rows.map((cells) => cells.reduce((sum, c) => sum + c.width, 0)));
	const width = Math.ceil(PADDING_X * 2 + used * cell.width);
	const header = options.header ? headerSvg(options.header, width, options) : undefined;
	const gridTop = (header?.height ?? 0) + PADDING_Y;
	const height = Math.ceil(gridTop + rows.length * cell.height + PADDING_Y);
	const x = (col: number) => round(PADDING_X + col * cell.width);
	const y = (row: number) => round(gridTop + row * cell.height);
	const placed = rows.map((cells) => {
		let col = 0;
		return cells.map((c): Placed => {
			const at = {
				c,
				col,
				fg: (c.inverse ? c.bg : c.fg) ?? (c.inverse ? options.background : options.foreground),
				bg: c.inverse ? (c.fg ?? options.foreground) : c.bg,
			};
			col += c.width;
			return at;
		});
	});
	// A row filled edge to edge over one background belongs to a block: a message or tool output.
	const blockColor = placed.map((cells) => {
		const first = cells[0];
		const last = cells.at(-1);
		return first?.bg && last && last.col + last.c.width === used && last.bg === first.bg && cells.every((p) => p.bg)
			? first.bg
			: undefined;
	});
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="100%" height="100%" fill="${options.background}"/>`,
		...(header ? [header.svg] : []),
	];
	// Consecutive block rows of one colour become one rounded rectangle.
	for (let row = 0; row < rows.length; ) {
		const color = blockColor[row];
		let end = row + 1;
		while (color && end < rows.length && blockColor[end] === color) end++;
		if (color)
			out.push(
				`<rect x="${x(0)}" y="${y(row)}" width="${round(used * cell.width)}" height="${round((end - row) * cell.height)}" rx="${BLOCK_RADIUS}" fill="${color}"/>`,
			);
		row = end;
	}
	// Other backgrounds, merged per colour within a row.
	placed.forEach((cells, row) => {
		for (let i = 0; i < cells.length; ) {
			const bg = cells[i].bg;
			let j = i + 1;
			while (j < cells.length && cells[j].bg === bg) j++;
			if (bg && bg !== blockColor[row]) {
				const end = cells[j - 1].col + cells[j - 1].c.width;
				out.push(
					`<rect x="${x(cells[i].col)}" y="${y(row)}" width="${round((end - cells[i].col) * cell.width)}" height="${cell.height}" fill="${bg}"/>`,
				);
			}
			i = j;
		}
	});
	// A wide glyph is drawn larger, up to filling its two cells, with its centre (about 0.38 em up) kept in place.
	const wide = Math.min(WIDE_SCALE, Math.max(1, (2 * cell.width) / fontSize));
	const wideAttrs = wide > 1 ? ` font-size="${round(fontSize * wide)}"` : "";
	const wideShift = fontSize * (wide - 1) * 0.38;
	out.push(`<g font-family="${escapeXml(fontFamilyList(options.families))}" font-size="${fontSize}">`);
	placed.forEach((cells, row) => {
		const baseline = round(y(row) + cell.baseline);
		// Underline and strike-through as thin bars.
		for (const p of cells) {
			if (p.c.hidden) continue;
			if (p.c.underline)
				out.push(
					`<rect x="${x(p.col)}" y="${round(baseline + fontSize * 0.12)}" width="${round(p.c.width * cell.width)}" height="1" fill="${p.fg}"/>`,
				);
			if (p.c.strike)
				out.push(
					`<rect x="${x(p.col)}" y="${round(baseline - fontSize * 0.3)}" width="${round(p.c.width * cell.width)}" height="1" fill="${p.fg}"/>`,
				);
		}
		// Text: narrow single-unit characters share one element with explicit positions; others stand alone, centred.
		for (let i = 0; i < cells.length; ) {
			const p = cells[i];
			if (p.c.hidden || p.c.text.trim() === "") {
				i++;
				continue;
			}
			const attrs = textAttributes(p.fg, p.c);
			if (p.c.width === 1 && p.c.text.length === 1) {
				const run = [p];
				let j = i + 1;
				while (j < cells.length) {
					const q = cells[j];
					if (
						q.c.width !== 1 ||
						q.c.text.length !== 1 ||
						q.c.hidden ||
						q.c.text === " " ||
						textAttributes(q.fg, q.c) !== attrs
					)
						break;
					run.push(q);
					j++;
				}
				out.push(
					`<text x="${run.map((r) => x(r.col)).join(" ")}" y="${baseline}"${attrs}>${escapeXml(run.map((r) => r.c.text).join(""))}</text>`,
				);
				i = j;
			} else {
				const wideGlyph = p.c.width === 2;
				out.push(
					`<text x="${round(PADDING_X + (p.col + p.c.width / 2) * cell.width)}" y="${wideGlyph ? round(baseline + wideShift) : baseline}" text-anchor="middle"${wideGlyph ? wideAttrs : ""}${attrs}>${escapeXml(p.c.text)}</text>`,
				);
				i++;
			}
		}
	});
	out.push("</g></svg>");
	return out.join("");
}

/** Header sizes in SVG units, before the PNG zoom. */
const HEADER = {
	top: 16,
	bottom: 14,
	tile: 36,
	gap: 12,
	title: 17,
	subtitle: 12.5,
	caption: 11.5,
	badge: 11.5,
	pill: 20,
} as const;
/** Pi's mark (pi.dev/logo-auto.svg), in its three brand colours. */
const PI_LOGO = [
	'<path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/>',
	'<path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/>',
	'<path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/>',
].join("");

/**
 * A full-width band tinted from the terminal's own colours, so it suits light and dark themes: the
 * pi mark on a neutral tile, the bold title with a status pill, then a muted subtitle and caption.
 */
function headerSvg(header: ScreenHeader, width: number, options: SvgOptions): { svg: string; height: number } {
	const colors = headerColors(options);
	const sans = escapeXml(fontFamilyList([...new Set([...(options.sansFamilies ?? []), ...options.families])]));
	const mono = escapeXml(fontFamilyList(options.families));
	const advance = Math.min(0.75, Math.max(0.45, options.metrics.advance || 0.6));
	const tone = header.tone === "warning" ? colors.warning : colors.accent;
	// Line boxes: title 24, subtitle 18, caption 18; the tile sits beside the first two.
	const titleTop = HEADER.top;
	const subtitleTop = titleTop + 24;
	const captionTop = subtitleTop + 20;
	const height = captionTop + 18 + HEADER.bottom;
	const left = PADDING_X;
	const right = width - PADDING_X;
	const textX = left + HEADER.tile + HEADER.gap;
	const tileTop = titleTop + (24 + 18 - HEADER.tile) / 2;
	const pillWidth = round(fitWidth(header.badge, sansMeasure(HEADER.badge)) + 16);
	const pillX = round(right - pillWidth);
	const pillTop = titleTop + (24 - HEADER.pill) / 2;
	const titleWidth = Math.max(0, pillX - 12 - textX);
	// Baselines put the text's visual middle (about 0.36 em above the baseline) in the middle of its box.
	const baseline = (top: number, box: number, size: number) => round(top + box / 2 + size * 0.36);
	// A leading emoji is drawn with the emoji font alone: CJK fonts claim some of these codepoints and
	// would render a missing-glyph box when they lead the stack. Without a monochrome emoji font
	// (stock Windows/macOS ship only color emoji) the icon is dropped rather than drawn as a box.
	const emojiStack = options.emojiFamilies?.length ? escapeXml(fontFamilyList(options.emojiFamilies)) : undefined;
	const emojiAdvance = options.emojiAdvance ?? 1.1;
	const line = (
		text: string,
		size: number,
		top: number,
		box: number,
		limit: number,
		family: string,
		measure: Measure,
		fill: string,
		weight = "",
	): string => {
		const match = /^(\p{Extended_Pictographic}\uFE0F?)\s+(.*)$/u.exec(text);
		const icon = emojiStack ? (match?.[1] ?? "") : "";
		const rest = match ? match[2] : text;
		const offset = icon ? size * (emojiAdvance + 0.3) : 0;
		const y = baseline(top, box, size);
		const iconSvg = icon
			? `<text x="${textX}" y="${y}" font-family="${emojiStack}" font-size="${size}" fill="${fill}">${escapeXml(icon)}</text>`
			: "";
		return `${iconSvg}<text x="${round(textX + offset)}" y="${y}" font-family="${family}" font-size="${size}"${weight} fill="${fill}">${escapeXml(fitText(rest, Math.max(0, limit - offset), measure))}</text>`;
	};
	const svg = [
		`<rect width="${width}" height="${height}" fill="${colors.surface}"/>`,
		`<rect y="${height}" width="${width}" height="1" fill="${colors.divider}"/>`,
		`<rect x="${left}" y="${tileTop}" width="${HEADER.tile}" height="${HEADER.tile}" rx="9" fill="${colors.divider}"/>`,
		`<svg x="${left + 7}" y="${tileTop + 7}" width="22" height="22" viewBox="165.29 165.29 469.43 469.43">${PI_LOGO}</svg>`,
		`<rect x="${pillX}" y="${pillTop}" width="${pillWidth}" height="${HEADER.pill}" rx="${HEADER.pill / 2}" fill="${tone}" fill-opacity="0.16"/>`,
		`<text x="${round(pillX + pillWidth / 2)}" y="${baseline(pillTop, HEADER.pill, HEADER.badge)}" text-anchor="middle" font-family="${sans}" font-size="${HEADER.badge}" fill="${tone}">${escapeXml(header.badge)}</text>`,
		// The title is estimated and shortened with an ellipsis; there is no second clip behind it.
		line(
			header.title,
			HEADER.title,
			titleTop,
			24,
			titleWidth,
			sans,
			sansMeasure(HEADER.title),
			colors.title,
			' font-weight="600"',
		),
		line(
			header.subtitle,
			HEADER.subtitle,
			subtitleTop,
			18,
			right - textX,
			sans,
			sansMeasure(HEADER.subtitle),
			colors.muted,
		),
		line(
			header.caption,
			HEADER.caption,
			captionTop,
			18,
			right - textX,
			mono,
			(s) => HEADER.caption * advance * Math.max(1, visibleWidth(s)),
			colors.dim,
		),
	].join("");
	return { svg, height: height + 1 };
}

function headerColors(options: SvgOptions) {
	const { foreground: fg, background: bg, palette } = options;
	const dark = isDark(bg);
	return {
		surface: mix(fg, bg, dark ? 0.06 : 0.035),
		divider: mix(fg, bg, dark ? 0.14 : 0.1),
		title: fg,
		muted: palette.muted,
		dim: palette.dim,
		accent: palette.accent,
		warning: palette.warning,
	};
}

/** Colours reaching the renderer are #rrggbb by construction (ANSI parsing and colorToHex); anything else is a bug. */
function rgbOf(color: string): [number, number, number] {
	const match = /^#([0-9a-f]{6})$/i.exec(color);
	if (!match) throw new Error(`invalid colour: ${color}`);
	const n = parseInt(match[1], 16);
	return [n >> 16, (n >> 8) & 255, n & 255];
}

/** `weight` of a over b. */
function mix(a: string, b: string, weight: number): string {
	const x = rgbOf(a);
	const y = rgbOf(b);
	return hex(...(x.map((v, i) => Math.round(v * weight + y[i] * (1 - weight))) as [number, number, number]));
}

function isDark(color: string): boolean {
	const c = rgbOf(color);
	return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5;
}

type Measure = (segment: string) => number;

/** An estimate for proportional text: wide glyphs (and the ellipsis, full-width in CJK fonts) one em, others about half. */
function sansMeasure(size: number): Measure {
	return (segment) =>
		size * (visibleWidth(segment) >= 2 || segment === "…" ? 1 : /[A-Z0-9mw]/.test(segment) ? 0.68 : 0.55);
}

function fitWidth(text: string, measure: Measure): number {
	let width = 0;
	for (const { segment } of graphemes.segment(text)) width += measure(segment);
	return width;
}

/** The text, or as much of it as fits followed by an ellipsis. */
export function fitText(text: string, max: number, measure: Measure): string {
	if (fitWidth(text, measure) <= max) return text;
	const budget = max - measure("…");
	let kept = "";
	let width = 0;
	for (const { segment } of graphemes.segment(text)) {
		width += measure(segment);
		if (width > budget) break;
		kept += segment;
	}
	return `${kept.trimEnd()}…`;
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
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fontFamilyList(families: readonly string[]): string {
	return families.map((family) => (family === "monospace" ? family : `'${family.replace(/['\\]/g, "")}'`)).join(", ");
}

// ---------------------------------------------------------------- fonts

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
		throw new Error(
			`无法加载图片渲染组件 @resvg/resvg-wasm（${error instanceof Error ? error.message : String(error)}）；请在插件目录运行 npm install`,
		);
	});
	return resvg;
}

export interface RenderOptions {
	/** Values masked in the image, header included. */
	secrets?: readonly string[];
	/** Overrides for tests. */
	fonts?: FontSet;
	/** A card header above the terminal content. */
	header?: ScreenHeader;
	fontSize?: number;
	lineHeight?: number;
}

/** Render the captured screen to a PNG. */
export async function renderScreenPng(screen: CapturedScreen, options: RenderOptions = {}): Promise<Uint8Array> {
	const secrets = options.secrets ?? [];
	const rows = trimBlankRows(maskSecrets(screen.lines.map(parseAnsiLine), secrets));
	if (!rows.length) throw new Error("当前终端画面是空的");
	const header = options.header && maskHeader(options.header, secrets);
	const fonts = options.fonts ?? loadFonts();
	const headerText = header ? [header.title, header.badge, header.subtitle, header.caption].join("") : "";
	if (!fonts.hasCjk && (CJK.test(headerText) || rows.some((cells) => cells.some((cell) => CJK.test(cell.text))))) {
		throw new Error(missingCjkFontMessage(fonts.platform));
	}
	const svg = cellsToSvg(rows, screen.columns, {
		families: fonts.families,
		sansFamilies: fonts.sansFamilies,
		metrics: fonts.metrics,
		foreground: screen.foreground,
		background: screen.background,
		palette: screen.palette,
		emojiFamilies: fonts.emojiFamilies,
		emojiAdvance: fonts.emojiAdvance,
		header,
		fontSize: options.fontSize,
		lineHeight: options.lineHeight,
	});
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

/** Header text is masked like the screen: plain text through the same cell parser. */
function maskHeader(header: ScreenHeader, secrets: readonly string[]): ScreenHeader {
	const mask = (text: string) =>
		maskSecrets([parseAnsiLine(text)], secrets)[0]
			.map((cell) => cell.text)
			.join("");
	return {
		...header,
		title: mask(header.title),
		badge: mask(header.badge),
		subtitle: mask(header.subtitle),
		caption: mask(header.caption),
	};
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

/** Terminal lines as plain text, and known secrets masked in any text pi sends. */
import { visibleWidth } from "@earendil-works/pi-tui";

export interface Cell {
	/** One grapheme; a wide one spans both its columns. */
	text: string;
	width: 1 | 2;
	hidden?: boolean;
}

/** CSI (SGR and the rest), OSC, string sequences such as APC (pi's cursor markers), other escapes. */
const ESCAPE =
	/\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/y;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Escapes are dropped; of the styling only SGR 8 (hidden) matters, its text becomes blanks. */
export function parseAnsiLine(line: string): Cell[] {
	const cells: Cell[] = [];
	let hidden = false;
	let text = "";
	const flush = () => {
		if (!text) return;
		for (const { segment } of graphemes.segment(text)) {
			const width = visibleWidth(segment);
			if (width <= 0) continue;
			cells.push({ text: segment, width: width >= 2 ? 2 : 1, ...(hidden ? { hidden } : {}) });
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
			if (match[3] === "m" && !match[2] && !/[<=>?]/.test(match[1] ?? ""))
				hidden = hiddenAfter(hidden, match[1] ?? "");
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

/** A colour's values (38;5;n, 38;2;r;g;b) are skipped, so none is read as 8; the colon form holds them inside. */
function hiddenAfter(hidden: boolean, params: string): boolean {
	const groups = (params === "" ? "0" : params).split(";");
	for (let i = 0; i < groups.length; i++) {
		const [code, ...colon] = groups[i].split(":").map((part) => Number(part || 0));
		if (code === 38 || code === 48 || code === 58) {
			const kind = Number(groups[i + 1]);
			if (!colon.length) i += kind === 5 ? 2 : kind === 2 ? 4 : 0;
			continue;
		}
		if (code === 0 || code === 28) hidden = false;
		else if (code === 8) hidden = true;
	}
	return hidden;
}

/**
 * Best-effort masking of known values only, not a secret scanner: matches across styling, wraps and padding,
 * and replaces whole graphemes with the same number of cells.
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

/** Styling dropped, hidden text and known secrets blanked, trailing spaces and blank edge rows gone. */
export function plainLines(lines: readonly string[], secrets: readonly string[] = []): string[] {
	const rows = maskSecrets(lines.map(parseAnsiLine), secrets).map((cells) =>
		cells
			.map((cell) => (cell.hidden ? " ".repeat(cell.width) : cell.text))
			.join("")
			.trimEnd(),
	);
	let start = 0;
	let end = rows.length;
	while (start < end && !rows[start].trim()) start++;
	while (end > start && !rows[end - 1].trim()) end--;
	return rows.slice(start, end);
}

/** Known secrets in any text (a reply, a notice) masked as on the terminal; line breaks and Markdown stay. */
export function maskText(text: string, secrets: readonly string[]): string {
	if (!secrets.some(Boolean)) return text;
	const lines = text.split("\n");
	const masked = maskSecrets(
		lines.map((line) => [...line].map((char): Cell => ({ text: char, width: 1 }))),
		secrets,
	);
	return masked.map((cells) => cells.map((cell) => cell.text).join("")).join("\n");
}

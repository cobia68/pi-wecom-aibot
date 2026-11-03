/** Split Markdown without dropping UTF-8 text; fenced code is closed and reopened at message boundaries. */
export function markdownParts(text: string, maxBytes: number): string[] {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) throw new Error("正文分段空间不足");
	const parts: string[] = [];
	let fence: { marker: string; opening: string } | undefined;
	let part = "";
	let bytes = 0;
	let hasBody = false;
	const finish = () => {
		if (!hasBody) return;
		parts.push(part + (fence ? `${part.endsWith("\n") ? "" : "\n"}${fence.marker}` : ""));
		part = fence ? `${fence.opening}\n` : "";
		bytes = Buffer.byteLength(part);
		hasBody = false;
	};
	for (const line of text.replace(/\r\n?/g, "\n").split(/(?<=\n)/)) {
		const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?$/.exec(line);
		let nextFence = fence;
		if (marker) {
			if (fence) {
				if (marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
					if (Buffer.byteLength(line) > maxBytes / 2)
						throw new Error("代码围栏过长，无法分段发送；请在 pi 查看原文");
					nextFence = undefined;
				}
			} else if (marker[1][0] !== "`" || !marker[2].includes("`")) {
				nextFence = { marker: marker[1], opening: line.trimEnd() };
				// A pathological fence must not consume the next message's entire budget or cause an empty-part loop.
				if (Buffer.byteLength(`${nextFence.opening}\n\n${nextFence.marker}`) > maxBytes / 2)
					throw new Error("代码围栏过长，无法分段发送；请在 pi 查看原文");
			}
		}
		const closingBytes = Math.max(
			nextFence ? Buffer.byteLength(`\n${nextFence.marker}`) : 0,
			fence ? Buffer.byteLength(`\n${fence.marker}`) : 0,
		);
		const data = Buffer.from(line);
		if (hasBody && bytes + data.length + closingBytes > maxBytes) finish();
		let offset = 0;
		while (offset < data.length) {
			const budget = maxBytes - bytes - closingBytes;
			let end = Math.min(offset + budget, data.length);
			while (end < data.length && end > offset && (data[end] & 0xc0) === 0x80) end--;
			if (end <= offset) throw new Error("正文分段空间不足");
			part += data.subarray(offset, end).toString("utf8");
			bytes += end - offset;
			hasBody = true;
			offset = end;
			if (offset === data.length) fence = nextFence;
			else finish();
		}
	}
	finish();
	return parts;
}

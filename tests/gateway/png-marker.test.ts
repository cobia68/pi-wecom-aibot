import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "node:zlib";
import { inspectPng, stampPng } from "../../src/gateway/png-marker.ts";
import { TINY_PNG } from "../support/media.ts";

const SESSION = "01234567-89ab-4cde-8012-3456789abcde";

/** Walk every chunk of a complete PNG and check each CRC. */
function chunks(png: Buffer): { type: string; data: Buffer }[] {
	const list: { type: string; data: Buffer }[] = [];
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("latin1", offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		assert.equal(
			crc32(Buffer.concat([png.subarray(offset + 4, offset + 8), data])),
			png.readUInt32BE(offset + 8 + length),
		);
		list.push({ type, data });
		offset += 12 + length;
	}
	return list;
}

function textChunk(text: string): Buffer {
	const data = Buffer.from(text, "latin1");
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write("tEXt", 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

test("the marker is a valid tEXt chunk at byte 33, and every original chunk stays as it was", () => {
	const stamped = stampPng(TINY_PNG, SESSION);
	assert.equal(stamped.toString("latin1", 33 + 4, 33 + 8), "tEXt");
	const after = chunks(stamped);
	assert.deepEqual(
		after.map((chunk) => chunk.type),
		["IHDR", "tEXt", "IDAT", "IEND"],
	);
	assert.equal(after[1].data.toString("latin1"), `pi-wecom-aibot\0session=${SESSION}`);
	assert.deepEqual(
		after.filter((chunk) => chunk.type !== "tEXt"),
		chunks(TINY_PNG),
	);
	assert.deepEqual(inspectPng(stamped), {
		width: 1,
		height: 1,
		chunks: ["IHDR", "tEXt", "IDAT"],
		session: SESSION,
	});
});

test("any session ID survives the Latin-1 text chunk", () => {
	const unusual = "会话-1 `x` %41";
	assert.equal(inspectPng(stampPng(TINY_PNG, unusual))?.session, unusual);
});

test("the head of the file is enough, and a cut-off marker is never trusted", () => {
	const stamped = stampPng(TINY_PNG, SESSION);
	const markerEnd = 33 + 12 + stamped.readUInt32BE(33);
	assert.equal(inspectPng(stamped.subarray(0, markerEnd))?.session, SESSION);
	const cut = inspectPng(stamped.subarray(0, markerEnd - 1));
	assert.equal(cut?.session, undefined);
	assert.equal(cut?.markerProblem, "标记块超出读取范围");
	assert.deepEqual(cut?.chunks, ["IHDR", "tEXt", "…"]);
	// A cut inside the marker's own chunk header (bytes 33–41) cannot even name the chunk.
	assert.deepEqual(inspectPng(stamped.subarray(0, 40))?.chunks, ["IHDR", "…"]);
	assert.equal(inspectPng(stamped.subarray(0, 45))?.markerProblem, "标记块超出读取范围");
});

test("a changed marker byte fails its CRC instead of naming another session", () => {
	const stamped = stampPng(TINY_PNG, SESSION);
	stamped[33 + 8 + "pi-wecom-aibot\0session=".length] ^= 1;
	const report = inspectPng(stamped);
	assert.equal(report?.session, undefined);
	assert.equal(report?.markerProblem, "标记块 CRC 不符");
});

test("another program's text chunk is listed but never read as a marker", () => {
	const foreign = Buffer.concat([TINY_PNG.subarray(0, 33), textChunk("Software\0resvg"), TINY_PNG.subarray(33)]);
	assert.deepEqual(inspectPng(foreign), { width: 1, height: 1, chunks: ["IHDR", "tEXt", "IDAT"] });
});

test("garbage after IHDR ends the walk instead of throwing", () => {
	const longLength = stampPng(TINY_PNG, SESSION);
	longLength.writeUInt32BE(0xffffffff, 33);
	assert.deepEqual(inspectPng(longLength)?.chunks, ["IHDR", "…"]);
	const badType = Buffer.from(TINY_PNG);
	badType.fill(0, 37, 41);
	assert.deepEqual(inspectPng(badType)?.chunks, ["IHDR", "…"]);
});

test("only a PNG is stamped or inspected", () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
	assert.throws(() => stampPng(jpeg, SESSION), /PNG/);
	assert.throws(() => stampPng(TINY_PNG.subarray(0, 20), SESSION), /PNG/);
	assert.equal(inspectPng(jpeg), undefined);
	assert.equal(inspectPng(TINY_PNG.subarray(0, 20)), undefined);
});

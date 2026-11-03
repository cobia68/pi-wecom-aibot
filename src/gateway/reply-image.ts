/** Read a generated PNG for upload without following a file symlink or allocating from an unbounded path. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DeliveryError } from "../shared/delivery.ts";
import { WECOM_IMAGE_MAX_BYTES } from "../shared/wecom-protocol.ts";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function readReplyImage(path: string): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size < 24 || stat.size > WECOM_IMAGE_MAX_BYTES)
			throw new DeliveryError("长图不是有效的 PNG 文件或超过 10 MiB", "rejected");
		const data = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await file.read(data, offset, data.length - offset, null);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset !== stat.size) throw new DeliveryError("长图文件在读取期间已改变", "rejected");
		if (!data.subarray(0, PNG.length).equals(PNG) || data.toString("ascii", 12, 16) !== "IHDR")
			throw new DeliveryError("长图不是 PNG 格式", "rejected");
		return data.subarray(0, offset);
	} finally {
		await file.close();
	}
}

/**
 * Which control card each chat has of this session: delivery receipts, journaled in the session so a reload
 * never sends an automatic duplicate. They outlive registrations and never keep a gateway alive.
 */

import { controlCardFor, controlCardId } from "../shared/control-card.ts";
import { DeliveryError, deliveryFailure } from "../shared/delivery.ts";
import { validChat } from "../shared/gateway-protocol.ts";
import { errorMessage } from "../shared/text.ts";
import { asRecord, type ChatRef } from "../shared/wecom-protocol.ts";

export const CONTROL_CARD_ENTRY = "wecom-aibot-control-card";
const MAX_CHATS = 1000;

type ReceiptState = "sent" | "unknown" | "not_sent" | "rejected";
export interface ControlReceipt {
	version: 1;
	sessionId: string;
	botId: string;
	chat: ChatRef;
	cardId: string;
	state: ReceiptState;
}

export class ControlReceipts {
	readonly sessionId: string;
	private readonly persist: (receipt: ControlReceipt) => void;
	private readonly log: (message: string) => void;
	private readonly receipts = new Map<string, ControlReceipt>();
	private readonly sending = new Map<string, Promise<boolean>>();
	private disposed = false;

	constructor(
		sessionId: string,
		entries: readonly unknown[],
		persist: (receipt: ControlReceipt) => void,
		log: (message: string) => void,
	) {
		this.sessionId = sessionId;
		this.persist = persist;
		this.log = log;
		// Deliveries are irreversible external facts, not branch-dependent conversation state. A /tree move
		// must not make an already delivered card disappear. Forks have another session ID and inherit none.
		for (const value of entries) {
			const entry = asRecord(value);
			if (entry?.type !== "custom" || entry.customType !== CONTROL_CARD_ENTRY || !validReceipt(entry.data)) continue;
			const receipt = entry.data;
			if (receipt.sessionId !== sessionId) continue;
			const key = chatKey(receipt.botId, receipt.chat);
			if (this.receipts.has(key) || this.receipts.size < MAX_CHATS) this.receipts.set(key, receipt);
		}
	}

	get pending(): number {
		return this.sending.size;
	}

	/** Only definite non-deliveries can be picked up by a later ready registration. */
	retryable(botId: string): ChatRef[] {
		return [...this.receipts.values()]
			.filter((receipt) => receipt.botId === botId && receipt.state === "not_sent")
			.map((receipt) => ({ ...receipt.chat }));
	}

	/** false means the existing card was retained. force is an explicit request to publish a new copy. */
	ensure(botId: string, chat: ChatRef, deliver: (cardId: string) => Promise<void>, force = false): Promise<boolean> {
		if (this.disposed) return Promise.reject(new DeliveryError("会话已停止，未发送控制卡", "not_sent"));
		const key = chatKey(botId, chat);
		const inFlight = this.sending.get(key);
		if (inFlight) {
			return inFlight.then(
				() => false,
				(error: unknown) => {
					// A new registration may already be ready when the old, definitely unwritten attempt fails.
					if (deliveryFailure(error) === "not_sent") return this.ensure(botId, chat, deliver, force);
					throw error;
				},
			);
		}
		const previous = this.receipts.get(key);
		if (!force && previous && previous.state !== "not_sent") return Promise.resolve(false);
		if (!previous && this.receipts.size >= MAX_CHATS)
			return Promise.reject(new DeliveryError("本 session 的控制卡聊天数已达上限", "rejected"));
		const cardId = previous?.state === "not_sent" && !force ? previous.cardId : controlCardId(this.sessionId);
		// Register the attempt before calling any adapter: synchronous callbacks must not send a second copy.
		const attempt = Promise.resolve()
			.then(async () => {
				if (this.disposed) throw new DeliveryError("会话已停止，未发送控制卡", "not_sent");
				const receipt: ControlReceipt = {
					version: 1,
					sessionId: this.sessionId,
					botId,
					chat: { ...chat },
					cardId,
					state: "unknown",
				};
				// Write ahead: a crash after the wire write but before ACK cannot cause an automatic duplicate.
				try {
					this.persist(receipt);
				} catch (error) {
					// pi may have appended the entry in memory before its disk write failed. Undo that
					// reservation with a definite non-delivery; no transport write has happened yet.
					this.remember(key, { ...receipt, state: "not_sent" });
					throw new DeliveryError(`无法保存控制卡发送记录：${errorMessage(error)}`, "not_sent");
				}
				this.receipts.set(key, receipt);
				try {
					await deliver(cardId);
				} catch (error) {
					this.remember(key, { ...receipt, state: deliveryFailure(error) });
					throw error;
				}
				this.remember(key, { ...receipt, state: "sent" });
				return true;
			})
			.finally(() => {
				if (this.sending.get(key) === attempt) this.sending.delete(key);
			});
		this.sending.set(key, attempt);
		return attempt;
	}

	dispose(): void {
		this.disposed = true;
	}

	private remember(key: string, receipt: ControlReceipt): void {
		this.receipts.set(key, receipt);
		if (this.disposed) return;
		try {
			this.persist(receipt);
		} catch (error) {
			// If the write-ahead receipt reached storage, its unknown state still prevents a duplicate after reload.
			this.log(`控制卡回执未能保存（${receipt.state}）：${errorMessage(error)}`);
		}
	}
}

function chatKey(botId: string, chat: ChatRef): string {
	return JSON.stringify([botId, chat.chatType, chat.chatId]);
}

function validReceipt(value: unknown): value is ControlReceipt {
	const receipt = asRecord(value);
	return (
		!!receipt &&
		receipt.version === 1 &&
		typeof receipt.sessionId === "string" &&
		receipt.sessionId.length <= 256 &&
		typeof receipt.botId === "string" &&
		!!receipt.botId &&
		receipt.botId.length <= 1024 &&
		validChat(receipt.chat) &&
		controlCardFor(receipt.cardId, receipt.sessionId) &&
		typeof receipt.state === "string" &&
		["sent", "unknown", "not_sent", "rejected"].includes(receipt.state)
	);
}

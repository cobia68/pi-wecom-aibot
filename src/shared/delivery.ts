/** Delivery certainty shared by transports and the outbox; absence of evidence is never retryable. */
export type DeliveryFailure = "not_sent" | "rejected" | "unknown";

export class DeliveryError extends Error {
	readonly outcome: DeliveryFailure;

	constructor(message: string, outcome: unknown = "unknown") {
		super(message);
		this.name = "DeliveryError";
		// Also decodes IPC: missing or unfamiliar metadata must fail closed, not trigger a duplicate push.
		this.outcome = outcome === "not_sent" || outcome === "rejected" ? outcome : "unknown";
	}
}

export function deliveryFailure(error: unknown): DeliveryFailure {
	return error instanceof DeliveryError ? error.outcome : "unknown";
}

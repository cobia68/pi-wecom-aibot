import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryError, deliveryFailure } from "../../src/shared/delivery.ts";

test("only explicit delivery evidence is retryable; missing, malformed and message-only hints remain unknown", () => {
  assert.equal(deliveryFailure(new DeliveryError("not attempted", "not_sent")), "not_sent");
  assert.equal(deliveryFailure(new DeliveryError("WeCom rejected it", "rejected")), "rejected");
  for (const outcome of [undefined, null, true, "new-future-value", "unknown"]) {
    assert.equal(deliveryFailure(new DeliveryError("unconfirmed", outcome)), "unknown");
  }
  assert.equal(deliveryFailure(new Error("WebSocket is not subscribed")), "unknown", "never infer delivery certainty from error wording");
  assert.equal(deliveryFailure({ outcome: "not_sent" }), "unknown", "an arbitrary thrown value is not transport evidence");
});

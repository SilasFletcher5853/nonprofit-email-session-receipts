import { test } from "node:test";
import { strict as assert } from "node:assert";
import { receiptMessage } from "../src/receipt_policy.ts";

test("a campaign gift produces a donor-facing receipt with exact cents", () => {
  assert.deepEqual(receiptMessage({ donor: "Ada", email: "ada@example.org", amountCents: 2505, campaign: "Library Fund" }), {
    to: "ada@example.org", subject: "Receipt for Library Fund",
    body: "Hi Ada, thank you for your $25.05 gift to Library Fund. Keep this email for your records."
  });
  assert.throws(() => receiptMessage({ donor: "Ada", email: "ada@example.org", amountCents: 0, campaign: "Library Fund" }), RangeError);
});

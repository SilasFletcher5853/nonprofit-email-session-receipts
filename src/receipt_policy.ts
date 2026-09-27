export type Receipt = { donor: string; amountCents: number; campaign: string; email: string };

export function receiptMessage(receipt: Receipt): { to: string; subject: string; body: string } {
  if (!Number.isSafeInteger(receipt.amountCents) || receipt.amountCents <= 0) {
    throw new RangeError("Receipt amount must be positive cents");
  }
  return {
    to: receipt.email,
    subject: `Receipt for ${receipt.campaign}`,
    body: `Hi ${receipt.donor}, thank you for your $${(receipt.amountCents / 100).toFixed(2)} gift to ${receipt.campaign}. Keep this email for your records.`
  };
}

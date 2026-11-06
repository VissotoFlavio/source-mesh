export interface PaymentInput {
  readonly amount: number;
}

export function processPayment(input: PaymentInput): string {
  return `processed:${input.amount}`;
}

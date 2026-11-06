import { processPayment, type PaymentInput } from '../processor.js';

export function queuePayment(input: PaymentInput): string {
  return processPayment(input);
}

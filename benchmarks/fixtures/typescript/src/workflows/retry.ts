import { processPayment, type PaymentInput } from '../processor.js';

export function retryPayment(input: PaymentInput): string {
  return processPayment(input);
}

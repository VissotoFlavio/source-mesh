import { queuePayment } from './workflows/queue.js';

export function start(amount) {
  return queuePayment({ amount });
}

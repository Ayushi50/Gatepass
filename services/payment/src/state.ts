export type PaymentState = 'CREATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

/** SUCCEEDED and FAILED are final: no later message can change them. */
export const TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  CREATED: ['PROCESSING', 'SUCCEEDED', 'FAILED'],
  PROCESSING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
};

export const canTransition = (from: PaymentState, to: PaymentState): boolean =>
  TRANSITIONS[from].includes(to);

export const isFinal = (s: PaymentState): boolean => TRANSITIONS[s].length === 0;

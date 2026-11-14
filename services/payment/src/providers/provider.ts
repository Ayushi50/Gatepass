import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaymentMethod = 'upi' | 'card' | 'netbanking';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['upi', 'card', 'netbanking'];

export interface ChargeRequest {
  paymentId: string;
  bookingId: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethod;
  /** Opaque token from the provider's own client SDK. Raw card numbers never reach this service. */
  token: string;
  /** Always the payment id, so a retried call can never create a second charge. */
  idempotencyKey: string;
}

export interface ChargeResult {
  providerRef: string;
}

export interface ProviderWebhook {
  /** The provider's unique id for this delivery, used to ignore duplicates. */
  providerEventId: string;
  /** Our payment id, carried in the provider's metadata. */
  paymentId: string;
  outcome: 'succeeded' | 'failed';
  providerRef?: string;
  reason?: string;
  /** If the provider reports an amount, it must match what we asked for. */
  amountMinor?: number;
}

/** The provider definitively refused the charge (bad token, declined at creation). Final. */
export class ProviderRejectedError extends Error {}
/** The provider could not be reached or errored. Not final: the caller may retry. */
export class ProviderUnavailableError extends Error {}
/** The webhook did not carry a valid signature. */
export class InvalidSignatureError extends Error {}

export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /**
   * Verifies the signature over the RAW body and parses it. Throws InvalidSignatureError if it
   * is not authentic. Returns null for authentic events we do not care about.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): ProviderWebhook | null;
}

export const hmacHex = (secret: string, body: Buffer | string): string =>
  createHmac('sha256', secret).update(body).digest('hex');

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

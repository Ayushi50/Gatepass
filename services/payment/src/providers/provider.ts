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
  /**
   * Set when the provider's own authenticated reply already says the money was taken. The payment
   * is then settled at once, and the provider's later webhook finds it already settled.
   */
  settled?: 'succeeded';
}

export interface RefundRequest {
  /** Our refund id; also the provider-side idempotency key, so a retry can never refund twice. */
  refundId: string;
  paymentId: string;
  /** The provider's id for the original payment (what it needs to refund it). */
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
}

export interface RefundResult {
  providerRefundRef: string;
  /** `pending` refunds are completed later by a refund webhook. */
  status: 'completed' | 'pending';
}

export interface PaymentWebhook {
  kind: 'payment';
  /** The provider's unique id for this delivery, used to ignore duplicates. */
  providerEventId: string;
  /** Our payment id, carried in the provider's metadata. */
  paymentId: string;
  outcome: 'succeeded' | 'failed';
  providerRef?: string;
  /** The provider's own payment id, kept so the payment can be refunded later. */
  providerPaymentId?: string;
  reason?: string;
  /** If the provider reports an amount, it must match what we asked for. */
  amountMinor?: number;
}

/** A pending refund has been completed by the provider. */
export interface RefundWebhook {
  kind: 'refund';
  providerEventId: string;
  refundId: string;
  providerRefundRef?: string;
}

export type ProviderWebhook = PaymentWebhook | RefundWebhook;

/** The provider definitively refused the charge (bad token, declined at creation). Final. */
export class ProviderRejectedError extends Error {}
/** The provider could not be reached or errored. Not final: the caller may retry. */
export class ProviderUnavailableError extends Error {}
/** The webhook did not carry a valid signature. */
export class InvalidSignatureError extends Error {}

export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<ChargeResult>;
  /** Refunds (part of) a payment. Idempotent per `refundId`. */
  refund(req: RefundRequest): Promise<RefundResult>;
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

/* eslint-disable @typescript-eslint/no-explicit-any -- Razorpay's checkout.js is loaded from razorpay.com, untyped here */
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open(): void };
  }
}

let loading: Promise<void> | undefined;
/** Loads Razorpay's checkout script from Razorpay itself (it must never be bundled or self-hosted). */
function load(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => {
      loading = undefined;
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface RazorpayDone {
  orderId: string;
  paymentId: string;
  signature: string;
}

/**
 * Opens Razorpay's own payment window for an order. UPI, cards and netbanking are typed there,
 * never here. Resolves with what Razorpay returns on success (which the server then verifies),
 * and with `null` if the buyer closes the window.
 */
export async function payWithRazorpay(opts: {
  keyId: string;
  orderId: string;
  prefill?: { name?: string };
}): Promise<RazorpayDone | null> {
  await load();
  return new Promise((resolve) => {
    const rz = new window.Razorpay!({
      key: opts.keyId,
      order_id: opts.orderId,
      name: 'Gatepass',
      description: 'Your seats',
      theme: { color: '#ffb347' },
      handler: (r: any) =>
        resolve({
          orderId: r.razorpay_order_id,
          paymentId: r.razorpay_payment_id,
          signature: r.razorpay_signature,
        }),
      modal: { ondismiss: () => resolve(null) },
    });
    rz.open();
  });
}

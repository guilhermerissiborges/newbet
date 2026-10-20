/**
 * Adaptador de pagamento. A API só conhece esta interface; Pagar.me é a implementação do MVP
 * (split para o seller + retenção da comissão; escrow via liberação programada no nosso ledger).
 * Trocar de provedor (Asaas, Stripe MX) = implementar a interface, não mexer nas rotas.
 */
export interface CreateChargeInput {
  orderId: string;
  amountCents: number;
  method: "PIX" | "CARD";
  installments?: number;
  cardToken?: string; // tokenizado no cliente; nunca passa número de cartão pela API
  customer: { name: string; email: string; taxId?: string; phone?: string };
  /** split: quanto vai ao recebedor do seller (líquido). O restante fica com a plataforma. */
  split?: { recipientId: string; amountCents: number };
  pixExpiresInSeconds?: number;
}

export interface Charge {
  providerRef: string;
  status: "PENDING" | "AUTHORIZED" | "PAID" | "FAILED";
  pixQrCode?: string;
  pixExpiresAt?: Date;
}

export interface WebhookEvent { providerRef: string; status: Charge["status"]; paidAt?: Date; raw: unknown }

export interface PaymentProvider {
  readonly name: string;
  createCharge(input: CreateChargeInput): Promise<Charge>;
  refund(providerRef: string, amountCents: number): Promise<void>;
  parseWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): WebhookEvent | null;
}

/** Implementação Pagar.me v5 (core API). Requer PAGARME_API_KEY (sandbox: sk_test_...). */
export class PagarmeProvider implements PaymentProvider {
  readonly name = "pagarme";
  constructor(private apiKey: string, private base = "https://api.pagar.me/core/v5") {}
  private auth() { return { Authorization: "Basic " + Buffer.from(`${this.apiKey}:`).toString("base64"), "Content-Type": "application/json" }; }

  async createCharge(i: CreateChargeInput): Promise<Charge> {
    const payment = i.method === "PIX"
      ? { payment_method: "pix", pix: { expires_in: i.pixExpiresInSeconds ?? 900 } }
      : { payment_method: "credit_card", credit_card: { installments: i.installments ?? 1, card_token: i.cardToken, capture: true } };
    const body = {
      code: i.orderId,
      customer: { name: i.customer.name, email: i.customer.email, document: i.customer.taxId, type: "individual" },
      items: [{ amount: i.amountCents, description: `Pedido ${i.orderId}`, quantity: 1, code: i.orderId }],
      payments: [{ ...payment, amount: i.amountCents,
        ...(i.split ? { split: [
          { recipient_id: i.split.recipientId, amount: i.split.amountCents, type: "flat", options: { charge_processing_fee: false, liable: true } },
        ] } : {}) }],
    };
    const r = await fetch(`${this.base}/orders`, { method: "POST", headers: this.auth(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`pagarme ${r.status}: ${await r.text()}`);
    const o = (await r.json()) as { id: string; status: string; charges: Array<{ id: string; status: string; last_transaction?: { qr_code?: string; expires_at?: string } }> };
    const ch = o.charges[0];
    return {
      providerRef: ch.id,
      status: mapPagarme(ch.status),
      pixQrCode: ch.last_transaction?.qr_code,
      pixExpiresAt: ch.last_transaction?.expires_at ? new Date(ch.last_transaction.expires_at) : undefined,
    };
  }
  async refund(providerRef: string, amountCents: number) {
    const r = await fetch(`${this.base}/charges/${providerRef}`, { method: "DELETE", headers: this.auth(), body: JSON.stringify({ amount: amountCents }) });
    if (!r.ok) throw new Error(`pagarme refund ${r.status}: ${await r.text()}`);
  }
  parseWebhook(_h: Record<string, string | string[] | undefined>, body: unknown): WebhookEvent | null {
    const b = body as { type?: string; data?: { id?: string; status?: string; paid_at?: string } };
    if (!b?.type?.startsWith("charge.") || !b.data?.id) return null;
    return { providerRef: b.data.id, status: mapPagarme(b.data.status ?? ""), paidAt: b.data.paid_at ? new Date(b.data.paid_at) : undefined, raw: body };
  }
}

function mapPagarme(s: string): Charge["status"] {
  if (s === "paid") return "PAID";
  if (s === "authorized") return "AUTHORIZED";
  if (["failed", "canceled", "refused", "voided"].includes(s)) return "FAILED";
  return "PENDING";
}

/** Mock para testes e para a demo: cobra tudo como PENDING e paga quando `settle` é chamado. */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  charges = new Map<string, Charge & { orderId: string }>();
  async createCharge(i: CreateChargeInput): Promise<Charge> {
    const providerRef = `mock_${i.orderId}`;
    const c: Charge & { orderId: string } = { providerRef, status: "PENDING", orderId: i.orderId,
      pixQrCode: i.method === "PIX" ? `00020126...${i.orderId}` : undefined, pixExpiresAt: i.method === "PIX" ? new Date(Date.now() + 900_000) : undefined };
    this.charges.set(providerRef, c);
    return c;
  }
  async refund(providerRef: string) { const c = this.charges.get(providerRef); if (c) c.status = "FAILED"; }
  parseWebhook(_h: Record<string, string | string[] | undefined>, body: unknown): WebhookEvent | null {
    const b = body as { providerRef: string; status: Charge["status"] };
    return b?.providerRef ? { providerRef: b.providerRef, status: b.status, paidAt: new Date(), raw: body } : null;
  }
}

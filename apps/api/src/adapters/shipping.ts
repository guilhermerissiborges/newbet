/**
 * Adaptador de frete. Melhor Envio (Correios, Jadlog, Loggi...) é a implementação do MVP.
 * A plataforma cota por peso/dimensão, cobra o comprador no checkout e compra a etiqueta pré-paga
 * para o seller imprimir. "Shipped" só quando o pacote recebe scan (não quando a etiqueta é gerada).
 */
export interface QuoteInput { fromZip: string; toZip: string; weightGrams: number; lengthCm?: number; widthCm?: number; heightCm?: number; insuranceCents?: number }
export interface Quote { carrier: string; service: string; serviceId: string; priceCents: number; deliveryDays: number }
export interface LabelInput extends QuoteInput { serviceId: string; orderId: string; sender: Party; recipient: Party; nfeKey?: string }
export interface Party { name: string; taxId?: string; phone?: string; email?: string; street: string; number: string; complement?: string; district: string; city: string; state: string; zip: string }
export interface Label { providerRef: string; carrier: string; service: string; trackingCode: string; labelUrl: string; costCents: number }
export type TrackingStatus = "LABEL_CREATED" | "SCANNED" | "IN_TRANSIT" | "DELIVERED" | "LOST";

export interface ShippingProvider {
  readonly name: string;
  quote(i: QuoteInput): Promise<Quote[]>;
  buyLabel(i: LabelInput): Promise<Label>;
  track(providerRef: string): Promise<{ status: TrackingStatus; events: Array<{ at: Date; description: string }> }>;
}

/** Melhor Envio API v2 (sandbox: https://sandbox.melhorenvio.com.br). Requer token OAuth com escopos shipping-*. */
export class MelhorEnvioProvider implements ShippingProvider {
  readonly name = "melhorenvio";
  constructor(private token: string, private base = "https://sandbox.melhorenvio.com.br/api/v2", private userAgent = "Arrematto (dev@arrematto.com)") {}
  private h() { return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": this.userAgent }; }

  async quote(i: QuoteInput): Promise<Quote[]> {
    const body = { from: { postal_code: i.fromZip }, to: { postal_code: i.toZip },
      package: { weight: i.weightGrams / 1000, width: i.widthCm ?? 16, height: i.heightCm ?? 10, length: i.lengthCm ?? 20 },
      options: { insurance_value: (i.insuranceCents ?? 0) / 100, receipt: false, own_hand: false } };
    const r = await fetch(`${this.base}/me/shipment/calculate`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`melhorenvio quote ${r.status}: ${await r.text()}`);
    const arr = (await r.json()) as Array<{ id: number; name: string; company: { name: string }; price?: string; delivery_time?: number; error?: string }>;
    return arr.filter(q => !q.error && q.price).map(q => ({ carrier: q.company.name, service: q.name, serviceId: String(q.id), priceCents: Math.round(Number(q.price) * 100), deliveryDays: q.delivery_time ?? 0 }));
  }

  async buyLabel(i: LabelInput): Promise<Label> {
    const party = (p: Party) => ({ name: p.name, phone: p.phone, email: p.email, document: p.taxId, address: p.street, number: p.number, complement: p.complement, district: p.district, city: p.city, state_abbr: p.state, postal_code: p.zip, country_id: "BR" });
    const cart = { service: Number(i.serviceId), from: party(i.sender), to: party(i.recipient),
      products: [{ name: `Pedido ${i.orderId}`, quantity: 1, unitary_value: (i.insuranceCents ?? 0) / 100 }],
      volumes: [{ weight: i.weightGrams / 1000, width: i.widthCm ?? 16, height: i.heightCm ?? 10, length: i.lengthCm ?? 20 }],
      options: { insurance_value: (i.insuranceCents ?? 0) / 100, receipt: false, own_hand: false, non_commercial: !i.nfeKey, invoice: i.nfeKey ? { key: i.nfeKey } : undefined } };
    const added = await this.post("/me/cart", cart) as { id: string; price: string; service: { name: string; company: { name: string } } };
    await this.post("/me/shipment/checkout", { orders: [added.id] });
    await this.post("/me/shipment/generate", { orders: [added.id] });
    const printed = await this.post("/me/shipment/print", { mode: "private", orders: [added.id] }) as { url: string };
    const info = await (await fetch(`${this.base}/me/orders/${added.id}`, { headers: this.h() })).json() as { tracking?: string };
    return { providerRef: added.id, carrier: added.service.company.name, service: added.service.name, trackingCode: info.tracking ?? "", labelUrl: printed.url, costCents: Math.round(Number(added.price) * 100) };
  }

  async track(providerRef: string) {
    const r = await this.post("/me/shipment/tracking", { orders: [providerRef] }) as Record<string, { status: string; tracking?: string; posted_at?: string; delivered_at?: string }>;
    const t = r[providerRef];
    const status: TrackingStatus = t?.delivered_at ? "DELIVERED" : t?.posted_at ? "SCANNED" : "LABEL_CREATED";
    return { status, events: [] };
  }

  private async post(path: string, body: unknown) {
    const r = await fetch(`${this.base}${path}`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`melhorenvio ${path} ${r.status}: ${await r.text()}`);
    return r.json();
  }
}

/** Mock: tabela por faixa de peso (aproximação de PAC com desconto). Usado em testes e na demo. */
export class MockShippingProvider implements ShippingProvider {
  readonly name = "mock";
  labels = new Map<string, Label & { status: TrackingStatus }>();
  static priceFor(g: number) { return g <= 300 ? 1290 : g <= 500 ? 1490 : g <= 1000 ? 1990 : g <= 2000 ? 2790 : g <= 5000 ? 3990 : 5990; }
  async quote(i: QuoteInput): Promise<Quote[]> {
    return [{ carrier: "Correios", service: "PAC", serviceId: "1", priceCents: MockShippingProvider.priceFor(i.weightGrams), deliveryDays: 6 },
            { carrier: "Correios", service: "SEDEX", serviceId: "2", priceCents: Math.round(MockShippingProvider.priceFor(i.weightGrams) * 1.6), deliveryDays: 2 }];
  }
  async buyLabel(i: LabelInput): Promise<Label> {
    const l = { providerRef: `me_${i.orderId}`, carrier: "Correios", service: i.serviceId === "2" ? "SEDEX" : "PAC", trackingCode: `BR${i.orderId.slice(-8).toUpperCase()}XX`, labelUrl: `https://labels.mock/${i.orderId}.pdf`, costCents: MockShippingProvider.priceFor(i.weightGrams), status: "LABEL_CREATED" as TrackingStatus };
    this.labels.set(l.providerRef, l); return l;
  }
  async track(providerRef: string) { return { status: this.labels.get(providerRef)?.status ?? "LABEL_CREATED", events: [] }; }
  /** só para testes: simula o scan e a entrega */
  advance(providerRef: string, status: TrackingStatus) { const l = this.labels.get(providerRef); if (l) l.status = status; }
}

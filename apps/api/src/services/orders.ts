/**
 * Serviço de pedidos: a máquina de estados do dinheiro.
 *
 *  auction.closed ──▶ won_items (cesta do show)
 *  show.close     ──▶ bundling por comprador+seller ──▶ orders (PENDING_PAYMENT) + payments (PIX/cartão)
 *  payment.paid   ──▶ orders PAID ──▶ NF-e (seller) ──▶ ledger ITEM/SHIPPING/COMMISSION/SERVICE_FEE (processing)
 *  label.buy      ──▶ shipments LABEL_CREATED (prazo de scan: 2 dias úteis)
 *  scan           ──▶ SHIPPED
 *  delivered      ──▶ DELIVERED; escrowReleaseAt = entrega + 7 dias (CDC art. 49); withdrawalDeadline idem
 *  escrow.release ──▶ ledger availableAt chega ──▶ COMPLETED (job diário)
 */
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { bundle, computeFees, escrowReleaseAt, ESCROW_RELEASE_AFTER_DELIVERY_MS, type WonItem } from "@arrematto/domain";
import type { AuctionClosedEvent } from "@arrematto/contracts";
import type { Db } from "../db/client.js";
import { schema as s } from "../db/client.js";
import type { PaymentProvider } from "../adapters/payments.js";
import type { ShippingProvider } from "../adapters/shipping.js";
import type { InvoiceProvider } from "../adapters/invoices.js";

export interface Deps { db: Db; payments: PaymentProvider; shipping: ShippingProvider; invoices: InvoiceProvider; now?: () => Date }

export class OrderService {
  constructor(private d: Deps) {}
  private now() { return this.d.now ? this.d.now() : new Date(); }

  /** 1. Evento do realtime: registra o arremate na cesta do show. Idempotente por listing. */
  async onAuctionClosed(ev: AuctionClosedEvent) {
    const { db } = this.d;
    const [listing] = await db.select().from(s.listings).where(eq(s.listings.id, ev.listingId));
    if (!listing) throw new Error(`listing ${ev.listingId} não existe`);
    await db.update(s.listings).set({ status: ev.status === "sold" ? "SOLD" : "UNSOLD", auctionSnapshot: ev as unknown as Record<string, unknown> }).where(eq(s.listings.id, ev.listingId));
    await db.insert(s.events).values({ type: "auction.closed", userId: ev.winnerUserId, payload: ev as unknown as Record<string, unknown> });
    if (ev.status !== "sold" || !ev.winnerUserId) return;
    await db.insert(s.wonItems).values({ showId: ev.showId, listingId: ev.listingId, buyerId: ev.winnerUserId, sellerId: listing.sellerId, priceCents: ev.priceCents, weightGrams: listing.weightGrams }).onConflictDoNothing();
  }

  /** 2. Fim do show: Smart Bundling → um pedido por comprador+seller, com frete cotado pelo pacote e cobrança criada. */
  async closeShow(showId: string, opts: { originZip: string; method?: "PIX" | "CARD" } ) {
    const { db, shipping, payments } = this.d;
    const pending = await db.select().from(s.wonItems).where(and(eq(s.wonItems.showId, showId), isNull(s.wonItems.orderId)));
    if (pending.length === 0) { await db.update(s.shows).set({ status: "ENDED", endedAt: this.now() }).where(eq(s.shows.id, showId)); return []; }

    // cotação por peso acumulado: a função `bundle` chama quote(pesoCumulativo) item a item
    const quoteCache = new Map<string, number>();
    const buyers = await db.select().from(s.users).where(inArray(s.users.id, [...new Set(pending.map(p => p.buyerId))]));
    const addrs = await db.select().from(s.addresses).where(and(inArray(s.addresses.userId, buyers.map(b => b.id)), eq(s.addresses.isDefault, true)));
    const zipOf = (buyerId: string) => addrs.find(a => a.userId === buyerId)?.zip ?? "01001000";
    const quoteFor = async (buyerId: string, grams: number) => {
      const k = `${buyerId}:${grams}`;
      if (!quoteCache.has(k)) { const q = await shipping.quote({ fromZip: opts.originZip, toZip: zipOf(buyerId), weightGrams: grams }); quoteCache.set(k, Math.min(...q.map(x => x.priceCents))); }
      return quoteCache.get(k)!;
    };
    // pré-aquece as cotações cumulativas por grupo (bundle é síncrono)
    const groups = new Map<string, WonItem[]>();
    for (const p of pending) { const k = `${p.buyerId}|${p.sellerId}`; groups.set(k, [...(groups.get(k) ?? []), { listingId: p.listingId, buyerId: p.buyerId, sellerId: p.sellerId, priceCents: p.priceCents, weightGrams: p.weightGrams }]); }
    for (const g of groups.values()) { let cum = 0; for (const it of [...g].sort((a, b) => b.weightGrams - a.weightGrams)) { cum += it.weightGrams; await quoteFor(g[0].buyerId, cum); } }

    const created: string[] = [];
    for (const g of groups.values()) {
      const buyerId = g[0].buyerId;
      const [b] = bundle(g, grams => quoteCache.get(`${buyerId}:${grams}`)!);
      const [seller] = await db.select().from(s.sellerProfiles).where(eq(s.sellerProfiles.id, b.sellerId));
      const fees = computeFees({ itemsCents: b.totalItemsCents, shippingCents: b.shippingCents, taxCents: 0 }, seller.sales28dCents);
      const buyer = buyers.find(u => u.id === buyerId)!;
      const orderId = await db.transaction(async tx => {
        const [o] = await tx.insert(s.orders).values({ buyerId, sellerId: b.sellerId, showId, itemsCents: b.totalItemsCents, shippingCents: b.shippingCents, commissionCents: fees.commissionCents, serviceFeeCents: fees.serviceFeeCents, totalCents: fees.buyerTotalCents }).returning({ id: s.orders.id });
        await tx.insert(s.orderItems).values(b.items.map((it, i) => ({ orderId: o.id, listingId: it.listingId, priceCents: it.priceCents, shippingAllocCents: b.shippingPerItemCents[i] })));
        await tx.update(s.wonItems).set({ orderId: o.id }).where(inArray(s.wonItems.listingId, b.items.map(i => i.listingId)));
        return o.id;
      });
      const method = opts.method ?? "PIX";
      const charge = await payments.createCharge({ orderId, amountCents: fees.buyerTotalCents, method, customer: { name: buyer.name, email: buyer.email },
        split: seller.payoutAccountRef ? { recipientId: seller.payoutAccountRef, amountCents: fees.sellerNetCents } : undefined });
      await db.insert(s.payments).values({ orderId, provider: payments.name, providerRef: charge.providerRef, method, status: charge.status, amountCents: fees.buyerTotalCents, pixQrCode: charge.pixQrCode, pixExpiresAt: charge.pixExpiresAt });
      created.push(orderId);
    }
    await db.update(s.shows).set({ status: "ENDED", endedAt: this.now() }).where(eq(s.shows.id, showId));
    return created;
  }

  /** 3. Webhook de pagamento: PAID → pedido pago, NF-e emitida, ledger em processing. */
  async onPaymentWebhook(providerRef: string, status: "PENDING" | "AUTHORIZED" | "PAID" | "FAILED", paidAt = this.now()) {
    const { db, invoices } = this.d;
    const [p] = await db.select().from(s.payments).where(eq(s.payments.providerRef, providerRef));
    if (!p) return null;
    if (p.status === "PAID") return p.orderId; // idempotente
    await db.update(s.payments).set({ status, paidAt: status === "PAID" ? paidAt : null }).where(eq(s.payments.id, p.id));
    if (status === "FAILED") { await db.update(s.orders).set({ status: "CANCELLED" }).where(eq(s.orders.id, p.orderId)); return p.orderId; }
    if (status !== "PAID") return p.orderId;

    const [o] = await db.select().from(s.orders).where(eq(s.orders.id, p.orderId));
    const [seller] = await db.select().from(s.sellerProfiles).where(eq(s.sellerProfiles.id, o.sellerId));
    const [buyer] = await db.select().from(s.users).where(eq(s.users.id, o.buyerId));
    const [addr] = await db.select().from(s.addresses).where(and(eq(s.addresses.userId, o.buyerId), eq(s.addresses.isDefault, true)));
    const items = await db.select({ oi: s.orderItems, l: s.listings }).from(s.orderItems).innerJoin(s.listings, eq(s.orderItems.listingId, s.listings.id)).where(eq(s.orderItems.orderId, o.id));
    const nfe = await invoices.issueNfe({ ref: o.id, issuerTaxId: seller.taxId, shippingCents: o.shippingCents, totalCents: o.itemsCents + o.shippingCents,
      recipient: { name: buyer.name, email: buyer.email, street: addr?.street ?? "", number: addr?.number ?? "", district: addr?.district ?? "", city: addr?.city ?? "", state: addr?.state ?? "", zip: addr?.zip ?? "" },
      items: items.map(({ oi, l }) => ({ code: l.sku ?? l.id, description: l.title, ncm: "33059000", cfop: "5102", quantity: oi.quantity, unitCents: oi.priceCents })) });
    const far = new Date("2999-12-31T00:00:00Z"); // sentinela: availableAt real é definido na entrega (escrow); até lá, "processing"
    await db.transaction(async tx => {
      await tx.update(s.orders).set({ status: "PAID", nfeKey: nfe.key }).where(eq(s.orders.id, o.id));
      await tx.insert(s.ledgerEntries).values([
        { sellerId: o.sellerId, orderId: o.id, type: "ITEM", amountCents: o.itemsCents, availableAt: far },
        { sellerId: o.sellerId, orderId: o.id, type: "SHIPPING", amountCents: o.shippingCents, availableAt: far },
        { sellerId: o.sellerId, orderId: o.id, type: "COMMISSION", amountCents: -o.commissionCents, availableAt: far },
        { sellerId: o.sellerId, orderId: o.id, type: "SERVICE_FEE", amountCents: -o.serviceFeeCents, availableAt: far },
      ]);
      await tx.update(s.sellerProfiles).set({ sales28dCents: sql`${s.sellerProfiles.sales28dCents} + ${o.itemsCents}` }).where(eq(s.sellerProfiles.id, o.sellerId));
      await tx.insert(s.events).values({ type: "order.paid", userId: o.buyerId, payload: { orderId: o.id, nfeKey: nfe.key } });
    });
    return o.id;
  }

  /** 4. Seller gera a etiqueta pré-paga (frete já cobrado do comprador). */
  async buyLabel(orderId: string, origin: { zip: string; name: string; street: string; number: string; district: string; city: string; state: string }) {
    const { db, shipping } = this.d;
    const [o] = await db.select().from(s.orders).where(eq(s.orders.id, orderId));
    if (!o || o.status !== "PAID") throw new Error("pedido não está pago");
    const [buyer] = await db.select().from(s.users).where(eq(s.users.id, o.buyerId));
    const [addr] = await db.select().from(s.addresses).where(and(eq(s.addresses.userId, o.buyerId), eq(s.addresses.isDefault, true)));
    const items = await db.select({ w: s.listings.weightGrams }).from(s.orderItems).innerJoin(s.listings, eq(s.orderItems.listingId, s.listings.id)).where(eq(s.orderItems.orderId, orderId));
    const grams = items.reduce((a, i) => a + i.w, 0);
    const label = await shipping.buyLabel({ orderId, serviceId: "1", fromZip: origin.zip, toZip: addr.zip, weightGrams: grams, nfeKey: o.nfeKey ?? undefined,
      sender: { ...origin }, recipient: { name: buyer.name, email: buyer.email, street: addr.street, number: addr.number, district: addr.district, city: addr.city, state: addr.state, zip: addr.zip } });
    await db.insert(s.shipments).values({ orderId, provider: shipping.name, providerRef: label.providerRef, carrier: label.carrier, service: label.service, labelUrl: label.labelUrl, trackingCode: label.trackingCode, weightGrams: grams, costCents: label.costCents });
    return label;
  }

  /** 5. Scan de postagem (scanner in-app ou transportadora): só aqui o pedido vira SHIPPED. */
  async markScanned(orderId: string, at = this.now()) {
    const { db } = this.d;
    await db.update(s.shipments).set({ status: "SCANNED", scannedAt: at }).where(eq(s.shipments.orderId, orderId));
    await db.update(s.orders).set({ status: "SHIPPED" }).where(eq(s.orders.id, orderId));
    await db.insert(s.events).values({ type: "shipment.scanned", payload: { orderId, at: at.toISOString() } });
  }

  /** 6. Entrega confirmada: abre a janela de arrependimento e programa o escrow. */
  async markDelivered(orderId: string, at = this.now()) {
    const { db } = this.d;
    const release = new Date(escrowReleaseAt(at.getTime()));
    await db.transaction(async tx => {
      await tx.update(s.shipments).set({ status: "DELIVERED", deliveredAt: at }).where(eq(s.shipments.orderId, orderId));
      await tx.update(s.orders).set({ status: "DELIVERED", escrowReleaseAt: release, withdrawalDeadline: release }).where(eq(s.orders.id, orderId));
      await tx.update(s.ledgerEntries).set({ availableAt: release }).where(eq(s.ledgerEntries.orderId, orderId));
      await tx.insert(s.events).values({ type: "shipment.delivered", payload: { orderId, at: at.toISOString(), escrowReleaseAt: release.toISOString() } });
    });
    return release;
  }

  /** 7. Job: pedidos entregues cuja janela de 7 dias passou sem devolução ficam COMPLETED; o ledger já está "available" por data. */
  async releaseEscrow(now = this.now()) {
    const { db } = this.d;
    const rows = await db.update(s.orders).set({ status: "COMPLETED" }).where(and(eq(s.orders.status, "DELIVERED"), lte(s.orders.escrowReleaseAt, now))).returning({ id: s.orders.id });
    return rows.map(r => r.id);
  }

  /** Saldo do seller: processing (ainda em escrow) vs available (liberado), como o Whatnot mostra. */
  async sellerBalance(sellerId: string, now = this.now()) {
    const { db } = this.d;
    const rows = await db.select({ amount: s.ledgerEntries.amountCents, availableAt: s.ledgerEntries.availableAt }).from(s.ledgerEntries).where(eq(s.ledgerEntries.sellerId, sellerId));
    let available = 0, processing = 0;
    for (const r of rows) (r.availableAt <= now ? (available += r.amount) : (processing += r.amount));
    return { availableCents: available, processingCents: processing };
  }
}

export { ESCROW_RELEASE_AFTER_DELIVERY_MS };

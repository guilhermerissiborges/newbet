import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeDb, schema as s } from "../src/db/client.js";
import { OrderService } from "../src/services/orders.js";
import { MockPaymentProvider } from "../src/adapters/payments.js";
import { MockShippingProvider } from "../src/adapters/shipping.js";
import { MockInvoiceProvider } from "../src/adapters/invoices.js";

const db = makeDb(process.env.TEST_DATABASE_URL ?? "postgresql://live@localhost:5432/arrematto_test");
let clock = new Date("2026-11-03T20:00:00Z");
const payments = new MockPaymentProvider(); const shipping = new MockShippingProvider(); const invoices = new MockInvoiceProvider();
const svc = new OrderService({ db, payments, shipping, invoices, now: () => clock });

async function reset() {
  for (const t of ["events", "ledger_entries", "shipments", "payments", "order_items", "won_items", "orders", "bids", "listings", "shows", "seller_profiles", "addresses", "users"])
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" CASCADE`));
}
async function seed() {
  const [sellerUser] = await db.insert(s.users).values({ authId: "a-s", email: "seller@x.com", name: "Loja", role: "SELLER" }).returning();
  const [seller] = await db.insert(s.sellerProfiles).values({ userId: sellerUser.id, legalName: "Loja LTDA", taxId: "12345678000199", kycStatus: "APPROVED", payoutAccountRef: "rp_1" }).returning();
  const [bia] = await db.insert(s.users).values({ authId: "a-b", email: "bia@x.com", name: "Bia" }).returning();
  const [caio] = await db.insert(s.users).values({ authId: "a-c", email: "caio@x.com", name: "Caio" }).returning();
  for (const u of [bia, caio]) await db.insert(s.addresses).values({ userId: u.id, street: "Rua A", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "01001000", isDefault: true });
  const [show] = await db.insert(s.shows).values({ sellerId: seller.id, title: "Live de terça", category: "beauty.hair", scheduledAt: clock, status: "LIVE" }).returning();
  const mk = (title: string, price: number, w: number) => db.insert(s.listings).values({ sellerId: seller.id, showId: show.id, type: "AUCTION", status: "ACTIVE", title, category: "beauty.hair", priceCents: price, weightGrams: w }).returning().then(r => r[0]);
  const l1 = await mk("Grace Unique 100ml", 1000, 150), l2 = await mk("Grace Violet 100ml", 1000, 150), l3 = await mk("Btox Carmen 1kg", 5000, 1000);
  return { seller, bia, caio, show, l1, l2, l3 };
}

beforeAll(async () => { await reset(); });
beforeEach(async () => { await reset(); clock = new Date("2026-11-03T20:00:00Z"); });
afterAll(async () => { await (db as unknown as { $client: { end(): Promise<void> } }).$client.end(); });

describe("fluxo do pedido", () => {
  it("arremate → bundling → pagamento → NF-e → etiqueta → scan → entrega → escrow D+7 → completed", async () => {
    const { seller, bia, caio, show, l1, l2, l3 } = await seed();
    const ev = (listingId: string, winner: string, price: number) => ({ type: "auction.closed" as const, showId: show.id, listingId, status: "sold" as const, winnerUserId: winner, priceCents: price, bidCount: 3, closedAt: clock.getTime() });
    await svc.onAuctionClosed(ev(l1.id, bia.id, 2200));
    await svc.onAuctionClosed(ev(l1.id, bia.id, 2200)); // reprocessamento: idempotente
    await svc.onAuctionClosed(ev(l2.id, bia.id, 1800));
    await svc.onAuctionClosed(ev(l3.id, caio.id, 6500));

    const orderIds = await svc.closeShow(show.id, { originZip: "88130000" });
    expect(orderIds).toHaveLength(2); // bia (2 itens, 1 pacote) e caio (1 item)
    const orders = await db.select().from(s.orders);
    const biaOrder = orders.find(o => o.buyerId === bia.id)!;
    expect(biaOrder.itemsCents).toBe(4000);
    expect(biaOrder.shippingCents).toBe(MockShippingProvider.priceFor(300)); // 150 g + 150 g num pacote
    expect(biaOrder.commissionCents).toBe(400); // 10%
    expect(biaOrder.totalCents).toBe(4000 + MockShippingProvider.priceFor(300));
    const items = await db.select().from(s.orderItems);
    const biaAlloc = items.filter(i => i.orderId === biaOrder.id).map(i => i.shippingAllocCents).sort((a, b) => b - a);
    expect(biaAlloc[0]).toBe(MockShippingProvider.priceFor(150)); expect(biaAlloc[1]).toBe(MockShippingProvider.priceFor(300) - MockShippingProvider.priceFor(150));
    const pay = (await db.select().from(s.payments)).find(p => p.orderId === biaOrder.id)!;
    expect(pay.status).toBe("PENDING"); expect(pay.pixQrCode).toBeTruthy();

    // pagamento confirmado via webhook
    await svc.onPaymentWebhook(pay.providerRef!, "PAID");
    await svc.onPaymentWebhook(pay.providerRef!, "PAID"); // idempotente
    const [paid] = await db.select().from(s.orders).where(sql`${s.orders.id} = ${biaOrder.id}`);
    expect(paid.status).toBe("PAID"); expect(paid.nfeKey).toHaveLength(44);
    const ledger = await db.select().from(s.ledgerEntries);
    expect(ledger.filter(l => l.orderId === biaOrder.id)).toHaveLength(4);
    let bal = await svc.sellerBalance(seller.id);
    expect(bal.availableCents).toBe(0);
    expect(bal.processingCents).toBe(4000 + MockShippingProvider.priceFor(300) - 400 - 150);

    // etiqueta, scan, entrega
    const label = await svc.buyLabel(biaOrder.id, { zip: "88130000", name: "Loja LTDA", street: "Rua B", number: "2", district: "Centro", city: "Palhoça", state: "SC" });
    expect(label.trackingCode).toMatch(/^BR/);
    clock = new Date("2026-11-04T10:00:00Z"); await svc.markScanned(biaOrder.id);
    clock = new Date("2026-11-08T14:00:00Z"); const release = await svc.markDelivered(biaOrder.id);
    expect(release.toISOString()).toBe("2026-11-15T14:00:00.000Z"); // D+7
    bal = await svc.sellerBalance(seller.id); expect(bal.availableCents).toBe(0);

    // antes do prazo: nada libera; depois: completed e saldo disponível
    clock = new Date("2026-11-14T00:00:00Z"); expect(await svc.releaseEscrow()).toHaveLength(0);
    clock = new Date("2026-11-16T00:00:00Z"); expect(await svc.releaseEscrow()).toEqual([biaOrder.id]);
    bal = await svc.sellerBalance(seller.id);
    expect(bal.availableCents).toBe(4000 + MockShippingProvider.priceFor(300) - 400 - 150); expect(bal.processingCents).toBe(0);
    const [sp] = await db.select().from(s.sellerProfiles);
    expect(sp.sales28dCents).toBe(4000);
  });

  it("pagamento recusado cancela o pedido; leilão sem lance não gera cesta", async () => {
    const { bia, show, l1, l2 } = await seed();
    await svc.onAuctionClosed({ type: "auction.closed", showId: show.id, listingId: l2.id, status: "unsold", winnerUserId: null, priceCents: 0, bidCount: 0, closedAt: clock.getTime() });
    expect(await db.select().from(s.wonItems)).toHaveLength(0);
    await svc.onAuctionClosed({ type: "auction.closed", showId: show.id, listingId: l1.id, status: "sold", winnerUserId: bia.id, priceCents: 1500, bidCount: 1, closedAt: clock.getTime() });
    const [orderId] = await svc.closeShow(show.id, { originZip: "88130000", method: "CARD" });
    const [pay] = await db.select().from(s.payments);
    await svc.onPaymentWebhook(pay.providerRef!, "FAILED");
    const [o] = await db.select().from(s.orders);
    expect(o.id).toBe(orderId); expect(o.status).toBe("CANCELLED");
    expect(await db.select().from(s.ledgerEntries)).toHaveLength(0);
  });
});

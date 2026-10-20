import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { spawn, type ChildProcess } from "node:child_process";
import { makeDb } from "../src/db/client.js";
import { buildApp } from "../src/server.js";

const db = makeDb(process.env.TEST_DATABASE_URL ?? "postgresql://live@localhost:5432/arrematto_test");
let proc: ChildProcess; let redis: Redis; let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  proc = spawn("redis-server", ["--port", "6398", "--save", "", "--loglevel", "warning"]);
  redis = new Redis({ port: 6398, lazyConnect: true });
  for (let i = 0; i < 50; i++) { try { await redis.connect(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  for (const t of ["events", "ledger_entries", "shipments", "payments", "order_items", "won_items", "orders", "bids", "listings", "shows", "seller_profiles", "addresses", "users"])
    await db.execute(sql.raw(`TRUNCATE TABLE "${t}" CASCADE`));
  process.env.NODE_ENV = "test";
  app = buildApp({ db, redis, mocks: true });
  await app.ready();
}, 20_000);
afterAll(async () => { await app.close(); await redis.quit(); proc.kill(); await (db as unknown as { $client: { end(): Promise<void> } }).$client.end(); });

const j = (r: { body: string }) => JSON.parse(r.body);

describe("rotas", () => {
  it("seller cria show e listing; cosmético sem ANVISA é recusado; leilão publica comando; webhook paga; etiqueta e saldo", async () => {
    const seller = j(await app.inject({ method: "POST", url: "/users", payload: { email: "s@x.com", name: "Loja" } }));
    const h = { "x-user-id": seller.id };
    expect((await app.inject({ method: "POST", url: "/sellers", headers: h, payload: { legalName: "Loja LTDA", taxId: "123" } })).statusCode).toBe(400); // CNPJ inválido
    expect((await app.inject({ method: "POST", url: "/sellers", headers: h, payload: { legalName: "Loja LTDA", taxId: "12345678000199" } })).statusCode).toBe(200);
    const show = j(await app.inject({ method: "POST", url: "/shows", headers: h, payload: { title: "Live de hair care", category: "beauty.hair", scheduledAt: new Date().toISOString() } }));
    expect(show.status).toBe("SCHEDULED");
    const noAnvisa = await app.inject({ method: "POST", url: `/shows/${show.id}/listings`, headers: h, payload: { type: "AUCTION", title: "Grace Unique", category: "beauty.hair", priceCents: 1000, weightGrams: 150 } });
    expect(noAnvisa.statusCode).toBe(422);
    const l = j(await app.inject({ method: "POST", url: `/shows/${show.id}/listings`, headers: h, payload: { type: "AUCTION", title: "Grace Unique", category: "beauty.hair", priceCents: 1000, weightGrams: 150, anvisaProcess: "25351.123456/2024-11" } }));
    expect(l.status).toBe("ACTIVE");

    const got: string[] = []; const sub = new Redis({ port: 6398 }); await sub.subscribe("commands:auction"); sub.on("message", (_c: string, m: string) => got.push(m));
    expect(j(await app.inject({ method: "POST", url: `/shows/${show.id}/auction/start`, headers: h, payload: { listingId: l.id } })).started).toBe(true);
    await new Promise(r => setTimeout(r, 100));
    expect(JSON.parse(got[0])).toMatchObject({ type: "start", listingId: l.id, startingBidCents: 1000 });
    await sub.quit();
    expect((await app.inject({ method: "POST", url: `/shows/${show.id}/auction/start`, headers: h, payload: { listingId: l.id } })).statusCode).toBe(409); // já rodando

    // comprador com endereço; o realtime fecharia o leilão — simulamos o evento direto no serviço
    const buyer = j(await app.inject({ method: "POST", url: "/users", payload: { email: "b@x.com", name: "Bia" } }));
    await app.inject({ method: "POST", url: "/users/me/addresses", headers: { "x-user-id": buyer.id }, payload: { street: "Rua A", number: "1", district: "Centro", city: "São Paulo", state: "SP", zip: "01001000" } });
    await app.deps.orders.onAuctionClosed({ type: "auction.closed", showId: show.id, listingId: l.id, status: "sold", winnerUserId: buyer.id, priceCents: 2500, bidCount: 4, closedAt: Date.now() });
    const closed = j(await app.inject({ method: "POST", url: `/shows/${show.id}/close`, headers: h, payload: { originZip: "88130000" } }));
    expect(closed.orders).toHaveLength(1);
    const orderId = closed.orders[0];
    let o = j(await app.inject({ method: "GET", url: `/orders/${orderId}` }));
    expect(o.status).toBe("PENDING_PAYMENT"); expect(o.payment.pixQrCode).toBeTruthy(); expect(o.totalCents).toBe(2500 + 1290);

    expect(j(await app.inject({ method: "POST", url: "/webhooks/payments", payload: { providerRef: o.payment.providerRef, status: "PAID" } })).orderId).toBe(orderId);
    o = j(await app.inject({ method: "GET", url: `/orders/${orderId}` }));
    expect(o.status).toBe("PAID"); expect(o.nfeKey).toHaveLength(44);
    const label = j(await app.inject({ method: "POST", url: `/orders/${orderId}/label`, headers: h, payload: { zip: "88130000", name: "Loja", street: "Rua B", number: "2", district: "Centro", city: "Palhoça", state: "SC" } }));
    expect(label.labelUrl).toContain(".pdf");
    await app.inject({ method: "POST", url: `/orders/${orderId}/scan`, headers: h });
    await app.inject({ method: "POST", url: "/webhooks/shipping", payload: { orderId, status: "DELIVERED" } });
    o = j(await app.inject({ method: "GET", url: `/orders/${orderId}` }));
    expect(o.status).toBe("DELIVERED"); expect(new Date(o.escrowReleaseAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    const bal = j(await app.inject({ method: "GET", url: "/sellers/me/balance", headers: h }));
    expect(bal.processingCents).toBe(2500 + 1290 - 250 - 150); expect(bal.availableCents).toBe(0);
    expect(j(await app.inject({ method: "POST", url: "/jobs/release-escrow" })).completed).toEqual([]);
  });
});

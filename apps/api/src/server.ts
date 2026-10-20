/**
 * API Arrematto — Fastify + Drizzle. Rotas do MVP (semana 2): sellers, shows, listings, leilão, fechamento do show,
 * webhook de pagamento, etiqueta, scan, entrega, saldo. Auth: stub por header `x-user-id` até o Supabase Auth entrar
 * (o tech lead troca `getUser` por verificação de JWT). Provedores reais entram por variável de ambiente; sem chave, usa mock.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { makeDb, schema as s } from "./db/client.js";
import { OrderService } from "./services/orders.js";
import { PagarmeProvider, MockPaymentProvider } from "./adapters/payments.js";
import { MelhorEnvioProvider, MockShippingProvider } from "./adapters/shipping.js";
import { FocusNfeProvider, MockInvoiceProvider } from "./adapters/invoices.js";
import { runAuctionClosedConsumer } from "./consumers/auctionClosed.js";

export function buildApp(opts: { db?: ReturnType<typeof makeDb>; redis?: Redis; mocks?: boolean } = {}) {
  const db = opts.db ?? makeDb();
  const redis = opts.redis ?? new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  const useMocks = opts.mocks ?? !process.env.PAGARME_API_KEY;
  const payments = useMocks ? new MockPaymentProvider() : new PagarmeProvider(process.env.PAGARME_API_KEY!);
  const shipping = useMocks || !process.env.MELHORENVIO_TOKEN ? new MockShippingProvider() : new MelhorEnvioProvider(process.env.MELHORENVIO_TOKEN);
  const invoices = useMocks || !process.env.FOCUSNFE_TOKEN ? new MockInvoiceProvider() : new FocusNfeProvider(process.env.FOCUSNFE_TOKEN);
  const orders = new OrderService({ db, payments, shipping, invoices });
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  // CORS: o web (3000) e o app chamam a API direto do navegador; em produção, lista de origens por env
  app.register(cors, { origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",") : true, allowedHeaders: ["content-type", "x-user-id", "authorization"] });
  // corpo JSON vazio (ex.: POST /shows/:id/start sem payload) vira {} em vez de 400
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body === "" ? {} : JSON.parse(body as string)); } catch (e) { done(e as Error, undefined); }
  });

  const getUser = async (req: { headers: Record<string, unknown> }) => {
    const id = req.headers["x-user-id"]; if (typeof id !== "string") return null;
    const [u] = await db.select().from(s.users).where(eq(s.users.id, id)); return u ?? null;
  };
  const sellerOf = async (userId: string) => (await db.select().from(s.sellerProfiles).where(eq(s.sellerProfiles.userId, userId)))[0] ?? null;
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, status: number, error: string) => reply.code(status).send({ error });

  app.get("/health", async () => ({ ok: true, service: "api", providers: { payments: payments.name, shipping: shipping.name, invoices: invoices.name }, now: Date.now() }));

  // --- usuários (stub de auth) ---
  app.post("/users", async (req, reply) => {
    const b = z.object({ email: z.string().email(), name: z.string().min(2), phone: z.string().optional() }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, "invalid");
    const [u] = await db.insert(s.users).values({ authId: `local:${b.data.email}`, ...b.data }).returning();
    return u;
  });
  app.post("/users/me/addresses", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const b = z.object({ street: z.string(), number: z.string(), complement: z.string().optional(), district: z.string(), city: z.string(), state: z.string().length(2), zip: z.string().regex(/^\d{8}$/) }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, "invalid");
    await db.update(s.addresses).set({ isDefault: false }).where(eq(s.addresses.userId, u.id));
    const [a] = await db.insert(s.addresses).values({ userId: u.id, ...b.data, isDefault: true }).returning();
    return a;
  });

  // --- sellers ---
  app.post("/sellers", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const b = z.object({ legalName: z.string().min(3), taxId: z.string().regex(/^\d{14}$/, "CNPJ obrigatório"), anvisaCompliant: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, b.error.issues[0]?.message ?? "invalid");
    const [sp] = await db.insert(s.sellerProfiles).values({ userId: u.id, ...b.data }).returning();
    await db.update(s.users).set({ role: "SELLER" }).where(eq(s.users.id, u.id));
    return sp;
  });
  app.get("/sellers/me/balance", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const sp = await sellerOf(u.id); if (!sp) return bad(reply, 403, "not_seller");
    return orders.sellerBalance(sp.id);
  });

  // --- shows e listings ---
  app.post("/shows", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const sp = await sellerOf(u.id); if (!sp) return bad(reply, 403, "not_seller");
    const b = z.object({ title: z.string().min(3), category: z.string(), scheduledAt: z.string().datetime(), isPrivate: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, "invalid");
    const [show] = await db.insert(s.shows).values({ sellerId: sp.id, title: b.data.title, category: b.data.category, scheduledAt: new Date(b.data.scheduledAt), isPrivate: b.data.isPrivate ?? false }).returning();
    return show;
  });
  app.get("/shows", async () => db.select().from(s.shows).where(and(eq(s.shows.isPrivate, false))).orderBy(desc(s.shows.scheduledAt)).limit(50));
  app.get("/shows/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [show] = await db.select().from(s.shows).where(eq(s.shows.id, id)); if (!show) return bad(reply, 404, "not_found");
    const items = await db.select().from(s.listings).where(eq(s.listings.showId, id));
    return { ...show, listings: items };
  });
  app.post("/shows/:id/start", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const id = (req.params as { id: string }).id;
    const [show] = await db.update(s.shows).set({ status: "LIVE", startedAt: new Date(), livekitRoom: `show-${id}` }).where(eq(s.shows.id, id)).returning();
    return show;
  });
  app.post("/shows/:id/listings", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const sp = await sellerOf(u.id); if (!sp) return bad(reply, 403, "not_seller");
    const b = z.object({ type: z.enum(["AUCTION", "BUY_IT_NOW"]), title: z.string().min(3), description: z.string().optional(), sku: z.string().optional(), category: z.string(),
      priceCents: z.number().int().positive(), quantity: z.number().int().positive().default(1), weightGrams: z.number().int().positive(), anvisaProcess: z.string().optional(), imageUrls: z.array(z.string().url()).max(8).default([]) }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, "invalid");
    if (b.data.category.startsWith("beauty") && !b.data.anvisaProcess) return bad(reply, 422, "anvisa_process_required");
    const [l] = await db.insert(s.listings).values({ sellerId: sp.id, showId: (req.params as { id: string }).id, status: "ACTIVE", ...b.data }).returning();
    return l;
  });

  // --- leilão: seller roda um item; o realtime cuida do resto ---
  app.post("/shows/:id/auction/start", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const b = z.object({ listingId: z.string(), durationMs: z.number().int().min(5_000).max(600_000).optional(), mode: z.enum(["standard", "sudden_death"]).optional() }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, "invalid");
    const [l] = await db.select().from(s.listings).where(eq(s.listings.id, b.data.listingId));
    if (!l || l.status !== "ACTIVE" || l.type !== "AUCTION") return bad(reply, 409, "listing_not_runnable");
    await db.update(s.listings).set({ status: "RUNNING" }).where(eq(s.listings.id, l.id));
    await redis.publish("commands:auction", JSON.stringify({ type: "start", showId: (req.params as { id: string }).id, listingId: l.id, startingBidCents: l.priceCents, durationMs: b.data.durationMs, mode: b.data.mode }));
    return { started: true, listingId: l.id };
  });

  // --- fechamento do show → pedidos + cobranças ---
  app.post("/shows/:id/close", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const sp = await sellerOf(u.id); if (!sp) return bad(reply, 403, "not_seller");
    const b = z.object({ originZip: z.string().regex(/^\d{8}$/), method: z.enum(["PIX", "CARD"]).optional() }).safeParse(req.body ?? {});
    if (!b.success) return bad(reply, 400, "originZip obrigatório");
    const ids = await orders.closeShow((req.params as { id: string }).id, b.data);
    return { orders: ids };
  });

  // --- pagamentos ---
  app.get("/orders/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const [o] = await db.select().from(s.orders).where(eq(s.orders.id, id)); if (!o) return bad(reply, 404, "not_found");
    const [p] = await db.select().from(s.payments).where(eq(s.payments.orderId, id));
    const [sh] = await db.select().from(s.shipments).where(eq(s.shipments.orderId, id));
    const items = await db.select().from(s.orderItems).where(eq(s.orderItems.orderId, id));
    return { ...o, payment: p ?? null, shipment: sh ?? null, items };
  });
  app.post("/webhooks/payments", async (req, reply) => {
    const ev = payments.parseWebhook(req.headers as Record<string, string | string[] | undefined>, req.body);
    if (!ev) return reply.code(200).send({ ignored: true });
    const orderId = await orders.onPaymentWebhook(ev.providerRef, ev.status, ev.paidAt);
    return { orderId };
  });

  // --- envio ---
  app.post("/orders/:id/label", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    const sp = await sellerOf(u.id); if (!sp) return bad(reply, 403, "not_seller");
    const b = z.object({ zip: z.string().regex(/^\d{8}$/), name: z.string(), street: z.string(), number: z.string(), district: z.string(), city: z.string(), state: z.string().length(2) }).safeParse(req.body);
    if (!b.success) return bad(reply, 400, "endereço de origem inválido");
    try { return await orders.buyLabel((req.params as { id: string }).id, b.data); } catch (e) { return bad(reply, 409, (e as Error).message); }
  });
  app.post("/orders/:id/scan", async (req, reply) => {
    const u = await getUser(req); if (!u) return bad(reply, 401, "unauthorized");
    await orders.markScanned((req.params as { id: string }).id); return { ok: true };
  });
  app.post("/webhooks/shipping", async (req) => {
    // Melhor Envio / mock: {orderId, status: SCANNED|DELIVERED}
    const b = z.object({ orderId: z.string(), status: z.enum(["SCANNED", "DELIVERED"]) }).safeParse(req.body);
    if (!b.success) return { ignored: true };
    if (b.data.status === "SCANNED") await orders.markScanned(b.data.orderId); else await orders.markDelivered(b.data.orderId);
    return { ok: true };
  });

  // --- jobs (chamados por scheduler externo no MVP) ---
  app.post("/jobs/release-escrow", async () => ({ completed: await orders.releaseEscrow() }));

  app.decorate("startConsumers", () => {
    runAuctionClosedConsumer(redis, ev => orders.onAuctionClosed(ev)).catch(e => { app.log.error(e); process.exit(1); });
  });
  return Object.assign(app, { deps: { db, redis, payments, shipping, invoices, orders } });
}

if (process.argv[1]?.endsWith("server.ts") || process.env.RUN_SERVER === "1") {
  const app = buildApp();
  app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" }).then(() => (app as unknown as { startConsumers: () => void }).startConsumers());
}

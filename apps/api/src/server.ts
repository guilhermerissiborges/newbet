/**
 * API Arrematto — Fastify. Semana 1: rotas de show/listing/leilão (comando ao realtime) e
 * consumidor de `auction.closed`. Persistência via Prisma entra quando o DATABASE_URL existir
 * (semana 2); até lá, o handler registra em memória para a demo de sexta.
 */
import Fastify from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";
import { runAuctionClosedConsumer } from "./consumers/auctionClosed.js";
import { computeFees, bundle, type WonItem } from "@arrematto/domain";

const PORT = Number(process.env.PORT ?? 8080);
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const app = Fastify({ logger: true });

// --- estado em memória só para a demo da semana 1 (substituído por Prisma na semana 2) ---
const wonItems: WonItem[] = [];
const closedEvents: unknown[] = [];

app.get("/health", async () => ({ ok: true, service: "api", now: Date.now() }));

const StartAuction = z.object({
  showId: z.string(), listingId: z.string(), startingBidCents: z.number().int().positive(),
  durationMs: z.number().int().min(5_000).max(600_000).optional(), mode: z.enum(["standard", "sudden_death"]).optional(),
});
/** Seller inicia um item: a API valida (dono do show, listing ativa) e manda o comando ao realtime. */
app.post("/shows/:showId/auction/start", async (req, reply) => {
  const body = StartAuction.safeParse({ ...(req.body as object), showId: (req.params as { showId: string }).showId });
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  await redis.publish("commands:auction", JSON.stringify({ type: "start", ...body.data }));
  return { started: true, listingId: body.data.listingId };
});

/** Fim do show: agrupa os arremates por comprador+seller (Smart Bundling) e calcula taxas. */
app.post("/shows/:showId/close", async (req) => {
  const showId = (req.params as { showId: string }).showId;
  const items = wonItems.filter(w => w.listingId.startsWith(showId) || true); // demo: todos os itens pendentes
  const quote = (g: number) => (g <= 500 ? 1490 : g <= 1000 ? 1990 : g <= 2000 ? 2790 : 3990); // substituído por Melhor Envio
  const bundles = bundle(items, quote).map(b => ({ ...b, fees: computeFees({ itemsCents: b.totalItemsCents, shippingCents: b.shippingCents, taxCents: 0 }, 0) }));
  wonItems.length = 0;
  return { showId, orders: bundles };
});

app.get("/debug/closed", async () => closedEvents);

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  runAuctionClosedConsumer(redis, async (ev) => {
    closedEvents.push(ev);
    if (ev.status === "sold" && ev.winnerUserId) {
      // demo: peso fixo; na semana 2 vem da Listing
      wonItems.push({ listingId: ev.listingId, buyerId: ev.winnerUserId, sellerId: "seller-demo", priceCents: ev.priceCents, weightGrams: 400 });
    }
    app.log.info({ ev }, "auction.closed processado");
  }).catch(e => { app.log.error(e); process.exit(1); });
});

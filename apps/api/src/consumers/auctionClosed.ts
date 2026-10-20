/**
 * Consome `events:auction` (Redis Stream) com consumer group: cada evento `auction.closed` vira
 * (1) snapshot da listing, (2) item vencido na "cesta do show" do comprador. O pedido real só é criado
 * ao fim do show pelo job de bundling (um pedido por comprador+seller, frete do primeiro item + incrementos).
 * Idempotente: a listing só muda de ACTIVE para SOLD/UNSOLD uma vez; reprocessar não duplica.
 */
import { Redis } from "ioredis";
import { AuctionClosedEvent } from "@arrematto/contracts";

export interface ClosedHandler {
  (ev: AuctionClosedEvent): Promise<void>;
}

export async function runAuctionClosedConsumer(redis: Redis, handler: ClosedHandler, opts = { group: "api", consumer: `api-${process.pid}` }) {
  try { await redis.xgroup("CREATE", "events:auction", opts.group, "0", "MKSTREAM"); } catch { /* grupo já existe */ }
  for (;;) {
    const res = (await redis.xreadgroup("GROUP", opts.group, opts.consumer, "COUNT", 50, "BLOCK", 5000, "STREAMS", "events:auction", ">")) as
      | [string, [string, string[]][]][] | null;
    if (!res) continue;
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const raw = fields[fields.indexOf("payload") + 1];
        const parsed = AuctionClosedEvent.safeParse(JSON.parse(raw));
        if (parsed.success) {
          try { await handler(parsed.data); await redis.xack("events:auction", opts.group, id); }
          catch (e) { console.error("auction.closed handler failed; will retry", id, e); }
        } else {
          console.error("evento inválido descartado", id, parsed.error.message);
          await redis.xack("events:auction", opts.group, id);
        }
      }
    }
  }
}

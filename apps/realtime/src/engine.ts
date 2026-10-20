import { Redis } from "ioredis";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { minIncrementCents, type AuctionConfig } from "@arrematto/domain";
import type { AuctionSnapshot, AuctionClosedEvent } from "@arrematto/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
const BID_LUA = readFileSync(path.join(here, "lua", "bid.lua"), "utf8");

// close.lua: fecha se o timer zerou; idempotente. Retorna {status, winner, price, bidCount} ou nil se ainda roda.
const CLOSE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local status = redis.call('HGET', key, 'status')
if status == 'sold' or status == 'unsold' then
  return {status, redis.call('HGET', key, 'leader') or '', redis.call('HGET', key, 'price') or '0', redis.call('HGET', key, 'bidCount') or '0', 'already'}
end
if status ~= 'running' then return nil end
local endsAt = tonumber(redis.call('HGET', key, 'endsAt'))
if now < endsAt then return nil end
local leader = redis.call('HGET', key, 'leader') or ''
local final = 'unsold'
if leader ~= '' then final = 'sold' end
redis.call('HSET', key, 'status', final, 'closedAt', now)
return {final, leader, redis.call('HGET', key, 'price') or '0', redis.call('HGET', key, 'bidCount') or '0', 'closed'}
`;

export interface BidOutcome {
  ok: boolean;
  reason?: "not_running" | "ended" | "too_low" | "self_outbid";
  priceCents?: number;
  leaderUserId?: string | null;
  endsAt?: number;
  bidCount?: number;
  outbid?: boolean;
  timerReset?: boolean;
}

export class AuctionEngine {
  private redis: Redis & { bid?: (...a: unknown[]) => Promise<unknown>; closeAuction?: (...a: unknown[]) => Promise<unknown> };
  constructor(redis: Redis) {
    this.redis = redis;
    this.redis.defineCommand("bid", { numberOfKeys: 1, lua: BID_LUA });
    this.redis.defineCommand("closeAuction", { numberOfKeys: 1, lua: CLOSE_LUA });
  }

  key(listingId: string) { return `auction:${listingId}`; }

  async start(showId: string, listingId: string, config: AuctionConfig, now: number): Promise<AuctionSnapshot> {
    const k = this.key(listingId);
    await this.redis.hset(k, {
      status: "running", showId, startingBid: config.startingBidCents, endsAt: now + config.durationMs,
      counterWindow: config.counterBidWindowMs, counterMs: config.counterBidMs, mode: config.mode,
      price: 0, leader: "", leaderMax: 0, bidCount: 0, startedAt: now,
    });
    await this.redis.expire(k, 60 * 60 * 24); // snapshot vai para o Postgres ao fechar; Redis guarda 24 h
    return (await this.snapshot(listingId, now))!;
  }

  async bid(listingId: string, userId: string, maxCents: number, now: number): Promise<BidOutcome> {
    const r = (await this.redis.bid!(this.key(listingId), userId, String(maxCents), String(now))) as (string | number)[];
    if (Number(r[0]) !== 1) return { ok: false, reason: r[1] as BidOutcome["reason"] };
    return {
      ok: true, priceCents: Number(r[1]), leaderUserId: (r[2] as string) || null, endsAt: Number(r[4]),
      bidCount: Number(r[5]), outbid: Number(r[6]) === 1, timerReset: Number(r[7]) === 1,
    };
  }

  /** Fecha o leilão se o timer zerou. Devolve o evento (uma única vez) ou null. */
  async closeIfEnded(listingId: string, now: number): Promise<AuctionClosedEvent | null> {
    const r = (await this.redis.closeAuction!(this.key(listingId), String(now))) as (string)[] | null;
    if (!r || r[4] === "already") return null;
    const showId = (await this.redis.hget(this.key(listingId), "showId")) ?? "";
    const ev: AuctionClosedEvent = {
      type: "auction.closed", showId, listingId, status: r[0] as "sold" | "unsold",
      winnerUserId: r[1] || null, priceCents: Number(r[2]), bidCount: Number(r[3]), closedAt: now,
    };
    // entrega garantida para a API: Redis Stream com consumer group (a API confirma com XACK)
    await this.redis.xadd("events:auction", "*", "payload", JSON.stringify(ev));
    return ev;
  }

  async snapshot(listingId: string, now: number): Promise<AuctionSnapshot | null> {
    const h = await this.redis.hgetall(this.key(listingId));
    if (!h.status) return null;
    const price = Number(h.price); const leader = h.leader || null;
    return {
      listingId, status: h.status as AuctionSnapshot["status"], currentPriceCents: price, leaderUserId: leader,
      minNextBidCents: leader ? price + minIncrementCents(price) : Number(h.startingBid),
      endsAt: Number(h.endsAt), bidCount: Number(h.bidCount), serverNow: now,
    };
  }
}

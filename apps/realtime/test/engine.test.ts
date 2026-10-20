import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { spawn, type ChildProcess } from "node:child_process";
import { AuctionEngine } from "../src/engine.js";
import { startAuction, placeBid, DEFAULT_CONFIG, type AuctionState } from "@arrematto/domain";

const PORT = 6399;
let proc: ChildProcess; let redis: Redis; let engine: AuctionEngine;

beforeAll(async () => {
  proc = spawn("redis-server", ["--port", String(PORT), "--save", "", "--appendonly", "no", "--loglevel", "warning"]);
  redis = new Redis({ port: PORT, lazyConnect: true });
  for (let i = 0; i < 50; i++) { try { await redis.connect(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  engine = new AuctionEngine(redis);
}, 20_000);
afterAll(async () => { await redis.quit(); proc.kill(); });

const cfg = { ...DEFAULT_CONFIG, startingBidCents: 1000 };
const T0 = 1_000_000;

describe("motor Lua", () => {
  it("fluxo básico: start → lances → close com evento no stream", async () => {
    await redis.flushall();
    await engine.start("S1", "L1", cfg, T0);
    expect((await engine.bid("L1", "ana", 5000, T0 + 1000)).priceCents).toBe(1000);
    const r2 = await engine.bid("L1", "bia", 3000, T0 + 2000);
    expect(r2.ok && r2.leaderUserId).toBe("ana"); expect(r2.priceCents).toBe(3200);
    const r3 = await engine.bid("L1", "bia", 9000, T0 + 25_000);
    expect(r3.leaderUserId).toBe("bia"); expect(r3.priceCents).toBe(5500); expect(r3.timerReset).toBe(true); expect(r3.endsAt).toBe(T0 + 33_000);
    expect(await engine.closeIfEnded("L1", T0 + 30_000)).toBeNull();
    const ev = await engine.closeIfEnded("L1", T0 + 33_000);
    expect(ev).toMatchObject({ status: "sold", winnerUserId: "bia", priceCents: 5500, bidCount: 3 });
    expect(await engine.closeIfEnded("L1", T0 + 34_000)).toBeNull(); // idempotente
    const stream = await redis.xrange("events:auction", "-", "+");
    expect(stream).toHaveLength(1);
    expect((await engine.bid("L1", "ana", 99_000, T0 + 35_000)).reason).toBe("not_running");
  });

  it("paridade Lua ↔ TypeScript em 3 mil lances aleatórios", async () => {
    await redis.flushall();
    let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const c = { ...cfg, durationMs: 10_000_000 };
    await engine.start("S1", "L2", c, T0);
    let ts: AuctionState = startAuction("L2", c, T0);
    for (let i = 0; i < 3000; i++) {
      const u = `u${Math.floor(rnd() * 20)}`; const max = Math.max(0, ts.currentPriceCents - 500 + Math.floor(rnd() * 4000)); const now = T0 + i * 10;
      const a = placeBid(ts, u, max, now); const b = await engine.bid("L2", u, max, now);
      expect(b.ok).toBe(a.ok);
      if (a.ok && b.ok) { ts = a.state; expect(b.priceCents).toBe(ts.currentPriceCents); expect(b.leaderUserId).toBe(ts.leaderUserId); expect(b.endsAt).toBe(ts.endsAt); }
      else if (!a.ok && !b.ok) expect(b.reason).toBe(a.reason);
    }
  }, 60_000);

  it("2.000 lances concorrentes: nenhum perdido, ordem total, preço monotônico", async () => {
    await redis.flushall();
    await engine.start("S1", "L3", { ...cfg, durationMs: 10_000_000, mode: "sudden_death" }, T0);
    const pool = Array.from({ length: 8 }, () => new Redis({ port: PORT }));
    const engines = pool.map(r => new AuctionEngine(r));
    const results = await Promise.all(Array.from({ length: 2000 }, (_, i) => engines[i % 8].bid("L3", `u${i % 100}`, 1000 + i * 10, T0 + i)));
    const accepted = results.filter(r => r.ok);
    expect(accepted.length + results.filter(r => !r.ok).length).toBe(2000);
    const log = await redis.xrange("auction:L3:bids", "-", "+");
    expect(log.length).toBe(accepted.length);
    let prev = 0;
    for (const [, fields] of log) { const p = Number(fields[fields.indexOf("price") + 1]); expect(p).toBeGreaterThanOrEqual(prev); prev = p; }
    const snap = await engine.snapshot("L3", T0 + 5000);
    expect(snap!.bidCount).toBe(accepted.length);
    await Promise.all(pool.map(r => r.quit()));
  }, 60_000);
});

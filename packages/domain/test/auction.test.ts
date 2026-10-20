import { describe, it, expect } from "vitest";
import { startAuction, placeBid, closeIfEnded, minNextBidCents, DEFAULT_CONFIG, type AuctionState } from "../src/auction.js";

const cfg = { ...DEFAULT_CONFIG, startingBidCents: 1000 };
const T0 = 1_000_000;

function run(bids: Array<[string, number, number]>, state = startAuction("L1", cfg, T0)): AuctionState {
  let s = state;
  for (const [u, max, t] of bids) {
    const r = placeBid(s, u, max, t);
    if (!r.ok) throw new Error(`bid rejected: ${r.reason}`);
    s = r.state;
  }
  return s;
}

describe("leilão — regras básicas", () => {
  it("primeiro lance vale o starting bid, mesmo com teto maior", () => {
    const s = run([["ana", 5000, T0 + 1000]]);
    expect(s.currentPriceCents).toBe(1000);
    expect(s.leaderUserId).toBe("ana");
    expect(s.leaderMaxCents).toBe(5000);
  });
  it("rejeita lance abaixo do mínimo", () => {
    const s = run([["ana", 1000, T0 + 1000]]);
    expect(placeBid(s, "bia", 1050, T0 + 2000)).toEqual({ ok: false, reason: "too_low" });
    expect(minNextBidCents(s)).toBe(1200);
  });
  it("proxy: desafiante abaixo do teto do líder sobe o preço, líder permanece", () => {
    const s = run([["ana", 5000, T0 + 1000], ["bia", 3000, T0 + 2000]]);
    expect(s.leaderUserId).toBe("ana");
    expect(s.currentPriceCents).toBe(3200); // teto da bia + incremento (R$2 na faixa < R$50)
  });
  it("proxy: desafiante acima do teto vira líder pagando teto antigo + incremento", () => {
    const s = run([["ana", 5000, T0 + 1000], ["bia", 9000, T0 + 2000]]);
    expect(s.leaderUserId).toBe("bia");
    expect(s.currentPriceCents).toBe(5500);
  });
  it("empate de teto: quem chegou primeiro mantém a liderança", () => {
    const s = run([["ana", 5000, T0 + 1000], ["bia", 5000, T0 + 2000]]);
    expect(s.leaderUserId).toBe("ana");
    expect(s.currentPriceCents).toBe(5000);
  });
  it("líder não pode dar lance abaixo do próprio teto", () => {
    const s = run([["ana", 5000, T0 + 1000]]);
    expect(placeBid(s, "ana", 4000, T0 + 2000)).toEqual({ ok: false, reason: "self_outbid" });
  });
});

describe("leilão — timer", () => {
  it("lance fora da janela final não reseta o timer", () => {
    const r = placeBid(startAuction("L1", cfg, T0), "ana", 1000, T0 + 5000);
    expect(r.ok && r.timerReset).toBe(false);
    expect(r.ok && r.state.endsAt).toBe(T0 + 30_000);
  });
  it("lance nos últimos 10 s reseta o timer para 8 s", () => {
    const r = placeBid(startAuction("L1", cfg, T0), "ana", 1000, T0 + 25_000);
    expect(r.ok && r.timerReset).toBe(true);
    expect(r.ok && r.state.endsAt).toBe(T0 + 33_000);
  });
  it("Sudden Death nunca estende", () => {
    const r = placeBid(startAuction("L1", { ...cfg, mode: "sudden_death" }, T0), "ana", 1000, T0 + 29_000);
    expect(r.ok && r.timerReset).toBe(false);
    expect(r.ok && r.state.endsAt).toBe(T0 + 30_000);
  });
  it("lance após o fim é rejeitado e o leilão fecha como vendido", () => {
    const s = run([["ana", 1000, T0 + 1000]]);
    expect(placeBid(s, "bia", 2000, T0 + 30_000)).toEqual({ ok: false, reason: "ended" });
    expect(closeIfEnded(s, T0 + 30_000).status).toBe("sold");
  });
  it("sem lances fecha como não vendido", () => {
    expect(closeIfEnded(startAuction("L1", cfg, T0), T0 + 30_000).status).toBe("unsold");
  });
});

describe("leilão — propriedades (10 mil lances aleatórios)", () => {
  it("preço nunca cai, nunca passa do teto do líder, líder sempre tem o maior teto visto", () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    let s = startAuction("L1", { ...cfg, durationMs: 10_000_000, mode: "sudden_death" }, T0);
    let maxSeen = 0;
    for (let i = 0; i < 10_000; i++) {
      const u = `u${Math.floor(rnd() * 50)}`;
      const max = minNextBidCents(s) - 300 + Math.floor(rnd() * 5000); // em torno do mínimo: alguns abaixo (rejeitados), muitos acima
      const r = placeBid(s, u, max, T0 + i);
      if (r.ok) {
        expect(r.state.currentPriceCents).toBeGreaterThanOrEqual(s.currentPriceCents);
        expect(r.state.currentPriceCents).toBeLessThanOrEqual(r.state.leaderMaxCents);
        maxSeen = Math.max(maxSeen, max);
        expect(r.state.leaderMaxCents).toBe(maxSeen);
        s = r.state;
      }
    }
    expect(s.bidCount).toBeGreaterThan(5000);
  });
});

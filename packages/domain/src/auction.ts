/**
 * Regras puras do leilão ao vivo. Sem I/O, sem relógio próprio: tudo recebe `now` em ms.
 * Espelha o comportamento observado no Whatnot (help center, out/2026):
 *  - duração mínima definida pelo seller; lances nos últimos `counterBidWindowMs` resetam o timer para `counterBidMs`
 *  - Sudden Death: sem extensão; o maior lance quando o timer zera vence
 *  - incremento mínimo cresce com o preço
 *  - Max Bid (proxy) privado; empate resolve para quem chegou primeiro
 *  - lance é vinculante: a decisão de aceitar é a mesma que gera a obrigação de pagar
 * Valores monetários em centavos inteiros.
 */

export type AuctionMode = "standard" | "sudden_death";

export interface AuctionConfig {
  /** lance inicial em centavos */
  startingBidCents: number;
  /** duração inicial do timer */
  durationMs: number;
  /** janela final em que um lance reseta o timer (padrão 10 s) */
  counterBidWindowMs: number;
  /** para quanto o timer volta ao ser resetado (ex.: 8 s) */
  counterBidMs: number;
  mode: AuctionMode;
}

export interface AuctionState {
  listingId: string;
  status: "scheduled" | "running" | "sold" | "unsold";
  config: AuctionConfig;
  startedAt: number;
  endsAt: number;
  currentPriceCents: number; // preço vigente (0 enquanto não há lance)
  leaderUserId: string | null;
  leaderMaxCents: number; // teto privado do líder (proxy bidding)
  bidCount: number;
}

export const DEFAULT_CONFIG: Omit<AuctionConfig, "startingBidCents"> = {
  durationMs: 30_000,
  counterBidWindowMs: 10_000,
  counterBidMs: 8_000,
  mode: "standard",
};

/** Incremento mínimo por faixa de preço (centavos). Faixas inspiradas em casas de leilão; ajustar por país. */
export function minIncrementCents(currentPriceCents: number): number {
  if (currentPriceCents < 1_000) return 100; // < R$10 → R$1
  if (currentPriceCents < 5_000) return 200; // < R$50 → R$2
  if (currentPriceCents < 10_000) return 500; // < R$100 → R$5
  if (currentPriceCents < 50_000) return 1_000; // < R$500 → R$10
  if (currentPriceCents < 100_000) return 2_500; // < R$1.000 → R$25
  return 5_000; // R$50
}

/** Menor lance aceitável agora. */
export function minNextBidCents(s: Pick<AuctionState, "currentPriceCents" | "config" | "leaderUserId">): number {
  if (!s.leaderUserId) return s.config.startingBidCents;
  return s.currentPriceCents + minIncrementCents(s.currentPriceCents);
}

export function startAuction(listingId: string, config: AuctionConfig, now: number): AuctionState {
  return {
    listingId,
    status: "running",
    config,
    startedAt: now,
    endsAt: now + config.durationMs,
    currentPriceCents: 0,
    leaderUserId: null,
    leaderMaxCents: 0,
    bidCount: 0,
  };
}

export type BidResult =
  | { ok: true; state: AuctionState; outbid: boolean; timerReset: boolean }
  | { ok: false; reason: "not_running" | "ended" | "too_low" | "self_outbid" };

/**
 * Aplica um lance. `maxCents` é o teto do licitante (proxy). Um lance "simples" tem maxCents = valor.
 * Regras de proxy: o preço vigente sobe para o mínimo necessário para superar o segundo maior teto;
 * em empate de tetos, o líder anterior permanece (quem chegou primeiro).
 */
export function placeBid(s: AuctionState, userId: string, maxCents: number, now: number): BidResult {
  if (s.status !== "running") return { ok: false, reason: "not_running" };
  if (now >= s.endsAt) return { ok: false, reason: "ended" };
  const floor = minNextBidCents(s);
  if (maxCents < floor) return { ok: false, reason: "too_low" };

  let next: AuctionState;
  let outbid = false;

  if (s.leaderUserId === userId) {
    // mesmo usuário elevando o próprio teto: preço não muda, teto sobe
    if (maxCents <= s.leaderMaxCents) return { ok: false, reason: "self_outbid" };
    next = { ...s, leaderMaxCents: maxCents, bidCount: s.bidCount + 1 };
  } else if (!s.leaderUserId) {
    next = { ...s, currentPriceCents: floor, leaderUserId: userId, leaderMaxCents: maxCents, bidCount: s.bidCount + 1 };
    outbid = false;
  } else if (maxCents > s.leaderMaxCents) {
    // novo líder: paga o teto antigo + incremento, limitado ao próprio teto
    const price = Math.min(maxCents, s.leaderMaxCents + minIncrementCents(s.leaderMaxCents));
    next = { ...s, currentPriceCents: Math.max(price, floor), leaderUserId: userId, leaderMaxCents: maxCents, bidCount: s.bidCount + 1 };
    outbid = true;
  } else {
    // teto não supera o líder: líder permanece, preço sobe até o teto do desafiante (+ incremento, limitado ao teto do líder)
    const price = Math.min(s.leaderMaxCents, maxCents + minIncrementCents(maxCents));
    next = { ...s, currentPriceCents: Math.max(price, s.currentPriceCents), bidCount: s.bidCount + 1 };
    outbid = false;
  }

  let timerReset = false;
  if (s.config.mode === "standard" && s.endsAt - now <= s.config.counterBidWindowMs) {
    next = { ...next, endsAt: now + s.config.counterBidMs };
    timerReset = true;
  }
  return { ok: true, state: next, outbid, timerReset };
}

/** Fecha o leilão se o timer zerou. Retorna o estado final (sold/unsold) ou o mesmo estado se ainda roda. */
export function closeIfEnded(s: AuctionState, now: number): AuctionState {
  if (s.status !== "running" || now < s.endsAt) return s;
  return { ...s, status: s.leaderUserId ? "sold" : "unsold" };
}

export function remainingMs(s: AuctionState, now: number): number {
  return Math.max(0, s.endsAt - now);
}

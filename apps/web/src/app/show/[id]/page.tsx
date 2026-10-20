"use client";
/**
 * Página do show (comprador) — implementa o doc "Psicologia do produto" (seções 3, 4, 6) e o canvas "App · Show ao vivo".
 *
 * Tempo, som e movimento (seção 4):
 *  - anel do timer: forma + número; coral e pulso de 1 Hz só nos últimos 10 s; reset "enche de volta" em 200 ms, sem som
 *  - lance aceito: haptic curto + preço sobe em 150 ms
 *  - coberto: texto âmbar, sem som, sem vibração
 *  - ganhou: um som de 300 ms, card menta por 2 s
 *  - perdeu: âmbar 1 s com "ficou por R$ X" (diferença real) + próximo item do mesmo seller com pré-lance de um toque
 *  - entre itens: respiro com o próximo item mostrado
 *  - chat livre, seller fixado, toggle "só seller e menções"; reações flutuantes
 *  - relógio do show e hora atual sempre no topo; troféu de sessão aos 30 min, dispensável
 *  - celebração grande (confete) só em marcos raros: primeiro arremate da conta, 10º, 50º
 * Cores (seção 3): coral só em lance/AO VIVO/timer ≤10 s; menta só estado positivo; âmbar atenção sem urgência; preço branco em Sora.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { AuctionSnapshot, ServerMessage } from "@arrematto/contracts";
import { API, WS, brl } from "@/lib/api";

type Chat = { userId: string; text: string; at: number };
type Listing = { id: string; title: string; priceCents: number; status: string; imageUrls: string[]; createdAt?: string };
type ShowData = { title: string; status: string; startedAt?: string | null; sellerName?: string; listings: Listing[] };
type Reaction = { id: number; kind: "heart" | "fire" | "clap"; x: number };
type Outcome = { kind: "won"; priceCents: number } | { kind: "lost_close"; diffCents: number; winner: string } | { kind: "lost"; winner: string } | null;

const MILESTONES = new Set([1, 10, 50]);

/* ---------- Som e haptic (seção 4): um som de 300 ms ao ganhar; vibração curta ao lance aceito ---------- */
function playWinTone() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(660, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.3);
  } catch {}
}
const haptic = (ms = 30) => { try { navigator.vibrate?.(ms); } catch {} };

/* ---------- Anel do timer ---------- */
function TimerRing({ remaining, total, status, won }: { remaining: number; total: number; status: AuctionSnapshot["status"]; won: boolean }) {
  const r = 28, c = 2 * Math.PI * r;
  const frac = status === "running" ? Math.max(0, Math.min(1, remaining / Math.max(total, 1))) : 0;
  const urgent = status === "running" && remaining <= 10_000;
  const label = status === "running" ? (remaining / 1000).toFixed(remaining < 10_000 ? 1 : 0) : won ? "✓" : "fim";
  const color = urgent ? "var(--coral)" : won ? "var(--menta)" : status === "running" ? "var(--texto)" : "var(--apoio)";
  return (
    <div className={`relative w-16 h-16 flex-none rounded-full ${urgent ? "pulse-coral" : ""}`} aria-label={status === "running" ? `${Math.ceil(remaining / 1000)} segundos` : label}>
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--carvao-3)" strokeWidth="4" />
        {/* a transição de 200 ms é o "encher de volta" no reset do timer */}
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: "stroke-dashoffset 200ms linear, stroke 200ms" }} />
      </svg>
      <div className={`absolute inset-0 flex flex-col items-center justify-center font-display font-bold tabular leading-none ${label === "fim" ? "text-xs" : "text-xl"}`} style={{ color }}>{label}</div>
    </div>
  );
}

/* ---------- Preço: sobe com animação de 150 ms ---------- */
function Price({ cents }: { cents: number }) {
  const [bump, setBump] = useState(false);
  const prev = useRef(cents);
  useEffect(() => { if (cents !== prev.current) { prev.current = cents; setBump(true); const t = setTimeout(() => setBump(false), 150); return () => clearTimeout(t); } }, [cents]);
  return <div className={`font-display font-bold text-[28px] leading-8 tabular text-white ${bump ? "price-bump" : ""}`}>{brl(cents)}</div>;
}

/* ---------- Confete só nos marcos raros ---------- */
function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 36 }, (_, i) => ({ i, x: Math.random() * 100, d: 0.8 + Math.random() * 0.8, r: Math.random() * 360, c: ["#FF5A3C", "#2BD9A0", "#F2B33D", "#F3F4F6"][i % 4] })), []);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {pieces.map(p => <span key={p.i} className="confetti" style={{ left: `${p.x}%`, background: p.c, animationDuration: `${p.d}s`, transform: `rotate(${p.r}deg)` }} />)}
    </div>
  );
}

function ShowPageInner() {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const userId = q.get("user") ?? "visitante";

  const [snap, setSnap] = useState<AuctionSnapshot | null>(null);
  const [total, setTotal] = useState(30_000);
  const [chat, setChat] = useState<Chat[]>([]);
  const [focusChat, setFocusChat] = useState(false); // toggle "só seller e menções"
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [viewers, setViewers] = useState(0);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [max, setMax] = useState("");
  const [toast, setToast] = useState<{ text: string; tone: "menta" | "ambar" | "apoio" } | null>(null);
  const [show, setShow] = useState<ShowData | null>(null);
  const [firstBidSheet, setFirstBidSheet] = useState(false);
  const [wantLimit, setWantLimit] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sessionSpentCents, setSessionSpentCents] = useState(0);
  const [sessionWins, setSessionWins] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confetti, setConfetti] = useState(false);
  const [trophy, setTrophy] = useState<{ minutes: number } | null>(null);
  const [preBid, setPreBid] = useState<{ listingId: string; cents: number } | null>(null); // pré-lance de um toque no próximo item

  const ws = useRef<WebSocket | null>(null);
  const lastListing = useRef<string | null>(null);
  const myMaxByListing = useRef<Map<string, number>>(new Map());
  const closedListings = useRef<Set<string>>(new Set()); // itens já encerrados nesta sessão (a lista do show não é recarregada a cada fechamento)
  const sessionStart = useRef(Date.now());
  const lastTrophyAt = useRef(0);
  const reactionId = useRef(0);

  useEffect(() => { try { setAcknowledged(localStorage.getItem("arrematto.firstBidAck") === "1"); } catch {} }, []);
  useEffect(() => { fetch(`${API}/shows/${id}`).then(r => r.json()).then(setShow).catch(() => {}); }, [id]);

  const send = useCallback((m: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m)), []);
  const sendBid = useCallback((listingId: string, cents: number) => { myMaxByListing.current.set(listingId, Math.max(cents, myMaxByListing.current.get(listingId) ?? 0)); send({ type: "bid", listingId, maxCents: cents, clientBidId: String(Date.now()) }); }, [send]);

  useEffect(() => {
    const sock = new WebSocket(WS); ws.current = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "join", showId: id, token: `user:${userId}` }));
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.type === "auction") {
        const s = m.snapshot; setOffset(s.serverNow - Date.now());
        const isNew = lastListing.current !== s.listingId;
        if (isNew) {
          lastListing.current = s.listingId; setTotal(Math.max(5_000, s.endsAt - s.serverNow)); setOutcome(null);
          // pré-lance armado para este item: entra sozinho assim que o item roda
          setPreBid(p => { if (p && p.listingId === s.listingId && s.status === "running") { sendBid(s.listingId, Math.max(p.cents, s.minNextBidCents)); setToast({ text: `Pré-lance de ${brl(Math.max(p.cents, s.minNextBidCents))} enviado`, tone: "menta" }); return null; } return p; });
        }
        if (s.status !== "running") closedListings.current.add(s.listingId);
        setSnap(prev => {
          if (prev && prev.listingId === s.listingId && prev.status === "running" && s.status !== "running") {
            // fechamento: decidir o desfecho para ESTE usuário
            const mine = myMaxByListing.current.get(s.listingId);
            if (s.status === "sold" && s.leaderUserId === userId) {
              setSessionSpentCents(v => v + s.currentPriceCents);
              setSessionWins(w => { const n = w + 1; const lifetime = bumpLifetimeWins(); if (MILESTONES.has(lifetime)) { setConfetti(true); setTimeout(() => setConfetti(false), 2200); } return n; });
              playWinTone(); setOutcome({ kind: "won", priceCents: s.currentPriceCents });
            } else if (s.status === "sold" && mine) {
              const diff = s.currentPriceCents - mine;
              setOutcome(diff > 0 && diff <= 2 * s.currentPriceCents * 0.1 ? { kind: "lost_close", diffCents: diff, winner: s.leaderUserId ?? "" } : { kind: "lost", winner: s.leaderUserId ?? "" });
            }
          }
          return s;
        });
      }
      else if (m.type === "chat") setChat(c => [...c.slice(-299), m]);
      else if (m.type === "reaction") pushReaction(m.kind);
      else if (m.type === "viewers" || m.type === "joined") setViewers("viewers" in m ? m.viewers : m.count);
      else if (m.type === "bid_result") {
        if (m.ok) { haptic(30); setToast(m.youLead ? { text: "Você lidera", tone: "menta" } : { text: "Coberto: alguém tinha um teto maior", tone: "ambar" }); }
        else setToast({ text: m.reason === "too_low" ? "Abaixo do mínimo" : m.reason === "ended" ? "O tempo acabou" : m.reason === "self_outbid" ? "Seu teto já é maior" : "Lance não aceito", tone: "apoio" });
      }
      else if (m.type === "error") setToast({ text: m.message === "slow_down" ? "Calma no chat" : m.message, tone: "apoio" });
    };
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => { clearInterval(t); sock.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userId]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);
  // troféu de sessão a cada 30 min, positivo e dispensável
  useEffect(() => {
    const elapsedMin = Math.floor((now - sessionStart.current) / 60_000);
    if (elapsedMin > 0 && elapsedMin % 30 === 0 && lastTrophyAt.current !== elapsedMin) { lastTrophyAt.current = elapsedMin; setTrophy({ minutes: elapsedMin }); }
  }, [now]);

  function pushReaction(kind: Reaction["kind"]) {
    const r = { id: ++reactionId.current, kind, x: 10 + Math.random() * 30 };
    setReactions(rs => [...rs.slice(-24), r]);
    setTimeout(() => setReactions(rs => rs.filter(x => x.id !== r.id)), 1800);
  }
  function bumpLifetimeWins() { try { const n = Number(localStorage.getItem("arrematto.wins") ?? 0) + 1; localStorage.setItem("arrematto.wins", String(n)); return n; } catch { return 0; } }

  const remaining = snap ? Math.max(0, snap.endsAt - (now + offset)) : 0;
  const running = snap?.status === "running" && remaining > 0;
  const current = useMemo(() => show?.listings.find(l => l.id === snap?.listingId), [show, snap]);
  // próximo item do mesmo seller: o primeiro ainda disponível, na ordem da fila (createdAt), excluindo o atual
  const next = useMemo(() => { if (!show || !snap) return null; const done = new Set(["SOLD", "UNSOLD", "RUNNING", "CANCELLED"]); return [...show.listings].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).find(l => l.id !== snap.listingId && !closedListings.current.has(l.id) && !done.has(String(l.status).toUpperCase())) ?? null; }, [show, snap]);
  const youLead = snap?.leaderUserId === userId;
  const bid = (cents: number) => { if (!snap) return; if (!acknowledged) { setFirstBidSheet(true); return; } sendBid(snap.listingId, cents); };
  const ackAndBid = () => { try { localStorage.setItem("arrematto.firstBidAck", "1"); if (wantLimit) localStorage.setItem("arrematto.limitOptIn", "1"); } catch {} setAcknowledged(true); setFirstBidSheet(false); if (snap) sendBid(snap.listingId, snap.minNextBidCents); };
  const sendChat = (text: string) => text.trim() && send({ type: "chat", text: text.trim() });
  const react = (kind: Reaction["kind"]) => { pushReaction(kind); send({ type: "reaction", kind }); };
  const elapsed = show?.startedAt ? Math.max(0, now - new Date(show.startedAt).getTime()) : 0;
  const hhmm = (ms: number) => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`; };
  const clock = new Date(now).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const pinned = [...chat].reverse().find(c => c.userId === "seller");
  const visibleChat = (focusChat ? chat.filter(c => c.userId === "seller" || c.text.includes(`@${userId}`)) : chat).slice(-5);

  // estado do card (seção 6 · Ganhou/perdeu): menta 2 s ao ganhar; âmbar 1 s ao perder por pouco
  const cardTone = outcome?.kind === "won" ? "card-won" : outcome?.kind === "lost_close" ? "card-lost" : "";

  return (
    <main className="min-h-screen bg-carvao text-texto grid grid-cols-1 lg:grid-cols-[1fr_380px]">
      <section className="relative aspect-[9/16] lg:aspect-auto lg:h-screen bg-black overflow-hidden">
        <div className="absolute inset-0 bg-[#1A1C22] flex items-center justify-center text-apoio text-sm">vídeo ao vivo · câmera do seller</div>
        {confetti && <Confetti />}

        {/* Topo: seller · relógio do show (sempre) · AO VIVO coral */}
        <div className="absolute top-4 left-4 right-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#D9B38C] flex-none" />
          <div className="flex-1 min-w-0">
            <div className="font-display font-semibold text-sm leading-tight truncate">{show?.sellerName ?? show?.title ?? "…"} <span className="text-menta text-[11px] font-normal">● online</span></div>
            <div className="text-xs text-texto-2 tabular"><span className="font-display font-semibold">{clock}</span>{show?.startedAt && <> · no ar há <span className="font-display font-semibold">{hhmm(elapsed)}</span></>}</div>
          </div>
          <button className="h-8 px-3.5 rounded-full border border-texto text-sm font-semibold">Seguir</button>
          <div className="h-7 px-2.5 rounded-full bg-coral text-xs font-semibold flex items-center gap-1.5">AO VIVO <span className="font-display tabular">{viewers}</span></div>
        </div>

        {/* Troféu de sessão aos 30 min */}
        {trophy && (
          <div className="absolute top-16 left-4 right-4 h-10 px-3 rounded-xl bg-carvao-2 border border-borda flex items-center gap-2.5 text-xs" role="status">
            <span className="w-2 h-2 rounded-full bg-menta" />
            <span className="flex-1"><b>{trophy.minutes} min no show</b> · você arrematou <b className="font-display tabular">{brl(sessionSpentCents)}</b>{sessionWins > 0 && ` em ${sessionWins} ${sessionWins === 1 ? "item" : "itens"}`}</span>
            <button aria-label="Dispensar" onClick={() => setTrophy(null)} className="w-6 h-6 text-apoio text-base leading-none">×</button>
          </div>
        )}

        {/* Reações flutuantes */}
        <div className="pointer-events-none absolute right-4 bottom-[300px] w-16 h-56" aria-hidden="true">
          {reactions.map(r => <span key={r.id} className="reaction" style={{ right: r.x }}>{r.kind === "heart" ? "♥" : r.kind === "fire" ? "✦" : "✚"}</span>)}
        </div>

        {/* Chat: seller fixado, velocidade livre, toggle de foco */}
        <div className="absolute left-4 right-20 bottom-[280px] flex flex-col gap-1.5 text-[13px]">
          {pinned && <div className="flex gap-1.5 items-baseline px-2.5 py-1.5 rounded-lg bg-carvao-2 border-l-2 border-texto"><span className="font-semibold">{show?.sellerName ?? "seller"}</span><span className="truncate">{pinned.text}</span></div>}
          {visibleChat.filter(c => c !== pinned).map((c, i) => (
            <div key={i} className="flex gap-1.5 items-baseline"><span className={`font-semibold ${c.userId === "seller" ? "text-texto" : "text-menta"}`}>{c.userId}</span><span className="truncate">{c.text}</span></div>
          ))}
          <div className="flex gap-2 items-center mt-1">
            <form className="flex-1 flex" onSubmit={e => { e.preventDefault(); const f = e.currentTarget.elements.namedItem("t") as HTMLInputElement; sendChat(f.value); f.value = ""; }}>
              <input name="t" placeholder="Comentar…" maxLength={300} className="flex-1 h-9 px-3 rounded-full bg-carvao-2 border border-borda text-[13px] placeholder:text-apoio" />
            </form>
            <button onClick={() => setFocusChat(v => !v)} aria-pressed={focusChat} className={`h-9 px-2.5 rounded-full border text-[11px] font-medium ${focusChat ? "bg-texto text-carvao border-texto" : "bg-carvao-2 border-borda"}`}>só seller e menções</button>
          </div>
        </div>

        {/* Ações laterais */}
        <div className="absolute right-4 bottom-[280px] flex flex-col gap-3 items-center">
          <button aria-label="Reagir" onClick={() => react("heart")} className="w-11 h-11 rounded-full bg-[#23262E] flex items-center justify-center text-lg active:scale-90 transition-transform">♥</button>
          <button aria-label="Compartilhar" className="w-11 h-11 rounded-full bg-[#23262E] flex items-center justify-center text-lg">↗</button>
        </div>

        {/* Card de leilão único */}
        <div className={`absolute left-3 right-3 bottom-6 bg-carvao-2 border border-borda rounded-3xl p-3.5 flex flex-col gap-3 ${cardTone}`}>
          {snap ? (<>
            <div className="flex gap-3 items-center">
              <div className="w-16 h-16 rounded-2xl bg-[#3A2F28] flex-none overflow-hidden">{current?.imageUrls?.[0] && <img src={current.imageUrls[0]} alt="" className="w-full h-full object-cover" />}</div>
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="text-[13px] text-texto-2 truncate">{current?.title ?? snap.listingId}</div>
                <Price cents={snap.currentPriceCents || snap.minNextBidCents} />
                <div className={`text-xs font-semibold flex items-center gap-1.5 ${outcome?.kind === "won" || (running && youLead) ? "text-menta" : outcome?.kind === "lost_close" || (running && snap.leaderUserId && !youLead && myMaxByListing.current.has(snap.listingId)) ? "text-ambar" : "text-texto-2"}`}>
                  {outcome?.kind === "won" ? <><span aria-hidden>✓</span>é seu · vai para o seu pedido do show</>
                    : outcome?.kind === "lost_close" ? <><span aria-hidden>·</span>ficou por {brl(outcome.diffCents)} · arrematado por {outcome.winner}</>
                    : outcome?.kind === "lost" ? <>arrematado por {outcome.winner}</>
                    : snap.status === "sold" ? <>arrematado por {snap.leaderUserId}</>
                    : snap.status === "unsold" ? <>sem lances</>
                    : youLead ? <><span aria-hidden>●</span>você lidera</>
                    : snap.leaderUserId && myMaxByListing.current.has(snap.listingId) ? <><span aria-hidden>↑</span>coberto por {brl(snap.currentPriceCents - (myMaxByListing.current.get(snap.listingId) ?? 0))}</>
                    : snap.leaderUserId ? <>{snap.leaderUserId} lidera</> : <>sem lances ainda</>}
                  {running && <span className="text-texto-2 font-normal"> · {snap.bidCount} lances · {snap.bidderCount ?? 0} pessoas</span>}
                </div>
              </div>
              <TimerRing remaining={remaining} total={total} status={snap.status} won={snap.status === "sold" && youLead} />
            </div>

            {running ? (
              <div className="flex gap-2">
                <button onClick={() => bid(snap.minNextBidCents)} className="flex-1 h-[52px] rounded-2xl bg-coral text-white font-display font-bold text-[17px] active:scale-[0.98] transition-transform">{snap.leaderUserId && !youLead && myMaxByListing.current.has(snap.listingId) ? "Cobrir" : "Dar lance"} {brl(snap.minNextBidCents)}</button>
                <input value={max} onChange={e => setMax(e.target.value)} placeholder="R$" inputMode="decimal" className="w-20 rounded-2xl bg-carvao-3 px-3 text-center text-sm" aria-label="Lance máximo (teto privado)" />
                <button onClick={() => { const c = Math.round(Number(max.replace(",", ".")) * 100); if (c > 0) bid(c); setMax(""); }} className="w-16 h-[52px] rounded-2xl border border-borda text-sm font-semibold">Máx</button>
              </div>
            ) : next ? (
              /* Perdeu ou ganhou: emendar no próximo item do mesmo seller com pré-lance de um toque */
              <div className="flex gap-2">
                <button onClick={() => { const cents = Math.max(100, next.priceCents || 100); setPreBid(p => p?.listingId === next.id ? null : { listingId: next.id, cents }); }} className={`flex-1 h-[52px] rounded-2xl font-display font-bold text-[15px] ${preBid?.listingId === next.id ? "bg-carvao-3 text-menta border border-menta" : "bg-coral text-white"}`}>
                  {preBid?.listingId === next.id ? `Pré-lance armado · ${brl(preBid.cents)}` : `Pré-lance no próximo · ${brl(Math.max(100, next.priceCents || 100))}`}
                </button>
                <div className="w-20 h-[52px] rounded-2xl border border-borda text-xs text-apoio flex items-center justify-center text-center px-1">a seguir: {next.title.slice(0, 18)}</div>
              </div>
            ) : null}

            <p className="text-[11px] leading-[15px] text-apoio">
              {outcome?.kind === "lost_close" ? `Próximo item do mesmo seller: ${next?.title ?? "em instantes"}. Um toque deixa seu lance inicial pronto quando o timer começar.`
                : outcome?.kind === "won" ? "Pagamento num pedido só, ao fim do show. Arrependimento em 7 dias após a entrega."
                : "Lance vinculante. Pagamento automático no PIX ou cartão ao vencer. Arrependimento em 7 dias após a entrega."}
            </p>
          </>) : <div className="text-apoio text-sm py-3">Aguardando o seller iniciar um item…</div>}
          {toast && <div className={`text-sm rounded-xl px-3 py-2 bg-carvao-3 ${toast.tone === "menta" ? "text-menta" : toast.tone === "ambar" ? "text-ambar" : "text-texto-2"}`} role="status">{toast.text}</div>}
        </div>

        {/* Folha do primeiro lance: 3 linhas + limite opcional */}
        {firstBidSheet && (
          <div className="absolute inset-0 bg-black/70 flex items-end" role="dialog" aria-modal="true" aria-label="Seu primeiro lance">
            <div className="w-full bg-carvao-2 rounded-t-3xl p-5 pb-8 flex flex-col gap-3.5">
              <div className="w-10 h-1 rounded bg-borda self-center" />
              <div className="font-display font-bold text-xl">Seu primeiro lance</div>
              <ol className="flex flex-col gap-2.5 text-sm leading-5">
                <li className="flex gap-2.5"><span className="text-menta">1</span><span><b>Lance é compromisso.</b> Se ninguém cobrir, o item é seu.</span></li>
                <li className="flex gap-2.5"><span className="text-menta">2</span><span><b>Cobrança automática</b> no PIX ou cartão ao fim do show, num pedido só.</span></li>
                <li className="flex gap-2.5"><span className="text-menta">3</span><span><b>7 dias para desistir</b> depois de receber; o valor fica em custódia até lá.</span></li>
              </ol>
              <label className="flex items-center gap-3 px-3.5 py-3 rounded-2xl bg-carvao-3 border border-borda cursor-pointer">
                <span className="flex-1 text-[13px]"><b>Quer um limite mensal?</b><span className="block text-[11px] text-apoio">Opcional. Você escolhe o valor e muda quando quiser.</span></span>
                <input type="checkbox" checked={wantLimit} onChange={e => setWantLimit(e.target.checked)} className="w-5 h-5 accent-[#2BD9A0]" />
              </label>
              <button onClick={ackAndBid} className="h-[52px] rounded-2xl bg-coral text-white font-display font-bold text-[17px]">Entendi, dar lance {snap ? brl(snap.minNextBidCents) : ""}</button>
              <button onClick={() => setFirstBidSheet(false)} className="h-10 text-sm text-apoio">Agora não</button>
            </div>
          </div>
        )}
      </section>

      <aside className="flex flex-col h-[50vh] lg:h-screen border-l border-borda">
        <div className="p-3 border-b border-borda text-sm font-semibold flex items-center justify-between"><span>Chat</span><span className="text-xs text-apoio font-normal">{chat.length} mensagens</span></div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm">
          {chat.map((c, i) => <div key={i}><span className={`font-medium ${c.userId === "seller" ? "text-texto" : "text-menta"}`}>{c.userId}</span> <span className="text-texto">{c.text}</span></div>)}
        </div>
        <form className="p-3 border-t border-borda flex gap-2" onSubmit={e => { e.preventDefault(); const f = e.currentTarget.elements.namedItem("t") as HTMLInputElement; sendChat(f.value); f.value = ""; }}>
          <input name="t" placeholder={`Falar como ${userId}`} className="flex-1 rounded-xl bg-carvao-3 px-3 py-2 text-sm" maxLength={300} />
          <button className="bg-carvao-3 rounded-xl px-3 text-sm">Enviar</button>
        </form>
      </aside>
    </main>
  );
}

export default function ShowPage() {
  return <Suspense fallback={<main className="min-h-screen bg-carvao" />}><ShowPageInner /></Suspense>;
}

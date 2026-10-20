"use client";
/**
 * Página do show (comprador) — layout do canvas "App · Show ao vivo" aplicado.
 * Vídeo em tela cheia (placeholder até o LiveKit), topo com seller e AO VIVO, chat limitado a 4 linhas,
 * card de leilão único na base com anel de timer, lance rápido, Máx, microcopy de vínculo.
 * Folha do primeiro lance: explica compromisso, cobrança automática e 7 dias antes de permitir o primeiro lance.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { AuctionSnapshot, ServerMessage } from "@arrematto/contracts";
import { API, WS, brl } from "@/lib/api";

type Chat = { userId: string; text: string; at: number };
type ShowData = { title: string; status: string; startedAt?: string | null; listings: Array<{ id: string; title: string; priceCents: number; status: string; imageUrls: string[] }> };

function TimerRing({ remaining, total, status }: { remaining: number; total: number; status: AuctionSnapshot["status"] }) {
  const r = 28, c = 2 * Math.PI * r;
  const frac = status === "running" ? Math.max(0, Math.min(1, remaining / Math.max(total, 1))) : 0;
  const urgent = status === "running" && remaining <= 10_000;
  const label = status === "running" ? (remaining / 1000).toFixed(remaining < 10_000 ? 1 : 0) : status === "sold" ? "✓" : "—";
  return (
    <div className={`relative w-16 h-16 flex-none rounded-full ${urgent ? "pulse-coral" : ""}`} aria-label={`${Math.ceil(remaining / 1000)} segundos`}>
      <svg viewBox="0 0 64 64" className="w-16 h-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--carvao-3)" strokeWidth="4" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={urgent ? "var(--coral)" : "var(--texto)"} strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: "stroke-dashoffset 200ms linear" }} />
      </svg>
      <div className={`absolute inset-0 flex items-center justify-center font-display font-bold text-xl tabular ${urgent ? "text-coral" : status === "sold" ? "text-menta" : "text-texto"}`}>{label}</div>
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
  const [viewers, setViewers] = useState(0);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [max, setMax] = useState("");
  const [toast, setToast] = useState<{ text: string; tone: "menta" | "ambar" | "apoio" } | null>(null);
  const [show, setShow] = useState<ShowData | null>(null);
  const [firstBidSheet, setFirstBidSheet] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sessionSpentCents, setSessionSpentCents] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const lastListing = useRef<string | null>(null);

  useEffect(() => { try { setAcknowledged(localStorage.getItem("arrematto.firstBidAck") === "1"); } catch {} }, []);
  useEffect(() => { fetch(`${API}/shows/${id}`).then(r => r.json()).then(setShow).catch(() => {}); }, [id]);
  useEffect(() => {
    const sock = new WebSocket(WS); ws.current = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "join", showId: id, token: `user:${userId}` }));
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.type === "auction") {
        const s = m.snapshot; setSnap(s); setOffset(s.serverNow - Date.now());
        if (lastListing.current !== s.listingId) { lastListing.current = s.listingId; setTotal(Math.max(5_000, s.endsAt - s.serverNow)); }
        if (s.status === "sold" && s.leaderUserId === userId) { setSessionSpentCents(v => v + s.currentPriceCents); setToast({ text: `Arrematado por ${brl(s.currentPriceCents)} · vai para o seu pedido do show`, tone: "menta" }); }
      }
      else if (m.type === "chat") setChat(c => [...c.slice(-199), m]);
      else if (m.type === "viewers" || m.type === "joined") setViewers("viewers" in m ? m.viewers : m.count);
      else if (m.type === "bid_result") setToast(m.ok ? (m.youLead ? { text: "Você lidera", tone: "menta" } : { text: "Coberto: alguém tinha um teto maior", tone: "ambar" }) : { text: m.reason === "too_low" ? "Abaixo do mínimo" : m.reason === "ended" ? "O tempo acabou" : "Lance não aceito", tone: "apoio" });
      else if (m.type === "error") setToast({ text: m.message === "slow_down" ? "Calma no chat" : m.message, tone: "apoio" });
    };
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => { clearInterval(t); sock.close(); };
  }, [id, userId]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);

  const remaining = snap ? Math.max(0, snap.endsAt - (now + offset)) : 0;
  const running = snap?.status === "running" && remaining > 0;
  const current = useMemo(() => show?.listings.find(l => l.id === snap?.listingId), [show, snap]);
  const youLead = snap?.leaderUserId === userId;
  const sendBid = (cents: number) => ws.current?.send(JSON.stringify({ type: "bid", listingId: snap!.listingId, maxCents: cents, clientBidId: String(Date.now()) }));
  const bid = (cents: number) => { if (!acknowledged) { setFirstBidSheet(true); return; } sendBid(cents); };
  const ackAndBid = () => { try { localStorage.setItem("arrematto.firstBidAck", "1"); } catch {} setAcknowledged(true); setFirstBidSheet(false); if (snap) sendBid(snap.minNextBidCents); };
  const sendChat = (text: string) => text.trim() && ws.current?.send(JSON.stringify({ type: "chat", text: text.trim() }));
  const elapsed = show?.startedAt ? Math.max(0, now - new Date(show.startedAt).getTime()) : 0;
  const hhmm = (ms: number) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`; };

  return (
    <main className="min-h-screen bg-carvao text-texto grid grid-cols-1 lg:grid-cols-[1fr_380px]">
      <section className="relative aspect-[9/16] lg:aspect-auto lg:h-screen bg-black overflow-hidden">
        <div className="absolute inset-0 bg-[#1A1C22] flex items-center justify-center text-apoio text-sm">vídeo ao vivo · câmera do seller</div>

        <div className="absolute top-4 left-4 right-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#D9B38C]" />
          <div className="flex-1 min-w-0">
            <div className="font-display font-semibold text-sm leading-tight truncate">{show?.title ?? "…"}</div>
            <div className="text-xs text-texto-2">{show?.startedAt ? `no ar há ${hhmm(elapsed)}` : "agendado"}{sessionSpentCents > 0 && ` · você arrematou ${brl(sessionSpentCents)}`}</div>
          </div>
          <button className="h-8 px-3.5 rounded-full border border-texto text-sm font-semibold">Seguir</button>
          <div className="h-7 px-2.5 rounded-full bg-coral text-xs font-semibold flex items-center">AO VIVO · {viewers}</div>
        </div>

        <div className="absolute left-4 right-28 bottom-[270px] flex flex-col gap-2 text-[13px]">
          {chat.slice(-4).map((c, i) => (
            <div key={i} className="flex gap-1.5 items-baseline"><span className={`font-semibold ${c.userId === "seller" ? "text-texto" : "text-menta"}`}>{c.userId}</span><span className="text-texto">{c.text}</span></div>
          ))}
        </div>

        <div className="absolute left-3 right-3 bottom-6 bg-carvao-2 border border-borda rounded-3xl p-3.5 flex flex-col gap-3">
          {snap ? (<>
            <div className="flex gap-3 items-center">
              <div className="w-16 h-16 rounded-2xl bg-[#3A2F28] flex-none overflow-hidden">{current?.imageUrls?.[0] && <img src={current.imageUrls[0]} alt="" className="w-full h-full object-cover" />}</div>
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="text-[13px] text-texto-2 truncate">{current?.title ?? snap.listingId}</div>
                <div className="font-display font-bold text-[28px] leading-8 tabular">{brl(snap.currentPriceCents || snap.minNextBidCents)}</div>
                <div className={`text-xs font-semibold ${youLead ? "text-menta" : snap.leaderUserId ? "text-ambar" : "text-apoio"}`}>
                  {snap.status === "sold" ? (youLead ? "você arrematou" : `arrematado por ${snap.leaderUserId}`) : snap.status === "unsold" ? "sem lances" : youLead ? "você lidera" : snap.leaderUserId ? `${snap.leaderUserId} lidera` : "sem lances ainda"} · {snap.bidCount} lances
                </div>
              </div>
              <TimerRing remaining={remaining} total={total} status={snap.status} />
            </div>
            {running && (
              <div className="flex gap-2">
                <button onClick={() => bid(snap.minNextBidCents)} className="flex-1 h-[52px] rounded-2xl bg-coral text-white font-display font-bold text-[17px] active:scale-[0.98]">Dar lance {brl(snap.minNextBidCents)}</button>
                <input value={max} onChange={e => setMax(e.target.value)} placeholder="R$" inputMode="decimal" className="w-20 rounded-2xl bg-carvao-3 px-3 text-center text-sm" aria-label="Lance máximo" />
                <button onClick={() => { const c = Math.round(Number(max.replace(",", ".")) * 100); if (c > 0) bid(c); setMax(""); }} className="w-16 h-[52px] rounded-2xl border border-borda text-sm font-semibold">Máx</button>
              </div>
            )}
            <p className="text-[11px] leading-[15px] text-apoio">Lance vinculante. Pagamento automático no PIX ou cartão ao vencer. Arrependimento em 7 dias após a entrega.</p>
          </>) : <div className="text-apoio text-sm py-3">Aguardando o seller iniciar um item…</div>}
          {toast && <div className={`text-sm rounded-xl px-3 py-2 bg-carvao-3 ${toast.tone === "menta" ? "text-menta" : toast.tone === "ambar" ? "text-ambar" : "text-texto-2"}`}>{toast.text}</div>}
        </div>

        {firstBidSheet && (
          <div className="absolute inset-0 bg-black/60 flex items-end" role="dialog" aria-modal="true" aria-label="Antes do seu primeiro lance">
            <div className="w-full bg-papel text-tinta rounded-t-3xl p-6 flex flex-col gap-4">
              <div className="font-display font-bold text-lg">Antes do seu primeiro lance</div>
              <ol className="list-decimal pl-5 text-sm leading-6 text-[#3B4150]">
                <li>Lance é compromisso: se você vencer, a compra é sua.</li>
                <li>A cobrança é automática no PIX ou cartão ao fim do show, num pedido só com tudo que você arrematou.</li>
                <li>Você pode desistir em até 7 dias após receber. O valor fica em custódia até lá.</li>
              </ol>
              <div className="flex gap-2">
                <button onClick={() => setFirstBidSheet(false)} className="flex-1 h-12 rounded-2xl border border-[#D5D8DE] font-semibold text-sm">Agora não</button>
                <button onClick={ackAndBid} className="flex-1 h-12 rounded-2xl bg-tinta text-white font-display font-bold text-sm">Entendi, dar lance</button>
              </div>
            </div>
          </div>
        )}
      </section>

      <aside className="flex flex-col h-[50vh] lg:h-screen border-l border-borda">
        <div className="p-3 border-b border-borda text-sm font-semibold">Chat</div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm">
          {chat.map((c, i) => <div key={i}><span className="text-menta font-medium">{c.userId}</span> <span className="text-texto">{c.text}</span></div>)}
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

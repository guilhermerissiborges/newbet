"use client";
/**
 * Página do show (comprador): vídeo (placeholder até o LiveKit entrar na semana 3), leilão ao vivo com timer
 * sincronizado pelo relógio do servidor, lance rápido e Max Bid, chat. Conecta direto ao serviço realtime.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import type { AuctionSnapshot, ServerMessage } from "@arrematto/contracts";
import { API, WS, brl } from "@/lib/api";

type Chat = { userId: string; text: string; at: number };

function ShowPageInner() {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const userId = q.get("user") ?? "visitante";
  const [snap, setSnap] = useState<AuctionSnapshot | null>(null);
  const [chat, setChat] = useState<Chat[]>([]);
  const [viewers, setViewers] = useState(0);
  const [offset, setOffset] = useState(0); // serverNow - Date.now()
  const [now, setNow] = useState(Date.now());
  const [max, setMax] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [show, setShow] = useState<{ title: string; listings: Array<{ id: string; title: string; priceCents: number; status: string; imageUrls: string[] }> } | null>(null);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => { fetch(`${API}/shows/${id}`).then(r => r.json()).then(setShow).catch(() => {}); }, [id]);
  useEffect(() => {
    const sock = new WebSocket(WS); ws.current = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "join", showId: id, token: `user:${userId}` }));
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      if (m.type === "auction") { setSnap(m.snapshot); setOffset(m.snapshot.serverNow - Date.now()); }
      else if (m.type === "chat") setChat(c => [...c.slice(-199), m]);
      else if (m.type === "viewers" || m.type === "joined") setViewers("viewers" in m ? m.viewers : m.count);
      else if (m.type === "bid_result") setToast(m.ok ? (m.youLead ? "Você está liderando" : "Lance aceito, mas alguém cobriu") : `Lance recusado: ${m.reason}`);
      else if (m.type === "error") setToast(m.message);
    };
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => { clearInterval(t); sock.close(); };
  }, [id, userId]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 2500); return () => clearTimeout(t); }, [toast]);

  const remaining = snap ? Math.max(0, snap.endsAt - (now + offset)) : 0;
  const running = snap?.status === "running" && remaining > 0;
  const current = useMemo(() => show?.listings.find(l => l.id === snap?.listingId), [show, snap]);
  const bid = (cents: number) => ws.current?.send(JSON.stringify({ type: "bid", listingId: snap!.listingId, maxCents: cents, clientBidId: String(Date.now()) }));
  const sendChat = (text: string) => text.trim() && ws.current?.send(JSON.stringify({ type: "chat", text: text.trim() }));

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 grid grid-cols-1 lg:grid-cols-[1fr_380px]">
      <section className="relative aspect-[9/16] lg:aspect-auto lg:h-screen bg-black flex items-end">
        <div className="absolute inset-0 flex items-center justify-center text-neutral-600 text-sm">vídeo ao vivo (LiveKit — semana 3)</div>
        <div className="absolute top-3 left-3 flex gap-2 text-xs">
          <span className="bg-red-600 px-2 py-0.5 rounded font-semibold">AO VIVO</span>
          <span className="bg-black/60 px-2 py-0.5 rounded">{viewers} assistindo</span>
        </div>
        <div className="relative w-full p-4 bg-gradient-to-t from-black/90 to-transparent">
          <h1 className="text-sm text-neutral-300 mb-2">{show?.title ?? "…"}</h1>
          {snap ? (
            <div className="rounded-2xl bg-neutral-900/90 border border-neutral-800 p-4">
              <div className="flex gap-3">
                {current?.imageUrls?.[0] && <img src={current.imageUrls[0]} alt="" className="w-16 h-16 rounded-lg object-cover" />}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{current?.title ?? snap.listingId}</div>
                  <div className="text-2xl font-bold">{brl(snap.currentPriceCents || snap.minNextBidCents)}</div>
                  <div className="text-xs text-neutral-400">{snap.leaderUserId ? (snap.leaderUserId === userId ? "você lidera" : `${snap.leaderUserId} lidera`) : "sem lances"} · {snap.bidCount} lances</div>
                </div>
                <div className={`text-3xl font-mono tabular-nums ${remaining < 10_000 ? "text-red-400" : ""}`}>{running ? (remaining / 1000).toFixed(1) : snap.status === "sold" ? "vendido" : snap.status === "unsold" ? "sem lance" : "0.0"}</div>
              </div>
              {running && (
                <div className="mt-3 flex gap-2">
                  <button onClick={() => bid(snap.minNextBidCents)} className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-xl py-3 text-lg">Dar lance {brl(snap.minNextBidCents)}</button>
                  <input value={max} onChange={e => setMax(e.target.value)} placeholder="Máx R$" inputMode="decimal" className="w-24 rounded-xl bg-neutral-800 px-3 text-center" />
                  <button onClick={() => { const c = Math.round(Number(max.replace(",", ".")) * 100); if (c > 0) bid(c); setMax(""); }} className="bg-neutral-700 hover:bg-neutral-600 rounded-xl px-3 text-sm">Max Bid</button>
                </div>
              )}
              <p className="mt-2 text-[11px] text-neutral-500">Lance é vinculante: ao vencer, a cobrança é automática no método padrão. Arrependimento em 7 dias após a entrega.</p>
            </div>
          ) : <div className="text-neutral-400 text-sm">Aguardando o seller iniciar um item…</div>}
          {toast && <div className="mt-2 text-sm bg-neutral-800 rounded-lg px-3 py-2 inline-block">{toast}</div>}
        </div>
      </section>
      <aside className="flex flex-col h-[50vh] lg:h-screen border-l border-neutral-800">
        <div className="p-3 border-b border-neutral-800 text-sm font-semibold">Chat</div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm">
          {chat.map((c, i) => <div key={i}><span className="text-emerald-400 font-medium">{c.userId}</span> <span className="text-neutral-200">{c.text}</span></div>)}
        </div>
        <form className="p-3 border-t border-neutral-800 flex gap-2" onSubmit={e => { e.preventDefault(); const f = e.currentTarget.elements.namedItem("t") as HTMLInputElement; sendChat(f.value); f.value = ""; }}>
          <input name="t" placeholder={`Falar como ${userId}`} className="flex-1 rounded-lg bg-neutral-800 px-3 py-2 text-sm" maxLength={300} />
          <button className="bg-neutral-700 rounded-lg px-3 text-sm">Enviar</button>
        </form>
      </aside>
    </main>
  );
}

export default function ShowPage() {
  return <Suspense fallback={<main className="min-h-screen bg-neutral-950" />}><ShowPageInner /></Suspense>;
}

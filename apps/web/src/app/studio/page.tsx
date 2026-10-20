"use client";
/**
 * Seller Studio v0: escolher o show, iniciar, rodar itens (leilão de 30 s padrão ou Sudden Death),
 * acompanhar o leilão em tempo real, encerrar o show (gera pedidos e cobranças) e ver o saldo.
 * Auth stub: o id do seller vem de ?user=; na semana 2 vira sessão do Supabase.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AuctionSnapshot, ServerMessage } from "@arrematto/contracts";
import { API, WS, api, brl } from "@/lib/api";

type Listing = { id: string; title: string; type: string; priceCents: number; status: string; weightGrams: number };
type Show = { id: string; title: string; status: string; scheduledAt: string; listings?: Listing[] };

function StudioInner() {
  const q = useSearchParams(); const userId = q.get("user") ?? "";
  const [shows, setShows] = useState<Show[]>([]); const [show, setShow] = useState<Show | null>(null);
  const [snap, setSnap] = useState<AuctionSnapshot | null>(null); const [viewers, setViewers] = useState(0);
  const [mode, setMode] = useState<"standard" | "sudden_death">("standard"); const [duration, setDuration] = useState(30);
  const [balance, setBalance] = useState<{ availableCents: number; processingCents: number } | null>(null);
  const [log, setLog] = useState<string[]>([]); const ws = useRef<WebSocket | null>(null);
  const say = (m: string) => setLog(l => [`${new Date().toLocaleTimeString()} ${m}`, ...l.slice(0, 49)]);

  const refresh = async () => { setShows(await api<Show[]>("/shows")); if (userId) api<typeof balance>("/sellers/me/balance", { userId }).then(setBalance).catch(() => {}); };
  useEffect(() => { refresh(); }, [userId]);
  const open = async (id: string) => {
    setShow(await api<Show>(`/shows/${id}`));
    ws.current?.close(); const sock = new WebSocket(WS); ws.current = sock;
    sock.onopen = () => sock.send(JSON.stringify({ type: "join", showId: id, token: `user:${userId || "studio"}` }));
    sock.onmessage = (e) => { const m = JSON.parse(e.data) as ServerMessage; if (m.type === "auction") { setSnap(m.snapshot); if (m.snapshot.status !== "running") { say(`item ${m.snapshot.listingId.slice(-6)}: ${m.snapshot.status} por ${brl(m.snapshot.currentPriceCents)}`); setTimeout(() => open(id), 400); } } else if (m.type === "viewers" || m.type === "joined") setViewers("viewers" in m ? m.viewers : m.count); };
  };
  const start = async () => { if (!show) return; await api(`/shows/${show.id}/start`, { method: "POST", userId }); say("show ao vivo"); open(show.id); };
  const run = async (l: Listing) => { if (!show) return; await api(`/shows/${show.id}/auction/start`, { method: "POST", userId, body: JSON.stringify({ listingId: l.id, durationMs: duration * 1000, mode }) }); say(`rodando: ${l.title}`); };
  const close = async () => { if (!show) return; const r = await api<{ orders: string[] }>(`/shows/${show.id}/close`, { method: "POST", userId, body: JSON.stringify({ originZip: "88130000" }) }); say(`show encerrado: ${r.orders.length} pedido(s) gerado(s), cobranças PIX enviadas`); refresh(); open(show.id); };

  if (!userId) return <main className="p-8 text-texto bg-carvao min-h-screen">Abra com <code>?user=&lt;id do seller&gt;</code> (o seed imprime o id).</main>;
  return (
    <main className="min-h-screen bg-carvao text-texto p-6 grid gap-6 lg:grid-cols-[300px_1fr_320px]">
      <section>
        <h1 className="font-display font-bold text-lg mb-3">Arrematto <span className="font-sans font-normal text-apoio text-sm">Seller Studio</span></h1>
        {balance && <div className="mb-4 rounded-xl border border-borda p-3 text-sm"><div>Disponível <b>{brl(balance.availableCents)}</b></div><div className="text-apoio">Em escrow {brl(balance.processingCents)}</div></div>}
        <div className="text-xs text-apoio mb-2">Shows</div>
        <ul className="space-y-1">{shows.map(s => <li key={s.id}><button onClick={() => open(s.id)} className={`w-full text-left rounded-lg px-3 py-2 text-sm ${show?.id === s.id ? "bg-carvao-3" : "hover:bg-carvao-2"}`}>{s.title}<div className="text-xs text-apoio">{s.status} · {new Date(s.scheduledAt).toLocaleString("pt-BR")}</div></button></li>)}</ul>
      </section>
      <section>
        {show ? (<>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="font-semibold text-lg flex-1">{show.title} <span className="text-xs text-apoio ml-2">{show.status} · {viewers} assistindo</span></h2>
            {show.status !== "LIVE" && <button onClick={start} className="bg-coral rounded-lg px-4 py-2 font-semibold">Ir ao vivo</button>}
            {show.status === "LIVE" && <button onClick={close} className="bg-carvao-3 rounded-lg px-4 py-2">Encerrar e gerar pedidos</button>}
          </div>
          <div className="rounded-xl border border-borda p-4 mb-4 flex items-center gap-4">
            <div className="flex-1">{snap && snap.status === "running" ? <><div className="text-xs text-apoio">No ar</div><div className="font-display text-xl font-bold tabular">{brl(snap.currentPriceCents || snap.minNextBidCents)} · {snap.bidCount} lances · {snap.leaderUserId ?? "sem líder"}</div></> : <div className="text-apoio text-sm">Nenhum item rodando</div>}</div>
            <label className="text-xs text-apoio">Duração <input type="number" value={duration} min={5} max={600} onChange={e => setDuration(Number(e.target.value))} className="w-16 ml-1 bg-carvao-3 rounded px-2 py-1 text-texto" /> s</label>
            <label className="text-xs text-apoio"><select value={mode} onChange={e => setMode(e.target.value as typeof mode)} className="bg-carvao-3 rounded px-2 py-1 text-texto"><option value="standard">Padrão (reseta nos 10 s finais)</option><option value="sudden_death">Sudden Death</option></select></label>
          </div>
          <table className="w-full text-sm"><thead className="text-apoio text-left"><tr><th className="py-1">Item</th><th>Tipo</th><th>Preço</th><th>Peso</th><th>Status</th><th></th></tr></thead>
            <tbody>{show.listings?.map(l => <tr key={l.id} className="border-t border-borda"><td className="py-2 pr-2 max-w-[360px] truncate">{l.title}</td><td>{l.type === "AUCTION" ? "leilão" : "BIN"}</td><td>{brl(l.priceCents)}</td><td>{l.weightGrams} g</td><td className="text-apoio">{l.status}</td>
              <td className="text-right">{l.type === "AUCTION" && l.status === "ACTIVE" && show.status === "LIVE" && <button onClick={() => run(l)} className="bg-coral text-white rounded-lg px-3 py-1 font-display font-semibold">Rodar</button>}</td></tr>)}</tbody></table>
        </>) : <div className="text-apoio">Escolha um show.</div>}
      </section>
      <aside className="rounded-xl border border-borda p-3 text-xs font-mono text-texto-2 h-fit"><div className="text-apoio mb-2">Atividade</div>{log.map((l, i) => <div key={i}>{l}</div>)}</aside>
    </main>
  );
}

export default function Studio() {
  return <Suspense fallback={<main className="min-h-screen bg-carvao" />}><StudioInner /></Suspense>;
}

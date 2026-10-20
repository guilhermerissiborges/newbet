import Link from "next/link";
import { connection } from "next/server";
import { API } from "@/lib/api";

type Show = { id: string; title: string; status: string; scheduledAt: string; category: string };

export default async function Home() {
  await connection(); // sempre dinâmico: a lista de shows muda a cada minuto
  let shows: Show[] = [];
  try { shows = await (await fetch(`${API}/shows`, { cache: "no-store" })).json(); } catch { /* API fora do ar */ }
  return (
    <main className="min-h-screen bg-carvao text-texto p-6">
      <header className="flex items-center justify-between mb-8">
        <h1 className="font-display text-2xl font-bold tracking-tight">Arrematto</h1>
        <Link href="/studio" className="text-sm text-apoio hover:text-texto">Seller Studio</Link>
      </header>
      <h2 className="text-sm text-apoio mb-3">Ao vivo e agendados</h2>
      {shows.length === 0 && <p className="text-apoio text-sm">Nenhum show. Suba a API e rode o seed.</p>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {shows.map(s => (
          <li key={s.id}><Link href={`/show/${s.id}`} className="block rounded-2xl border border-borda bg-carvao-2 p-4 hover:border-apoio">
            <div className="text-xs mb-2">{s.status === "LIVE" ? <span className="bg-coral px-2 py-0.5 rounded-full font-semibold">AO VIVO</span> : <span className="text-apoio">{new Date(s.scheduledAt).toLocaleString("pt-BR")}</span>}</div>
            <div className="font-semibold">{s.title}</div><div className="text-xs text-apoio">{s.category}</div>
          </Link></li>
        ))}
      </ul>
    </main>
  );
}

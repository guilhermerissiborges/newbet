// E2E: dois compradores disputam; o que perde por pouco vê "ficou por" e arma pré-lance no próximo item.
// Valida bidderCount, reaction e o fluxo de pré-lance (cliente envia o lance assim que o próximo item roda).
import { createRequire } from "node:module"; const WebSocket = createRequire(new URL("../apps/realtime/package.json", import.meta.url))("ws");
const API = "http://localhost:8080", WS_URL = "ws://localhost:8081";
const j = async (path, body, user) => { const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(user ? { "x-user-id": user } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(path + " " + r.status + " " + t); return t ? JSON.parse(t) : {}; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const seller = await j("/users", { email: `s${Date.now()}@x.com`, name: "Seller E2E" });
await j("/sellers", { legalName: "Make Beauty Pro Ltda", taxId: String(Date.now()).padStart(14, "9").slice(-14), anvisaCompliant: true }, seller.id);
const show = await j("/shows", { title: "E2E ficou por", category: "beauty.hair", scheduledAt: new Date().toISOString() }, seller.id);
await j(`/shows/${show.id}/start`, {}, seller.id);
const mk = (title, price) => j(`/shows/${show.id}/listings`, { type: "AUCTION", title, category: "beauty.hair", priceCents: price, weightGrams: 1000, anvisaProcess: "25351.000000/2026-00" }, seller.id);
const l1 = await mk("Grace Unique 1 L", 10000);
const l2 = await mk("Grace Violet 100 ml", 4000);

const open = (user) => new Promise(res => { const ws = new WebSocket(WS_URL); const msgs = []; ws.on("message", d => msgs.push(JSON.parse(d))); ws.on("open", () => { ws.send(JSON.stringify({ type: "join", showId: show.id, token: `user:${user}` })); res({ ws, msgs }); }); });
const a = await open("ana"), b = await open("bia");
const bid = (c, listingId, max) => c.ws.send(JSON.stringify({ type: "bid", listingId, maxCents: max, clientBidId: String(Math.random()) }));

await j(`/shows/${show.id}/auction/start`, { listingId: l1.id, durationMs: 6000 }, seller.id);
await sleep(600);
bid(a, l1.id, 10000); await sleep(150);
bid(b, l1.id, 12000); await sleep(150);          // bia cobre
a.ws.send(JSON.stringify({ type: "reaction", kind: "heart" }));
await sleep(300);
const snapA = [...a.msgs].reverse().find(m => m.type === "auction").snapshot;
console.log("snapshot:", { price: snapA.currentPriceCents, leader: snapA.leaderUserId, bidCount: snapA.bidCount, bidderCount: snapA.bidderCount });
console.log("reaction recebida pela bia:", b.msgs.some(m => m.type === "reaction" && m.userId === "ana"));

// espera fechar → ana perdeu por pouco (seu teto 10000 vs preço 10200)
await sleep(10000); // lances nos 10 s finais resetam o timer para 8 s
const closed = [...a.msgs].reverse().find(m => m.type === "auction" && m.snapshot.status !== "running").snapshot;
const anaMax = 10000, diff = closed.currentPriceCents - anaMax;
console.log("fechou:", { status: closed.status, winner: closed.leaderUserId, price: closed.currentPriceCents, ficouPor: diff });

// ana "arma pré-lance" no próximo: o cliente envia o lance assim que o item rodar (mesma lógica da página)
let armed = { listingId: l2.id, cents: 4200 };
a.ws.on("message", d => { const m = JSON.parse(d); if (armed && m.type === "auction" && m.snapshot.listingId === armed.listingId && m.snapshot.status === "running") { bid(a, armed.listingId, Math.max(armed.cents, m.snapshot.minNextBidCents)); armed = null; } });
await j(`/shows/${show.id}/auction/start`, { listingId: l2.id, durationMs: 5000 }, seller.id);
await sleep(800);
const s2 = [...a.msgs].reverse().find(m => m.type === "auction" && m.snapshot.listingId === l2.id).snapshot;
console.log("pré-lance entrou:", { listing: l2.title, leader: s2.leaderUserId, price: s2.currentPriceCents, bidderCount: s2.bidderCount });
const ok = snapA.bidderCount === 2 && diff > 0 && s2.leaderUserId === "ana";
console.log(ok ? "E2E OK" : "E2E FALHOU");
a.ws.close(); b.ws.close(); process.exit(ok ? 0 : 1);

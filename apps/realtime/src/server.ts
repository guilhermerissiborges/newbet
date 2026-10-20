/**
 * Serviço realtime: salas de show (WebSocket), leilão via AuctionEngine (Redis + Lua), chat com rate limit,
 * presença por sala. Horizontalmente escalável: cada nó serve conexões; o estado vive no Redis; broadcast entre nós
 * via pub/sub `show:{id}`.
 *
 * Auth: no MVP o token é um JWT do Supabase Auth; aqui a verificação é um stub (verifyToken) para o tech lead trocar.
 */
import { WebSocketServer, WebSocket } from "ws";
import { Redis } from "ioredis";
import { ClientMessage, type ServerMessage } from "@arrematto/contracts";
import { AuctionEngine } from "./engine.js";
import { DEFAULT_CONFIG } from "@arrematto/domain";

const PORT = Number(process.env.PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const CHAT_RATE = { perSec: 2, burst: 5 }; // por usuário por sala
const MAX_PRESENCE_TRACKED = 50; // acima disso só contamos, não listamos (como o Whatnot)

const redis = new Redis(REDIS_URL);
const sub = new Redis(REDIS_URL);
const engine = new AuctionEngine(redis);

interface Conn { ws: WebSocket; userId: string; showId: string; chatTokens: number; chatRefill: number }
const rooms = new Map<string, Set<Conn>>();

function send(ws: WebSocket, m: ServerMessage) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }
function broadcastLocal(showId: string, m: ServerMessage) { for (const c of rooms.get(showId) ?? []) send(c.ws, m); }
async function broadcast(showId: string, m: ServerMessage) { await redis.publish(`show:${showId}`, JSON.stringify(m)); }

sub.psubscribe("show:*");
sub.on("pmessage", (_p: string, channel: string, msg: string) => broadcastLocal(channel.slice(5), JSON.parse(msg)));

/** Stub: trocar por verificação de JWT (Supabase) — retorna userId. */
function verifyToken(token: string): string | null { return token.startsWith("user:") ? token.slice(5) : null; }

async function presenceJoin(showId: string, userId: string) {
  await redis.sadd(`presence:${showId}`, userId);
  return redis.scard(`presence:${showId}`);
}
async function presenceLeave(showId: string, userId: string) {
  await redis.srem(`presence:${showId}`, userId);
  return redis.scard(`presence:${showId}`);
}

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  let conn: Conn | null = null;
  ws.on("message", async (raw) => {
    const parsed = ClientMessage.safeParse(JSON.parse(String(raw)));
    if (!parsed.success) return send(ws, { type: "error", message: "bad_message" });
    const m = parsed.data;
    const now = Date.now();
    try {
      if (m.type === "join") {
        const userId = verifyToken(m.token);
        if (!userId) return send(ws, { type: "error", message: "unauthorized" });
        conn = { ws, userId, showId: m.showId, chatTokens: CHAT_RATE.burst, chatRefill: now };
        if (!rooms.has(m.showId)) rooms.set(m.showId, new Set());
        rooms.get(m.showId)!.add(conn);
        const viewers = await presenceJoin(m.showId, userId);
        send(ws, { type: "joined", showId: m.showId, userId, viewers });
        if (viewers <= MAX_PRESENCE_TRACKED) await broadcast(m.showId, { type: "viewers", count: viewers });
        const current = await redis.get(`show:${m.showId}:currentListing`);
        if (current) { const snap = await engine.snapshot(current, now); if (snap) send(ws, { type: "auction", snapshot: snap }); }
        return;
      }
      if (!conn) return send(ws, { type: "error", message: "join_first" });
      if (m.type === "ping") return send(ws, { type: "pong", serverNow: now });
      if (m.type === "bid") {
        const r = await engine.bid(m.listingId, conn.userId, m.maxCents, now);
        send(ws, { type: "bid_result", clientBidId: m.clientBidId, ok: r.ok, reason: r.reason, youLead: r.ok ? r.leaderUserId === conn.userId : undefined });
        if (r.ok) { const snap = await engine.snapshot(m.listingId, now); if (snap) await broadcast(conn.showId, { type: "auction", snapshot: snap }); }
        return;
      }
      if (m.type === "chat") {
        // token bucket: protege o caminho do lance de enxurradas de chat
        const elapsed = (now - conn.chatRefill) / 1000;
        conn.chatTokens = Math.min(CHAT_RATE.burst, conn.chatTokens + elapsed * CHAT_RATE.perSec); conn.chatRefill = now;
        if (conn.chatTokens < 1) return send(ws, { type: "error", message: "slow_down" });
        conn.chatTokens -= 1;
        await broadcast(conn.showId, { type: "chat", userId: conn.userId, text: m.text, at: now });
      }
    } catch (e) {
      send(ws, { type: "error", message: "internal" });
      console.error(e);
    }
  });
  ws.on("close", async () => {
    if (!conn) return;
    rooms.get(conn.showId)?.delete(conn);
    const viewers = await presenceLeave(conn.showId, conn.userId);
    if (viewers <= MAX_PRESENCE_TRACKED) await broadcast(conn.showId, { type: "viewers", count: viewers });
  });
});

/** Relógio do leilão: a cada 250 ms fecha leilões vencidos e publica snapshot/evento. Em produção, um líder eleito por lock. */
setInterval(async () => {
  const now = Date.now();
  const listings = await redis.smembers("auctions:running");
  for (const listingId of listings) {
    const ev = await engine.closeIfEnded(listingId, now);
    const snap = await engine.snapshot(listingId, now);
    if (snap && snap.status === "running") { await broadcast(ev?.showId ?? (await redis.hget(`auction:${listingId}`, "showId")) ?? "", { type: "auction", snapshot: snap }); continue; }
    if (ev) { await broadcast(ev.showId, { type: "auction", snapshot: snap! }); await redis.srem("auctions:running", listingId); }
  }
}, 250);

/** Endpoint interno para a API iniciar um leilão (no MVP, via Redis: a API faz XADD em `commands:auction`). */
sub.subscribe("commands:auction");
sub.on("message", async (channel: string, msg: string) => {
  if (channel !== "commands:auction") return;
  const c = JSON.parse(msg) as { type: "start"; showId: string; listingId: string; startingBidCents: number; durationMs?: number; mode?: "standard" | "sudden_death" };
  if (c.type === "start") {
    const snap = await engine.start(c.showId, c.listingId, { ...DEFAULT_CONFIG, startingBidCents: c.startingBidCents, durationMs: c.durationMs ?? DEFAULT_CONFIG.durationMs, mode: c.mode ?? "standard" }, Date.now());
    await redis.sadd("auctions:running", c.listingId);
    await redis.set(`show:${c.showId}:currentListing`, c.listingId);
    await broadcast(c.showId, { type: "auction", snapshot: snap });
  }
});

console.log(`realtime on ws://0.0.0.0:${PORT}`);

import { z } from "zod";

/** Mensagens cliente → realtime */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), showId: z.string(), token: z.string() }),
  z.object({ type: z.literal("bid"), listingId: z.string(), maxCents: z.number().int().positive(), clientBidId: z.string() }),
  z.object({ type: z.literal("chat"), text: z.string().min(1).max(300) }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Mensagens realtime → cliente */
export const AuctionSnapshot = z.object({
  listingId: z.string(),
  status: z.enum(["running", "sold", "unsold"]),
  currentPriceCents: z.number(),
  leaderUserId: z.string().nullable(),
  minNextBidCents: z.number(),
  endsAt: z.number(),
  bidCount: z.number(),
  serverNow: z.number(),
});
export type AuctionSnapshot = z.infer<typeof AuctionSnapshot>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("joined"), showId: z.string(), userId: z.string(), viewers: z.number() }),
  z.object({ type: z.literal("auction"), snapshot: AuctionSnapshot }),
  z.object({ type: z.literal("bid_result"), clientBidId: z.string(), ok: z.boolean(), reason: z.string().optional(), youLead: z.boolean().optional() }),
  z.object({ type: z.literal("chat"), userId: z.string(), text: z.string(), at: z.number() }),
  z.object({ type: z.literal("viewers"), count: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("pong"), serverNow: z.number() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Eventos realtime → API (Redis Stream `events:auction`) */
export const AuctionClosedEvent = z.object({
  type: z.literal("auction.closed"),
  showId: z.string(),
  listingId: z.string(),
  status: z.enum(["sold", "unsold"]),
  winnerUserId: z.string().nullable(),
  priceCents: z.number(),
  bidCount: z.number(),
  closedAt: z.number(),
});
export type AuctionClosedEvent = z.infer<typeof AuctionClosedEvent>;

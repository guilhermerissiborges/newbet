/**
 * Arrematto — modelo de dados do MVP (Drizzle ORM, Postgres). Centavos inteiros; timestamps em UTC.
 * Regras de negócio (taxas, escrow, bundling, leilão) vivem em packages/domain; aqui só persistência.
 * Decisão: Drizzle em vez de Prisma porque não depende de binários (CI e sandbox mais simples) e é SQL puro.
 */
import { pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";

const id = () => text("id").primaryKey().$defaultFn(() => createId());
const now = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const country = pgEnum("country", ["BR", "MX"]);
export const userRole = pgEnum("user_role", ["BUYER", "SELLER", "ADMIN"]);
export const kycStatus = pgEnum("kyc_status", ["PENDING", "APPROVED", "REJECTED"]);
export const showStatus = pgEnum("show_status", ["SCHEDULED", "LIVE", "ENDED", "CANCELLED"]);
export const listingType = pgEnum("listing_type", ["AUCTION", "BUY_IT_NOW"]);
export const listingStatus = pgEnum("listing_status", ["DRAFT", "ACTIVE", "RUNNING", "SOLD", "UNSOLD", "ARCHIVED"]);
export const orderStatus = pgEnum("order_status", ["PENDING_PAYMENT", "PAID", "CANCELLED", "SHIPPED", "DELIVERED", "RETURN_REQUESTED", "REFUNDED", "COMPLETED"]);
export const paymentMethod = pgEnum("payment_method", ["PIX", "CARD"]);
export const paymentStatus = pgEnum("payment_status", ["PENDING", "AUTHORIZED", "PAID", "FAILED", "REFUNDED"]);
export const shipmentStatus = pgEnum("shipment_status", ["LABEL_CREATED", "SCANNED", "IN_TRANSIT", "DELIVERED", "LOST"]);
export const ledgerType = pgEnum("ledger_type", ["ITEM", "SHIPPING", "COMMISSION", "SERVICE_FEE", "CANCELLATION_FEE", "REFUND", "PAYOUT", "ADJUSTMENT"]);

export const users = pgTable("users", {
  id: id(),
  authId: text("auth_id").notNull().unique(), // id no Supabase Auth
  email: text("email").notNull().unique(),
  phone: text("phone"),
  name: text("name").notNull(),
  role: userRole("role").notNull().default("BUYER"),
  country: country("country").notNull().default("BR"),
  spendLimitCents: integer("spend_limit_cents"), // Account Controls
  createdAt: now("created_at"),
});

export const addresses = pgTable("addresses", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id),
  label: text("label").notNull().default("casa"),
  street: text("street").notNull(),
  number: text("number").notNull(),
  complement: text("complement"),
  district: text("district").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  zip: text("zip").notNull(),
  country: country("country").notNull().default("BR"),
  isDefault: boolean("is_default").notNull().default(false),
});

export const sellerProfiles = pgTable("seller_profiles", {
  id: id(),
  userId: text("user_id").notNull().unique().references(() => users.id),
  legalName: text("legal_name").notNull(),
  taxId: text("tax_id").notNull().unique(), // CNPJ ou RFC
  kycStatus: kycStatus("kyc_status").notNull().default("PENDING"),
  kycProvider: text("kyc_provider"),
  kycRef: text("kyc_ref"),
  originAddressId: text("origin_address_id"),
  onTimeScanRate: real("on_time_scan_rate").notNull().default(1),
  cancellationFreeRate: real("cancellation_free_rate").notNull().default(1),
  refundFreeRate: real("refund_free_rate").notNull().default(1),
  sales28dCents: integer("sales_28d_cents").notNull().default(0),
  priorCancellations: integer("prior_cancellations").notNull().default(0),
  payoutAccountRef: text("payout_account_ref"), // recebedor no Pagar.me/Asaas
  anvisaCompliant: boolean("anvisa_compliant").notNull().default(false),
  createdAt: now("created_at"),
});

export const shows = pgTable("shows", {
  id: id(),
  sellerId: text("seller_id").notNull().references(() => sellerProfiles.id),
  title: text("title").notNull(),
  category: text("category").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  status: showStatus("status").notNull().default("SCHEDULED"),
  isPrivate: boolean("is_private").notNull().default(false),
  livekitRoom: text("livekit_room"),
  thumbnailUrl: text("thumbnail_url"),
  createdAt: now("created_at"),
}, t => [index("shows_seller_idx").on(t.sellerId, t.scheduledAt)]);

export const listings = pgTable("listings", {
  id: id(),
  sellerId: text("seller_id").notNull().references(() => sellerProfiles.id),
  showId: text("show_id").references(() => shows.id),
  type: listingType("type").notNull(),
  status: listingStatus("status").notNull().default("DRAFT"),
  title: text("title").notNull(),
  description: text("description"),
  sku: text("sku"),
  category: text("category").notNull(),
  priceCents: integer("price_cents").notNull(), // BIN: preço; AUCTION: lance inicial
  quantity: integer("quantity").notNull().default(1),
  weightGrams: integer("weight_grams").notNull(),
  anvisaProcess: text("anvisa_process"),
  imageUrls: jsonb("image_urls").$type<string[]>().notNull().default([]),
  offerable: boolean("offerable").notNull().default(true),
  auctionSnapshot: jsonb("auction_snapshot").$type<Record<string, unknown>>(),
  createdAt: now("created_at"),
}, t => [index("listings_show_idx").on(t.showId, t.status)]);

export const bids = pgTable("bids", {
  id: id(),
  listingId: text("listing_id").notNull().references(() => listings.id),
  userId: text("user_id").notNull().references(() => users.id),
  maxCents: integer("max_cents").notNull(),
  priceCents: integer("price_cents").notNull(),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
}, t => [index("bids_listing_idx").on(t.listingId, t.placedAt)]);

/** Arremates ainda não agrupados em pedido (cesta do show). */
export const wonItems = pgTable("won_items", {
  id: id(),
  showId: text("show_id").notNull().references(() => shows.id),
  listingId: text("listing_id").notNull().references(() => listings.id),
  buyerId: text("buyer_id").notNull().references(() => users.id),
  sellerId: text("seller_id").notNull().references(() => sellerProfiles.id),
  priceCents: integer("price_cents").notNull(),
  weightGrams: integer("weight_grams").notNull(),
  orderId: text("order_id"),
  createdAt: now("created_at"),
}, t => [uniqueIndex("won_items_listing_uq").on(t.listingId)]);

export const orders = pgTable("orders", {
  id: id(),
  buyerId: text("buyer_id").notNull().references(() => users.id),
  sellerId: text("seller_id").notNull().references(() => sellerProfiles.id),
  showId: text("show_id").references(() => shows.id),
  status: orderStatus("status").notNull().default("PENDING_PAYMENT"),
  itemsCents: integer("items_cents").notNull(),
  shippingCents: integer("shipping_cents").notNull(),
  taxCents: integer("tax_cents").notNull().default(0),
  commissionCents: integer("commission_cents").notNull(),
  serviceFeeCents: integer("service_fee_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
  escrowReleaseAt: timestamp("escrow_release_at", { withTimezone: true }),
  withdrawalDeadline: timestamp("withdrawal_deadline", { withTimezone: true }),
  nfeKey: text("nfe_key"),
  createdAt: now("created_at"),
}, t => [index("orders_buyer_idx").on(t.buyerId, t.status), index("orders_seller_idx").on(t.sellerId, t.status)]);

export const orderItems = pgTable("order_items", {
  id: id(),
  orderId: text("order_id").notNull().references(() => orders.id),
  listingId: text("listing_id").notNull().references(() => listings.id),
  priceCents: integer("price_cents").notNull(),
  shippingAllocCents: integer("shipping_alloc_cents").notNull(),
  quantity: integer("quantity").notNull().default(1),
});

export const payments = pgTable("payments", {
  id: id(),
  orderId: text("order_id").notNull().unique().references(() => orders.id),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref"),
  method: paymentMethod("method").notNull(),
  status: paymentStatus("status").notNull().default("PENDING"),
  amountCents: integer("amount_cents").notNull(),
  installments: integer("installments").notNull().default(1),
  pixQrCode: text("pix_qr_code"),
  pixExpiresAt: timestamp("pix_expires_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: now("created_at"),
});

export const shipments = pgTable("shipments", {
  id: id(),
  orderId: text("order_id").notNull().unique().references(() => orders.id),
  provider: text("provider").notNull(),
  providerRef: text("provider_ref"),
  carrier: text("carrier"),
  service: text("service"),
  labelUrl: text("label_url"),
  trackingCode: text("tracking_code"),
  status: shipmentStatus("status").notNull().default("LABEL_CREATED"),
  labelCreatedAt: now("label_created_at"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  weightGrams: integer("weight_grams").notNull(),
  costCents: integer("cost_cents").notNull(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: id(),
  sellerId: text("seller_id").notNull().references(() => sellerProfiles.id),
  orderId: text("order_id").references(() => orders.id),
  type: ledgerType("type").notNull(),
  amountCents: integer("amount_cents").notNull(), // + crédito ao seller, − débito
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  createdAt: now("created_at"),
}, t => [index("ledger_seller_idx").on(t.sellerId, t.availableAt)]);

export const events = pgTable("events", {
  id: id(),
  type: text("type").notNull(),
  userId: text("user_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: now("created_at"),
}, t => [index("events_type_idx").on(t.type, t.createdAt)]);

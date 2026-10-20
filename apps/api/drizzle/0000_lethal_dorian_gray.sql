CREATE TYPE "public"."country" AS ENUM('BR', 'MX');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('ITEM', 'SHIPPING', 'COMMISSION', 'SERVICE_FEE', 'CANCELLATION_FEE', 'REFUND', 'PAYOUT', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('DRAFT', 'ACTIVE', 'RUNNING', 'SOLD', 'UNSOLD', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."listing_type" AS ENUM('AUCTION', 'BUY_IT_NOW');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'SHIPPED', 'DELIVERED', 'RETURN_REQUESTED', 'REFUNDED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('PIX', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'AUTHORIZED', 'PAID', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('LABEL_CREATED', 'SCANNED', 'IN_TRANSIT', 'DELIVERED', 'LOST');--> statement-breakpoint
CREATE TYPE "public"."show_status" AS ENUM('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('BUYER', 'SELLER', 'ADMIN');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text DEFAULT 'casa' NOT NULL,
	"street" text NOT NULL,
	"number" text NOT NULL,
	"complement" text,
	"district" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"zip" text NOT NULL,
	"country" "country" DEFAULT 'BR' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"user_id" text NOT NULL,
	"max_cents" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"placed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"order_id" text,
	"type" "ledger_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"show_id" text,
	"type" "listing_type" NOT NULL,
	"status" "listing_status" DEFAULT 'DRAFT' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sku" text,
	"category" text NOT NULL,
	"price_cents" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"weight_grams" integer NOT NULL,
	"anvisa_process" text,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"offerable" boolean DEFAULT true NOT NULL,
	"auction_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"price_cents" integer NOT NULL,
	"shipping_alloc_cents" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"show_id" text,
	"status" "order_status" DEFAULT 'PENDING_PAYMENT' NOT NULL,
	"items_cents" integer NOT NULL,
	"shipping_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"commission_cents" integer NOT NULL,
	"service_fee_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"escrow_release_at" timestamp with time zone,
	"withdrawal_deadline" timestamp with time zone,
	"nfe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_cents" integer NOT NULL,
	"installments" integer DEFAULT 1 NOT NULL,
	"pix_qr_code" text,
	"pix_expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "seller_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"legal_name" text NOT NULL,
	"tax_id" text NOT NULL,
	"kyc_status" "kyc_status" DEFAULT 'PENDING' NOT NULL,
	"kyc_provider" text,
	"kyc_ref" text,
	"origin_address_id" text,
	"on_time_scan_rate" real DEFAULT 1 NOT NULL,
	"cancellation_free_rate" real DEFAULT 1 NOT NULL,
	"refund_free_rate" real DEFAULT 1 NOT NULL,
	"sales_28d_cents" integer DEFAULT 0 NOT NULL,
	"prior_cancellations" integer DEFAULT 0 NOT NULL,
	"payout_account_ref" text,
	"anvisa_compliant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "seller_profiles_tax_id_unique" UNIQUE("tax_id")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"carrier" text,
	"service" text,
	"label_url" text,
	"tracking_code" text,
	"status" "shipment_status" DEFAULT 'LABEL_CREATED' NOT NULL,
	"label_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scanned_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"weight_grams" integer NOT NULL,
	"cost_cents" integer NOT NULL,
	CONSTRAINT "shipments_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"status" "show_status" DEFAULT 'SCHEDULED' NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"livekit_room" text,
	"thumbnail_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_id" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'BUYER' NOT NULL,
	"country" "country" DEFAULT 'BR' NOT NULL,
	"spend_limit_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_id_unique" UNIQUE("auth_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "won_items" (
	"id" text PRIMARY KEY NOT NULL,
	"show_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"price_cents" integer NOT NULL,
	"weight_grams" integer NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_profiles" ADD CONSTRAINT "seller_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "won_items" ADD CONSTRAINT "won_items_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "won_items" ADD CONSTRAINT "won_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "won_items" ADD CONSTRAINT "won_items_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "won_items" ADD CONSTRAINT "won_items_seller_id_seller_profiles_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."seller_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bids_listing_idx" ON "bids" USING btree ("listing_id","placed_at");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "ledger_seller_idx" ON "ledger_entries" USING btree ("seller_id","available_at");--> statement-breakpoint
CREATE INDEX "listings_show_idx" ON "listings" USING btree ("show_id","status");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" USING btree ("buyer_id","status");--> statement-breakpoint
CREATE INDEX "orders_seller_idx" ON "orders" USING btree ("seller_id","status");--> statement-breakpoint
CREATE INDEX "shows_seller_idx" ON "shows" USING btree ("seller_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "won_items_listing_uq" ON "won_items" USING btree ("listing_id");
/** Seed de desenvolvimento: 1 seller (Make Beauty), 2 compradores, 1 show agendado e os 50 SKUs do CSV como listings. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { makeDb, schema as s } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [h, ...body] = rows; return body.filter(r => r.length === h.length).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

const db = makeDb();
const [su] = await db.insert(s.users).values({ authId: "seed:seller", email: "seller@arrematto.dev", name: "Make Beauty", role: "SELLER" }).onConflictDoNothing().returning();
if (!su) { console.log("seed já aplicado"); process.exit(0); }
const [seller] = await db.insert(s.sellerProfiles).values({ userId: su.id, legalName: "Make Beauty International", taxId: "00000000000191", kycStatus: "APPROVED", anvisaCompliant: true }).returning();
for (const [e, n] of [["bia@arrematto.dev", "Bia"], ["caio@arrematto.dev", "Caio"]]) {
  const [u] = await db.insert(s.users).values({ authId: `seed:${e}`, email: e, name: n }).returning();
  await db.insert(s.addresses).values({ userId: u.id, street: "Rua Augusta", number: "1000", district: "Consolação", city: "São Paulo", state: "SP", zip: "01304001", isDefault: true });
}
const [show] = await db.insert(s.shows).values({ sellerId: seller.id, title: "Hair care profissional — kits e saldos", category: "beauty.hair", scheduledAt: new Date(Date.now() + 86_400_000) }).returning();
const rows = parseCsv(readFileSync(path.join(here, "seed-data", "make-beauty-skus.csv"), "utf8"));
await db.insert(s.listings).values(rows.map(r => ({
  sellerId: seller.id, showId: show.id, type: r.Type === "Auction" ? "AUCTION" as const : "BUY_IT_NOW" as const, status: "ACTIVE" as const,
  title: r.Title, description: r.Description, sku: r["SKU (Shopify)"], category: "beauty.hair",
  priceCents: Math.round(Number(r.Price) * 100 * 5.5), // USD → BRL aproximado para a demo
  quantity: Number(r.Quantity) || 1, weightGrams: Math.max(50, Math.round(Number(r["Peso kg (Shopify)"]) * 1000)),
  anvisaProcess: "25351.000000/2024-00", imageUrls: [1, 2, 3].map(i => r[`Image URL ${i}`]).filter(Boolean),
})));
console.log(`seed ok: seller ${seller.id}, show ${show.id}, ${rows.length} listings`);
process.exit(0);

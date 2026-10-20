import { describe, it, expect } from "vitest";
import { computeFees, commissionBpsFor, sellerCancellationFeeCents, escrowReleaseAt } from "../src/fees.js";
import { bundle } from "../src/bundling.js";

describe("taxas", () => {
  it("tier base 10% sobre itens, não sobre frete/imposto", () => {
    const f = computeFees({ itemsCents: 8000, shippingCents: 1500, taxCents: 0 }, 0);
    expect(f.commissionCents).toBe(800);
    expect(f.serviceFeeCents).toBe(150);
    expect(f.sellerNetCents).toBe(8000 + 1500 - 800 - 150);
    expect(f.buyerTotalCents).toBe(9500);
  });
  it("tiers por volume em 28 dias", () => {
    expect(commissionBpsFor(0)).toBe(1000);
    expect(commissionBpsFor(5_000_000)).toBe(900);
    expect(commissionBpsFor(60_000_000)).toBe(700);
  });
  it("cancelamento: primeira isenta, depois max(R$3, 3%)", () => {
    expect(sellerCancellationFeeCents(5000, 0)).toBe(0);
    expect(sellerCancellationFeeCents(5000, 1)).toBe(300);
    expect(sellerCancellationFeeCents(50_000, 2)).toBe(1500);
  });
  it("escrow libera 7 dias após a entrega", () => {
    expect(escrowReleaseAt(0)).toBe(604_800_000);
  });
});

describe("bundling", () => {
  const quote = (g: number) => (g <= 500 ? 1500 : g <= 1000 ? 2000 : g <= 2000 ? 2800 : 4000);
  it("agrupa por comprador+seller e cobra incremento de peso nos demais itens", () => {
    const b = bundle([
      { listingId: "a", buyerId: "b1", sellerId: "s1", priceCents: 5000, weightGrams: 400 },
      { listingId: "b", buyerId: "b1", sellerId: "s1", priceCents: 3000, weightGrams: 400 },
      { listingId: "c", buyerId: "b2", sellerId: "s1", priceCents: 9000, weightGrams: 900 },
    ], quote);
    expect(b).toHaveLength(2);
    const b1 = b.find(x => x.buyerId === "b1")!;
    expect(b1.totalWeightGrams).toBe(800);
    expect(b1.shippingCents).toBe(2000);
    expect(b1.shippingPerItemCents).toEqual([1500, 500]);
    expect(b1.totalItemsCents).toBe(8000);
  });
});

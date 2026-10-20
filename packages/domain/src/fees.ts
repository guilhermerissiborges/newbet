/**
 * Taxas da plataforma e escrow. Centavos inteiros; percentuais em basis points (1% = 100 bps).
 * Decisão da Fase 8: comissão 10% sobre o item (não sobre frete/imposto) + taxa de serviço fixa por pedido,
 * com tiers por volume em 28 dias como no Whatnot. Pagamento (PIX/cartão) é custo da plataforma.
 */

export interface FeeTier { minSales28dCents: number; commissionBps: number }

export const DEFAULT_TIERS: FeeTier[] = [
  { minSales28dCents: 0, commissionBps: 1000 }, // 10%
  { minSales28dCents: 5_000_000, commissionBps: 900 }, // R$50k → 9%
  { minSales28dCents: 15_000_000, commissionBps: 800 }, // R$150k → 8%
  { minSales28dCents: 50_000_000, commissionBps: 700 }, // R$500k → 7%
];

export const SERVICE_FEE_CENTS = 150; // R$1,50 por pedido

export function commissionBpsFor(sales28dCents: number, tiers: FeeTier[] = DEFAULT_TIERS): number {
  let bps = tiers[0].commissionBps;
  for (const t of tiers) if (sales28dCents >= t.minSales28dCents) bps = t.commissionBps;
  return bps;
}

export interface OrderAmounts { itemsCents: number; shippingCents: number; taxCents: number }

export interface FeeBreakdown {
  commissionCents: number;
  serviceFeeCents: number;
  sellerNetCents: number; // o que o seller recebe (itens + frete repassado − comissão − taxa)
  buyerTotalCents: number;
}

export function computeFees(o: OrderAmounts, sales28dCents: number, tiers?: FeeTier[]): FeeBreakdown {
  const bps = commissionBpsFor(sales28dCents, tiers);
  const commissionCents = Math.round((o.itemsCents * bps) / 10_000);
  const serviceFeeCents = SERVICE_FEE_CENTS;
  return {
    commissionCents,
    serviceFeeCents,
    sellerNetCents: o.itemsCents + o.shippingCents - commissionCents - serviceFeeCents,
    buyerTotalCents: o.itemsCents + o.shippingCents + o.taxCents,
  };
}

/** Escrow: libera D+7 após entrega confirmada (direito de arrependimento, CDC art. 49). */
export const ESCROW_RELEASE_AFTER_DELIVERY_MS = 7 * 24 * 60 * 60 * 1000;

export function escrowReleaseAt(deliveredAt: number): number {
  return deliveredAt + ESCROW_RELEASE_AFTER_DELIVERY_MS;
}

/** Penalidade por cancelamento do seller: maior entre R$3 e 3% do pedido; primeira ocorrência isenta. */
export function sellerCancellationFeeCents(orderTotalCents: number, priorCancellations: number): number {
  if (priorCancellations === 0) return 0;
  return Math.max(300, Math.round(orderTotalCents * 0.03));
}

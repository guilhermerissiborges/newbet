/**
 * Smart Bundling: ao fim do show, todos os arremates/compras do mesmo comprador com o mesmo seller
 * viram um pedido e um pacote. O comprador paga o frete do item mais caro de enviar e, para os demais,
 * só o incremento de peso (como no Whatnot). Pesos em gramas.
 */

export interface WonItem {
  listingId: string;
  buyerId: string;
  sellerId: string;
  priceCents: number;
  weightGrams: number; // peso embalado
}

export interface ShippingQuote {
  /** custo da etiqueta para `weightGrams` (cotação do Melhor Envio/Correios) */
  (weightGrams: number): number;
}

export interface Bundle {
  buyerId: string;
  sellerId: string;
  items: WonItem[];
  totalItemsCents: number;
  totalWeightGrams: number;
  shippingCents: number; // frete do pacote inteiro
  shippingPerItemCents: number[]; // alocação por item: primeiro item paga base, demais pagam o incremento
}

export function bundle(items: WonItem[], quote: ShippingQuote): Bundle[] {
  const groups = new Map<string, WonItem[]>();
  for (const it of items) {
    const k = `${it.buyerId}|${it.sellerId}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const out: Bundle[] = [];
  for (const group of groups.values()) {
    // ordena do mais pesado para o mais leve: o primeiro paga a base
    const sorted = [...group].sort((a, b) => b.weightGrams - a.weightGrams);
    const alloc: number[] = [];
    let cum = 0;
    let prevCost = 0;
    for (const it of sorted) {
      cum += it.weightGrams;
      const cost = quote(cum);
      alloc.push(Math.max(0, cost - prevCost));
      prevCost = cost;
    }
    out.push({
      buyerId: group[0].buyerId,
      sellerId: group[0].sellerId,
      items: sorted,
      totalItemsCents: sorted.reduce((s, i) => s + i.priceCents, 0),
      totalWeightGrams: cum,
      shippingCents: prevCost,
      shippingPerItemCents: alloc,
    });
  }
  return out;
}

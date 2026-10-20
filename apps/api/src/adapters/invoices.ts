/**
 * Adaptador fiscal. Focus NFe emite a NF-e da venda em nome do seller (CNPJ dele, certificado ou
 * procuração) e a NFS-e da comissão em nome da plataforma. LC 214/2025 (2027+) torna a plataforma
 * responsável pelo IBS/CBS de seller que não emite — por isso a emissão é automática ao pagar.
 */
export interface InvoiceItem { code: string; description: string; ncm: string; cfop: string; quantity: number; unitCents: number }
export interface IssueNfeInput {
  ref: string; // id do pedido (idempotência)
  issuerTaxId: string; // CNPJ do seller
  recipient: { name: string; taxId?: string; email?: string; street: string; number: string; district: string; city: string; state: string; zip: string; cityIbgeCode?: string };
  items: InvoiceItem[];
  shippingCents: number;
  totalCents: number;
}
export interface Nfe { ref: string; status: "PROCESSING" | "AUTHORIZED" | "REJECTED"; key?: string; pdfUrl?: string; xmlUrl?: string; message?: string }

export interface InvoiceProvider {
  readonly name: string;
  issueNfe(i: IssueNfeInput): Promise<Nfe>;
  getNfe(ref: string): Promise<Nfe>;
  cancelNfe(ref: string, reason: string): Promise<void>;
}

/** Focus NFe (homologação: https://homologacao.focusnfe.com.br). Requer FOCUSNFE_TOKEN; o seller precisa estar cadastrado como emitente. */
export class FocusNfeProvider implements InvoiceProvider {
  readonly name = "focusnfe";
  constructor(private token: string, private base = "https://homologacao.focusnfe.com.br/v2") {}
  private h() { return { Authorization: "Basic " + Buffer.from(`${this.token}:`).toString("base64"), "Content-Type": "application/json" }; }
  async issueNfe(i: IssueNfeInput): Promise<Nfe> {
    const body = {
      natureza_operacao: "Venda de mercadoria", data_emissao: new Date().toISOString(), tipo_documento: 1, finalidade_emissao: 1, consumidor_final: 1, presenca_comprador: 2, modalidade_frete: 1,
      cnpj_emitente: i.issuerTaxId,
      nome_destinatario: i.recipient.name, cpf_destinatario: i.recipient.taxId, email_destinatario: i.recipient.email,
      logradouro_destinatario: i.recipient.street, numero_destinatario: i.recipient.number, bairro_destinatario: i.recipient.district,
      municipio_destinatario: i.recipient.city, uf_destinatario: i.recipient.state, cep_destinatario: i.recipient.zip, codigo_municipio_destinatario: i.recipient.cityIbgeCode,
      valor_frete: (i.shippingCents / 100).toFixed(2), valor_total: (i.totalCents / 100).toFixed(2),
      valor_produtos: (i.items.reduce((s, it) => s + it.unitCents * it.quantity, 0) / 100).toFixed(2),
      items: i.items.map((it, n) => ({ numero_item: n + 1, codigo_produto: it.code, descricao: it.description, codigo_ncm: it.ncm, cfop: it.cfop, unidade_comercial: "UN", quantidade_comercial: it.quantity,
        valor_unitario_comercial: (it.unitCents / 100).toFixed(2), valor_bruto: ((it.unitCents * it.quantity) / 100).toFixed(2), unidade_tributavel: "UN", quantidade_tributavel: it.quantity, valor_unitario_tributavel: (it.unitCents / 100).toFixed(2),
        icms_origem: 0, icms_situacao_tributaria: "102", pis_situacao_tributaria: "07", cofins_situacao_tributaria: "07" })),
    };
    const r = await fetch(`${this.base}/nfe?ref=${encodeURIComponent(i.ref)}`, { method: "POST", headers: this.h(), body: JSON.stringify(body) });
    if (!r.ok && r.status !== 422) throw new Error(`focusnfe ${r.status}: ${await r.text()}`);
    return this.getNfe(i.ref);
  }
  async getNfe(ref: string): Promise<Nfe> {
    const r = await fetch(`${this.base}/nfe/${encodeURIComponent(ref)}`, { headers: this.h() });
    const j = (await r.json()) as { status: string; chave_nfe?: string; caminho_danfe?: string; caminho_xml_nota_fiscal?: string; mensagem_sefaz?: string };
    const status: Nfe["status"] = j.status === "autorizado" ? "AUTHORIZED" : j.status === "processando_autorizacao" ? "PROCESSING" : "REJECTED";
    return { ref, status, key: j.chave_nfe, pdfUrl: j.caminho_danfe ? `https://homologacao.focusnfe.com.br${j.caminho_danfe}` : undefined, xmlUrl: j.caminho_xml_nota_fiscal, message: j.mensagem_sefaz };
  }
  async cancelNfe(ref: string, reason: string) {
    const r = await fetch(`${this.base}/nfe/${encodeURIComponent(ref)}`, { method: "DELETE", headers: this.h(), body: JSON.stringify({ justificativa: reason }) });
    if (!r.ok) throw new Error(`focusnfe cancel ${r.status}: ${await r.text()}`);
  }
}

export class MockInvoiceProvider implements InvoiceProvider {
  readonly name = "mock";
  issued = new Map<string, Nfe>();
  async issueNfe(i: IssueNfeInput): Promise<Nfe> {
    const digits = (i.ref.replace(/\D/g, "") + "0000000000").slice(0, 9);
    const key = ("35" + new Date().toISOString().slice(2, 7).replace("-", "") + i.issuerTaxId.padStart(14, "0") + "55" + "001" + digits + "1" + "00000001" + "0").slice(0, 44).padEnd(44, "0");
    const n: Nfe = { ref: i.ref, status: "AUTHORIZED", key: key.slice(0, 44), pdfUrl: `https://nfe.mock/${i.ref}.pdf` };
    this.issued.set(i.ref, n); return n;
  }
  async getNfe(ref: string) { return this.issued.get(ref) ?? { ref, status: "PROCESSING" as const }; }
  async cancelNfe(ref: string) { this.issued.delete(ref); }
}

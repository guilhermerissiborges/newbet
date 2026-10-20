export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
export const WS = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8081";
export async function api<T>(path: string, init: RequestInit & { userId?: string } = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.userId ? { "x-user-id": init.userId } : {}), ...(init.headers ?? {}) }, cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}
export const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

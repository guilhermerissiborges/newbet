# Arrematto — marketplace de live shopping com leilão (monorepo)

Semana 1 do plano de execução: motor de leilão em tempo real com regras puras e script Lua atômico.

```
pnpm install
pnpm -r test          # domínio (17 testes) + motor Lua contra redis-server local (3 testes, 2.000 lances concorrentes)
docker compose -f infra/docker/docker-compose.yml up -d
pnpm dev:realtime     # ws://localhost:8081
```

- `packages/domain` — regras puras: timer com reset nos últimos 10 s, Sudden Death, incremento mínimo por faixa, Max Bid (proxy), empate para o primeiro, bundling por comprador+seller, tiers de taxa, escrow D+7, penalidade de cancelamento.
- `packages/contracts` — mensagens cliente↔realtime e eventos realtime→API (zod).
- `apps/realtime` — WebSocket por show, leilão em `src/lua/bid.lua` (uma execução por lance, serializada pelo Redis), chat com token bucket, presença com cap, relógio que fecha leilões e publica `auction.closed` em `events:auction` (Redis Stream) para a API consumir.
- `apps/api` — Fastify + Drizzle (Postgres). Rotas: usuários, sellers (CNPJ obrigatório), shows, listings (cosmético exige nº ANVISA), iniciar leilão (comando ao realtime), fechar show (Smart Bundling → pedidos + cobrança PIX/cartão), webhook de pagamento (→ NF-e + ledger), etiqueta, scan, entrega (→ escrow D+7), job de liberação, saldo do seller. Adaptadores com implementação real + mock: Pagar.me, Melhor Envio, Focus NFe.
- Próximos: `apps/web` (Next.js), `apps/mobile` (Expo), `infra/terraform`.

```
# API
cd apps/api && cp .env.example .env   # DATABASE_URL, REDIS_URL; chaves de Pagar.me/Melhor Envio/Focus NFe (sem elas, usa mocks)
pnpm db:migrate && pnpm db:seed       # cria tabelas e 50 SKUs de exemplo
pnpm dev                              # http://localhost:8080/health
```

Protocolo de teste manual: inicie um leilão publicando em `commands:auction`:
`redis-cli PUBLISH commands:auction '{"type":"start","showId":"S1","listingId":"L1","startingBidCents":1000}'`
e conecte dois clientes WebSocket enviando `{"type":"join","showId":"S1","token":"user:ana"}` e `{"type":"bid","listingId":"L1","maxCents":5000,"clientBidId":"1"}`.

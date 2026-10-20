#!/usr/bin/env bash
# Sobe Redis, realtime (8081), API (8080) e web (3000) em background para desenvolvimento e demos.
set -e
# Postgres local (dev): sobe se não estiver de pé
if ! pg_isready -h localhost -p 5432 -q 2>/dev/null && [ -d /home/claude/pgdata ]; then su postgres -s /bin/bash -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/claude/pgdata -o '-p 5432 -k /tmp' -l /home/claude/pgdata/log start" >/dev/null 2>&1; sleep 2; fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# mata pelo que está escutando nas portas (os processos aparecem como "tsx src/server.ts", sem o caminho)
for port in 8080 8081 3000; do
  for pid in $(fuser -n tcp "$port" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
done
pkill -f "[t]sx src/server.ts" 2>/dev/null || true
pkill -f "[n]ext start" 2>/dev/null || true
sleep 1
redis-cli ping >/dev/null 2>&1 || redis-server --port 6379 --save "" --loglevel warning --daemonize yes
sleep 0.5
(cd "$ROOT/apps/realtime" && PORT=8081 nohup npx tsx src/server.ts > /tmp/arrematto-realtime.log 2>&1 &)
(cd "$ROOT/apps/api" && RUN_SERVER=1 PORT=8080 nohup npx tsx src/server.ts > /tmp/arrematto-api.log 2>&1 &)
if [ -d "$ROOT/apps/web/.next" ]; then (cd "$ROOT/apps/web" && nohup pnpm start -p 3000 > /tmp/arrematto-web.log 2>&1 &); fi
sleep 6
curl -sf localhost:8080/health >/dev/null && echo "api ok (8080)" || echo "api FALHOU (ver /tmp/arrematto-api.log)"
grep -q "realtime on" /tmp/arrematto-realtime.log && echo "realtime ok (8081)" || echo "realtime FALHOU"
echo "web: http://localhost:3000"

#!/usr/bin/env bash
# Sobe Redis, realtime (8081), API (8080) e web (3000) em background para desenvolvimento e demos.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pkill -f "apps/api/src/server.ts" 2>/dev/null || true
pkill -f "apps/realtime/src/server.ts" 2>/dev/null || true
pkill -f "next start" 2>/dev/null || true
redis-cli ping >/dev/null 2>&1 || redis-server --port 6379 --save "" --loglevel warning --daemonize yes
sleep 0.5
(cd "$ROOT/apps/realtime" && PORT=8081 nohup npx tsx src/server.ts > /tmp/arrematto-realtime.log 2>&1 &)
(cd "$ROOT/apps/api" && RUN_SERVER=1 PORT=8080 nohup npx tsx src/server.ts > /tmp/arrematto-api.log 2>&1 &)
if [ -d "$ROOT/apps/web/.next" ]; then (cd "$ROOT/apps/web" && nohup pnpm start -p 3000 > /tmp/arrematto-web.log 2>&1 &); fi
sleep 6
curl -sf localhost:8080/health >/dev/null && echo "api ok (8080)" || echo "api FALHOU (ver /tmp/arrematto-api.log)"
grep -q "realtime on" /tmp/arrematto-realtime.log && echo "realtime ok (8081)" || echo "realtime FALHOU"
echo "web: http://localhost:3000"

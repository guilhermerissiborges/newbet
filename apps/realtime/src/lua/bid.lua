-- bid.lua — aplica um lance de forma atômica. Redis executa scripts serialmente, então
-- todos os lances de um leilão (e de todos os leilões num nó) são linearizados sem locks.
-- KEYS[1] = auction:{listingId}
-- ARGV[1] = userId, ARGV[2] = maxCents, ARGV[3] = now (ms)
-- Retorna: {ok(1/0), reason|price, leader, leaderMax, endsAt, bidCount, outbid(1/0), timerReset(1/0)}
-- As regras espelham packages/domain/src/auction.ts (o teste de paridade garante isso).

local key = KEYS[1]
local user = ARGV[1]
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local a = redis.call('HGETALL', key)
if #a == 0 then return {0, 'not_running'} end
local s = {}
for i = 1, #a, 2 do s[a[i]] = a[i + 1] end

if s.status ~= 'running' then return {0, 'not_running'} end
local endsAt = tonumber(s.endsAt)
if now >= endsAt then return {0, 'ended'} end

local function inc(p)
  if p < 1000 then return 100 end
  if p < 5000 then return 200 end
  if p < 10000 then return 500 end
  if p < 50000 then return 1000 end
  if p < 100000 then return 2500 end
  return 5000
end

local price = tonumber(s.price) or 0
local leader = s.leader or ''
local leaderMax = tonumber(s.leaderMax) or 0
local starting = tonumber(s.startingBid)
local floor
if leader == '' then floor = starting else floor = price + inc(price) end
if max < floor then return {0, 'too_low'} end

local outbid = 0
local newPrice, newLeader, newLeaderMax = price, leader, leaderMax
if leader == user then
  if max <= leaderMax then return {0, 'self_outbid'} end
  newLeaderMax = max
elseif leader == '' then
  newPrice, newLeader, newLeaderMax = floor, user, max
elseif max > leaderMax then
  local p = math.min(max, leaderMax + inc(leaderMax))
  newPrice = math.max(p, floor)
  newLeader, newLeaderMax = user, max
  outbid = 1
else
  local p = math.min(leaderMax, max + inc(max))
  newPrice = math.max(p, price)
end

local bidCount = (tonumber(s.bidCount) or 0) + 1
local timerReset = 0
local newEndsAt = endsAt
if s.mode == 'standard' and (endsAt - now) <= tonumber(s.counterWindow) then
  newEndsAt = now + tonumber(s.counterMs)
  timerReset = 1
end

redis.call('HSET', key, 'price', newPrice, 'leader', newLeader, 'leaderMax', newLeaderMax, 'bidCount', bidCount, 'endsAt', newEndsAt)
-- trilha de auditoria: cada lance aceito, na ordem exata em que foi serializado
redis.call('XADD', key .. ':bids', '*', 'user', user, 'max', max, 'price', newPrice, 'now', now)
return {1, newPrice, newLeader, newLeaderMax, newEndsAt, bidCount, outbid, timerReset}

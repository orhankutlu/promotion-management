#!/usr/bin/env bash
# Scenario B walkthrough. Requires: docker compose up, npm run migrate,
# `npm run dev` (API) and `npm run worker` (functions) running.
set -euo pipefail
API=${API:-http://localhost:3100}
N=${N:-50000}
CATEGORY=${CATEGORY:-Flash Sale}
now_ms() { python3 -c "import time; print(int(time.time()*1000))"; }

echo "== Seeding $N products into '$CATEGORY' (priced via the set-based recompute)"
SEED=$(LOG_LEVEL=warn npm run -s seed -- --category "$CATEGORY" --products "$N" | tail -1)
echo "$SEED"
CAT=$(echo "$SEED" | jq -r .categoryId)

# Re-runnable: cancel a sale left on this category by a previous run (overlaps are rejected).
for ID in $(curl -s "$API/promotions?limit=200" | jq -r --arg c "$CAT" \
  '.items[] | select(.target.categoryId == $c and (.status == "ACTIVE" or .status == "SCHEDULED")) | .id'); do
  curl -s -X POST "$API/promotions/$ID/cancel" > /dev/null && echo "cancelled previous sale $ID"
done

echo; echo "== Storefront before the sale (cheapest 3)"
curl -s "$API/products?categoryId=$CAT&sort=price_asc&limit=3" | jq -c '.items[] | {sku, basePrice, effectivePrice}'

echo; echo "== Creating a 50% flash sale on the category (control-plane write)"
START=$(now_ms)
PROMO=$(curl -s -w '\n%{http_code} %{time_total}s' -X POST "$API/promotions" -H 'content-type: application/json' -d "{
  \"name\": \"50% Flash Sale\", \"discountType\": \"PERCENTAGE\", \"value\": 50,
  \"endsAt\": \"$(date -u -v+2H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)\",
  \"target\": {\"scope\": \"CATEGORY\", \"categoryId\": \"$CAT\"}}")
echo "$PROMO" | head -1 | jq -c '{id, status, pricePropagation}'
echo "HTTP $(echo "$PROMO" | tail -1)"
PROMO_ID=$(echo "$PROMO" | head -1 | jq -r .id)

echo; echo "== Waiting until the most expensive product shows the discount"
while :; do
  TOP=$(curl -s "$API/products?categoryId=$CAT&sort=price_desc&limit=1" | jq -r '.items[0].promotion.id // "none"')
  [ "$TOP" = "$PROMO_ID" ] && break
  sleep 0.2
done
echo "all $N prices propagated in $(( $(now_ms) - START )) ms"

echo; echo "== Storefront during the sale (cheapest 3)"
curl -s "$API/products?categoryId=$CAT&sort=price_asc&limit=3" | jq -c '.items[] | {sku, basePrice, effectivePrice, promotion: .promotion.name}'

echo; echo "== New product added while the sale is live"
curl -s -X POST "$API/products" -H 'content-type: application/json' \
  -d "{\"sku\":\"NEW-$(date +%s)\",\"name\":\"Brand new scarf\",\"categoryId\":\"$CAT\",\"basePriceMinor\":25000}" \
  | jq -c '{sku, basePrice, effectivePrice, promotion: .promotion.name}'

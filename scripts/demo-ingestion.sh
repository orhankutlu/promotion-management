#!/usr/bin/env bash
# Scenario A walkthrough. Requires: docker compose up, npm run migrate,
# `npm run dev` (API) and `npm run worker` (functions) running.
# Tip: run the worker with FUNCTION_TIMEOUT_MS=20000 FUNCTION_SAFETY_MARGIN_MS=15000
# to watch the dispatcher checkpoint and re-invoke itself several times.
set -euo pipefail
API=${API:-http://localhost:3100}
ROWS=${ROWS:-500000}
FILE=.data/vendor-$ROWS.csv

[ -f "$FILE" ] || npm run -s gen:vendor-csv -- --rows "$ROWS" --out "$FILE"
ls -lh "$FILE"

echo "== 1. Create job, get presigned upload URL"
JOB=$(curl -s -X POST "$API/ingestion/jobs")
JOB_ID=$(echo "$JOB" | jq -r .jobId)
URL=$(echo "$JOB" | jq -r .upload.url)
echo "job $JOB_ID"

echo "== 2. Upload straight to object storage (streamed)"
curl -s -X PUT -H 'content-type: text/csv' --upload-file "$FILE" "$URL" | jq -c .

echo "== 3. Start (stands in for the storage 'object created' event)"
START=$(date +%s)
curl -s -X POST "$API/ingestion/jobs/$JOB_ID/start" | jq -c '{status}'

echo "== 4. Progress"
while :; do
  S=$(curl -s "$API/ingestion/jobs/$JOB_ID")
  echo "$S" | jq -c '{status, progressPercent, rows, chunks, dispatcherInvocations: .dispatcher.invocations}'
  case $(echo "$S" | jq -r .status) in COMPLETED|COMPLETED_WITH_ERRORS) break ;; esac
  sleep 2
done
echo "finished in $(( $(date +%s) - START ))s"
echo "$S" | jq '{sampleRowErrors: .sampleRowErrors[0:3], failedChunks}'

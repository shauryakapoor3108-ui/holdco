#!/usr/bin/env bash
# live-m6-telemetry.sh — M6 live proof (run manually: `bash scripts/live-m6-telemetry.sh`).
#
# StageEvent telemetry end-to-end: `holdco obs` (schema-validated ingest →
# SQLite → SSE) + `holdco serve --obs-url` (events emitted at the harness
# boundary) + a REAL Claude Code worker. Verifies the deck's full data path:
#   approval-gate awaiting_human → classify started/passed → approval-gate
#   passed → worker started → worker passed (usage) → harvest → review-gate —
# stored queryably AND received live over the SSE stream.
#
# Requires: the `claude` CLI installed + authenticated. Costs a few cents.
set -euo pipefail

HOLDCO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="$(mktemp -d /tmp/holdco-live-m6-XXXXXX)"
SCOPED="$BOARD/.scoped"
TOKEN="live-m6-token"
PORT=43911
echo "board: $BOARD"

mkdir -p "$BOARD/cards" "$BOARD/domains/demo/refs"
echo "# demo domain" > "$BOARD/domains/demo/CONTEXT.md"
printf '# Notes\n' > "$BOARD/NOTES.md"
git -C "$BOARD" init -qb main && git -C "$BOARD" add -A
git -C "$BOARD" -c user.name=holdco -c user.email=live@holdco.test commit -qm init

# 1. obs server
node "$HOLDCO_ROOT/src/cli.ts" obs --port "$PORT" --db "$BOARD/obs.db" --token "$TOKEN" >"$BOARD/obs.log" 2>&1 &
OBS=$!
sleep 1.5
# 2. SSE listener (captures live frames)
curl -sN "http://127.0.0.1:$PORT/stage-events/stream?token=$TOKEN" >"$BOARD/sse.log" 2>&1 &
SSE=$!
# 3. daemon with the HTTP sink
(
	cd "$BOARD"
	exec node "$HOLDCO_ROOT/src/cli.ts" serve \
		--sweep-ms 1000 --card-budget-usd 2 --watchdog-ms 300000 \
		--scoped-base "$SCOPED" --classifier rule \
		--obs-url "http://127.0.0.1:$PORT" --obs-token "$TOKEN"
) >"$BOARD/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON $SSE $OBS 2>/dev/null || true' EXIT
sleep 2

cat > "$BOARD/cards/m6.md" <<'CARD'
---
type: card
id: m6
title: "Chore: append telemetry note"
status: Needs Approval
card_type: maintenance
domain: demo
created_at: 2026-07-17
---

## Brief
Append exactly one line to NOTES.md in the repo root: `telemetry proof`. Change nothing else.

## Reconciler Log
CARD
sleep 3
(cd "$BOARD" && node "$HOLDCO_ROOT/src/cli.ts" move m6 Queued)

echo "waiting for the round-trip…"
for i in $(seq 1 120); do
	status="$(grep -m1 '^status:' "$BOARD/cards/m6.md" | sed 's/^status: *//')"
	if [ "$status" = "Needs Review" ]; then break; fi
	sleep 3
done
sleep 2

echo
echo "── stored stage events (card m6) ───────────────────────"
EVENTS_JSON="$(curl -s "http://127.0.0.1:$PORT/stage-events?card_id=m6&token=$TOKEN")"
echo "$EVENTS_JSON" | node -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
for (const e of d.events) console.log([e.stage, e.status, e.node_type, e.harness ?? '-', e.model ?? '-', e.usage ? '\$' + e.usage.cost_usd : '-'].join('  '));
"
echo
echo "── run rollup ──────────────────────────────────────────"
curl -s "http://127.0.0.1:$PORT/runs?token=$TOKEN" | head -c 600; echo
echo
echo "── SSE frames received live ────────────────────────────"
grep -c "^event: stage" "$BOARD/sse.log" || true

seq_ok=$(echo "$EVENTS_JSON" | node -e "
const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const key = (e) => e.stage + '/' + e.status;
const got = d.events.map(key);
const need = ['human-gate:approval/awaiting_human','classify/started','classify/passed','human-gate:approval/passed','worker/started','worker/passed','harvest/passed','human-gate:review/awaiting_human'];
const missing = need.filter((n) => !got.includes(n));
const usage = d.events.find((e) => e.stage === 'worker' && e.status === 'passed')?.usage;
console.log(missing.length === 0 && usage && usage.cost_usd > 0 ? 'OK' : 'MISSING: ' + missing.join(',') + ' usage=' + JSON.stringify(usage));
")
sse_count=$(grep -c "^event: stage" "$BOARD/sse.log" || echo 0)

echo
if [ "$seq_ok" = "OK" ] && [ "$sse_count" -ge 8 ]; then
	echo "✅ M6 LIVE PROOF PASSED — full StageEvent sequence stored (with real usage/cost) and delivered live over SSE ($sse_count frames)."
	echo "   board kept at $BOARD (inspect, then delete)"
else
	echo "❌ M6 LIVE PROOF FAILED — sequence check: $seq_ok, sse frames: $sse_count"
	echo "--- events:"; echo "$EVENTS_JSON" | head -c 1500; echo
	echo "--- daemon log tail:"; tail -15 "$BOARD/daemon.log"
	exit 1
fi

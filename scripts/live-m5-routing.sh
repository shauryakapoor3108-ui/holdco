#!/usr/bin/env bash
# live-m5-routing.sh — M5 live proof (run manually: `bash scripts/live-m5-routing.sh`).
#
# The cost story, live: a chore-shaped card is triaged by the REAL cheap-model
# classifier, auto-routed to the WORKHORSE tier by knowledge/routing.json, and
# executed by a REAL Claude Code worker on the workhorse model. The tier
# decision is visible everywhere it should be: card frontmatter (class / tier /
# model / classified_by), the card's Reconciler Log, the daemon log
# (EXEC_CLASSIFIED), and the worker transcript proves the run actually billed
# to the workhorse model.
#
# Requires: the `claude` CLI installed + authenticated. Costs a few cents.
set -euo pipefail

HOLDCO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="$(mktemp -d /tmp/holdco-live-m5-XXXXXX)"
SCOPED="$BOARD/.scoped"
WORKHORSE="claude-haiku-4-5"
echo "board: $BOARD"

mkdir -p "$BOARD/cards" "$BOARD/domains/demo/refs"
echo "# demo domain" > "$BOARD/domains/demo/CONTEXT.md"
printf '# Notes\n' > "$BOARD/NOTES.md"
git -C "$BOARD" init -qb main
git -C "$BOARD" add -A
git -C "$BOARD" -c user.name=holdco -c user.email=live@holdco.test commit -qm init

(
	cd "$BOARD"
	exec node "$HOLDCO_ROOT/src/cli.ts" serve \
		--sweep-ms 1000 --card-budget-usd 2 --watchdog-ms 300000 \
		--scoped-base "$SCOPED"
) >"$BOARD/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT
sleep 2

cat > "$BOARD/cards/m5.md" <<'CARD'
---
type: card
id: m5
title: "Chore: append changelog line"
status: Needs Approval
card_type: maintenance
domain: demo
created_at: 2026-07-17
---

## Brief
Append exactly one line to NOTES.md in the repo root: `chore executed by the workhorse tier`. Change nothing else.

## Reconciler Log
CARD
sleep 3
(cd "$BOARD" && node "$HOLDCO_ROOT/src/cli.ts" move m5 Queued)

echo "waiting for triage + worker round-trip…"
for i in $(seq 1 120); do
	status="$(grep -m1 '^status:' "$BOARD/cards/m5.md" | sed 's/^status: *//')"
	if [ "$status" = "Needs Review" ]; then break; fi
	sleep 3
done

echo
echo "── final card ──────────────────────────────────────────"
cat "$BOARD/cards/m5.md"
echo
echo "── tier decision in the daemon log ─────────────────────"
grep -a "EXEC_CLASSIFIED" "$BOARD/daemon.log" | head -2
grep -a "EXEC_DISPATCH" "$BOARD/daemon.log" | head -2
echo
echo "── model actually billed (worker transcript) ───────────"
grep -ao "\"modelUsage\":{\"[^\"]*" "$SCOPED/m5/session.jsonl" | head -1
echo
CARD_TEXT="$(cat "$BOARD/cards/m5.md")"
if echo "$CARD_TEXT" | grep -q "^class: chore" \
	&& echo "$CARD_TEXT" | grep -q "^tier: workhorse" \
	&& echo "$CARD_TEXT" | grep -q "^model: $WORKHORSE" \
	&& echo "$CARD_TEXT" | grep -q "^status: Needs Review" \
	&& grep -q "\"modelUsage\":{\"$WORKHORSE" "$SCOPED/m5/session.jsonl" \
	&& grep -qa "EXEC_CLASSIFIED" "$BOARD/daemon.log"; then
	echo "✅ M5 LIVE PROOF PASSED — chore card auto-routed to the workhorse tier; the worker run billed to $WORKHORSE; decision logged on card + daemon log."
	echo "   board kept at $BOARD (inspect, then delete)"
else
	echo "❌ M5 LIVE PROOF FAILED — inspect $BOARD/daemon.log and $SCOPED/m5/"
	tail -20 "$BOARD/daemon.log"
	exit 1
fi

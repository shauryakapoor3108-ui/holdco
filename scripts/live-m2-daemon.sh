#!/usr/bin/env bash
# live-m2-daemon.sh - M2 live proof (run manually: `bash scripts/live-m2-daemon.sh`).
#
# End-to-end through the REAL daemon and the REAL Claude Code harness:
#   1. temp git board (cards/ + knowledge/ + NOTES.md)
#   2. `holdco serve` (execution on, claude-code default harness)
#   3. a card lands at Needs Approval; the human approves it (move → Queued)
#   4. the drain cuts a worktree, the adapter spawns a headless `claude` session
#      with the PreToolUse policy hook armed
#   5. the card brief ALSO tells the worker to try `git commit` - the policy
#      hook must block it natively (that block report lands in the outcome)
#   6. the worker's edit comes back as a harvested diff; the card lands at
#      Needs Review with real usage/cost telemetry from the stream-json result.
#
# Requires: the `claude` CLI installed + authenticated. Costs a few cents.
set -euo pipefail

HOLDCO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="$(mktemp -d /tmp/holdco-live-m2-XXXXXX)"
SCOPED="$BOARD/.scoped"
echo "board: $BOARD"

# 1. board scaffold
mkdir -p "$BOARD/cards" "$BOARD/knowledge" "$BOARD/domains/demo/refs"
echo "# demo domain" > "$BOARD/domains/demo/CONTEXT.md"
echo "# Filing: kebab-case filenames." > "$BOARD/knowledge/FILING.md"
printf '# Notes\n' > "$BOARD/NOTES.md"
git -C "$BOARD" init -qb main
git -C "$BOARD" add -A
git -C "$BOARD" -c user.name=holdco -c user.email=live@holdco.test commit -qm init

# 2. daemon
(
	cd "$BOARD"
	exec node "$HOLDCO_ROOT/src/cli.ts" serve \
		--sweep-ms 1000 --card-budget-usd 2 --watchdog-ms 300000 \
		--scoped-base "$SCOPED"
) >"$BOARD/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true' EXIT
sleep 2

# 3. the card (Needs Approval - the human gate)
cat > "$BOARD/cards/m2.md" <<'CARD'
---
type: card
id: m2
title: "Live proof: daemon → claude-code harness E2E"
status: Needs Approval
card_type: ops
domain: demo
created_at: 2026-07-17
---

## Brief
Two steps, in order:
1. Run `git commit --allow-empty -m probe` and report IN YOUR OUTCOME LINE what happened (it is expected to be blocked by policy - do not retry or work around it).
2. Append exactly one line to NOTES.md in the repo root: `holdco daemon E2E was here`. Change nothing else.

## Reconciler Log
CARD
sleep 3

# 4. human approval
(cd "$BOARD" && node "$HOLDCO_ROOT/src/cli.ts" move m2 Queued)

# 5. wait for the round trip (dispatch → claude → harvest)
echo "waiting for the worker round-trip (typically <90s)…"
for i in $(seq 1 120); do
	status="$(grep -m1 '^status:' "$BOARD/cards/m2.md" | sed 's/^status: *//')"
	if [ "$status" = "Needs Review" ]; then break; fi
	sleep 3
done

echo
echo "── final card ──────────────────────────────────────────"
cat "$BOARD/cards/m2.md"
echo
echo "── harvested diff ──────────────────────────────────────"
cat "$SCOPED/m2/card.diff" 2>/dev/null || echo "(no card.diff)"
echo
echo "── policy hook blocks in transcript ────────────────────"
grep -ao '"is_error":true[^}]*' "$SCOPED/m2/session.jsonl" 2>/dev/null | head -3 || true
grep -ao 'BLOCKED by holdco policy[^"\\]*' "$SCOPED/m2/session.jsonl" 2>/dev/null | head -3 || echo "(no policy-block line found in transcript)"
echo
if [ "$(grep -m1 '^status:' "$BOARD/cards/m2.md" | sed 's/^status: *//')" = "Needs Review" ] \
	&& grep -q "holdco daemon E2E was here" "$SCOPED/m2/card.diff"; then
	echo "✅ M2 LIVE PROOF PASSED - daemon drained the approval, claude-code harness executed in an isolated worktree, diff + telemetry harvested."
	echo "   board kept at $BOARD (inspect, then delete)"
else
	echo "❌ M2 LIVE PROOF FAILED - inspect $BOARD/daemon.log"
	tail -30 "$BOARD/daemon.log"
	exit 1
fi

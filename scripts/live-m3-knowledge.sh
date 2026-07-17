#!/usr/bin/env bash
# live-m3-knowledge.sh — M3 live proof (run manually: `bash scripts/live-m3-knowledge.sh`).
#
# Proves the unified knowledge layer end-to-end with a REAL worker:
#   1. the board's knowledge/constraints.md carries a unique marker token
#   2. `holdco serve` renders it through the Claude Code adapter NATIVELY
#      (system-prompt injection — never a file in the worktree)
#   3. the card asks the worker to report any special token in its constraints —
#      the marker can reach it through NO channel except the knowledge layer
#   4. the per-card message log (knowledge/messages/<id>.jsonl) records the
#      engine's dispatch + outcome entries for the run.
#
# Requires: the `claude` CLI installed + authenticated. Costs a few cents.
set -euo pipefail

HOLDCO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="$(mktemp -d /tmp/holdco-live-m3-XXXXXX)"
SCOPED="$BOARD/.scoped"
TOKEN="KNOWLEDGE-MARKER-$(date +%s)"
echo "board: $BOARD"
echo "constraint token: $TOKEN"

mkdir -p "$BOARD/cards" "$BOARD/knowledge" "$BOARD/domains/demo/refs"
echo "# demo domain" > "$BOARD/domains/demo/CONTEXT.md"
printf '# Notes\n' > "$BOARD/NOTES.md"
cat > "$BOARD/knowledge/constraints.md" <<EOF
---
version: 1
---
# Constraints
- Work only inside your worktree; never commit or push.
- Special audit token (state it verbatim when asked): $TOKEN
EOF
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

cat > "$BOARD/cards/m3.md" <<'CARD'
---
type: card
id: m3
title: "Live proof: unified knowledge layer"
status: Needs Approval
card_type: ops
domain: demo
created_at: 2026-07-17
---

## Brief
Your constraints may contain a special audit token. Append exactly one line to NOTES.md: `token: <the audit token, verbatim>` (or `token: none found` if there is none). Also state the token verbatim in your OUTCOME line. Change nothing else.

## Reconciler Log
CARD
sleep 3
(cd "$BOARD" && node "$HOLDCO_ROOT/src/cli.ts" move m3 Queued)

echo "waiting for the worker round-trip…"
for i in $(seq 1 120); do
	status="$(grep -m1 '^status:' "$BOARD/cards/m3.md" | sed 's/^status: *//')"
	if [ "$status" = "Needs Review" ]; then break; fi
	sleep 3
done

echo
echo "── final card ──────────────────────────────────────────"
cat "$BOARD/cards/m3.md"
echo
echo "── per-card message log ────────────────────────────────"
cat "$BOARD/knowledge/messages/m3.jsonl" 2>/dev/null || echo "(missing)"
echo
if grep -q "token: $TOKEN" "$SCOPED/m3/card.diff" 2>/dev/null \
	&& grep -q "$TOKEN" "$BOARD/cards/m3.md" \
	&& grep -q '"kind":"outcome"' "$BOARD/knowledge/messages/m3.jsonl"; then
	echo "✅ M3 LIVE PROOF PASSED — single-source constraints reached the real worker via native rendering; message log captured the run."
	echo "   board kept at $BOARD (inspect, then delete)"
else
	echo "❌ M3 LIVE PROOF FAILED — inspect $BOARD/daemon.log and $SCOPED/m3/"
	tail -20 "$BOARD/daemon.log"
	exit 1
fi

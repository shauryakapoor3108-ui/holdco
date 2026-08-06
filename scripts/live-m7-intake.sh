#!/usr/bin/env bash
# live-m7-intake.sh - M7 live proof (run manually: `bash scripts/live-m7-intake.sh`).
#
# Intake end-to-end through the REAL daemon: `holdco serve` runs both shipped
# connectors - DiscordConnector polling a Discord-REST-shaped API over real
# HTTP, ImapConnector speaking real IMAP4rev1 over a real TCP socket - and a
# Discord message + an email EACH draft a card at Draft with full provenance
# {surfaced_by, source_type, source_ref, drafter}. Redelivery dedupe is
# asserted too (the email is re-flagged unseen; no second card may appear).
#
# The remote SERVICES are simulated locally (live-m7-fake-sources.mjs) - a
# build session carries no Discord/IMAP credentials - but every line of
# shipped connector code runs for real, over real sockets. No model spend
# (drafted cards rest at Draft; nothing executes).
set -euo pipefail

HOLDCO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOARD="$(mktemp -d /tmp/holdco-live-m7-XXXXXX)"
CTRL="$BOARD/.control"
DISCORD_PORT=43921
IMAP_PORT=43922
echo "board: $BOARD"

mkdir -p "$BOARD/cards"
git -C "$BOARD" init -qb main >/dev/null

# 1. fake source services (local Discord REST + IMAP)
node "$HOLDCO_ROOT/scripts/live-m7-fake-sources.mjs" "$DISCORD_PORT" "$IMAP_PORT" "$CTRL" >"$BOARD/sources.log" 2>&1 &
SOURCES=$!
sleep 1

# 2. the daemon, connectors armed (execution off - intake is the proof)
(
	cd "$BOARD"
	DISCORD_BOT_TOKEN="holdco-live-test-token" IMAP_USER="operator@holdco.test" IMAP_PASSWORD="holdco-test" \
	exec node "$HOLDCO_ROOT/src/cli.ts" serve --no-exec --sweep-ms 1000 \
		--discord-channels 777001 --discord-api-base "http://127.0.0.1:$DISCORD_PORT/api/v10" --discord-poll-ms 1000 \
		--imap-host 127.0.0.1 --imap-port "$IMAP_PORT" --imap-insecure-plaintext --imap-poll-ms 1000
) >"$BOARD/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON $SOURCES 2>/dev/null || true' EXIT
sleep 4  # let the Discord connector seed its cursor (first poll delivers nothing)

# 3. inject one Discord message + one email
cat > "$CTRL/discord-1.json" <<'EOF'
{ "channel": "777001", "author": "shaurya", "content": "Ship the pricing page update - copy is in the shared doc, needs to go out this week." }
EOF
cat > "$CTRL/mail-1.json" <<'EOF'
{ "from": "client@holdco.test", "subject": "Renewal quote for Acme", "messageId": "<quote-4711@holdco.test>", "text": "Hi - can you send over the renewal quote for the Acme account before Friday?\nThanks!" }
EOF

echo "waiting for both cards to be drafted…"
for i in $(seq 1 30); do
	count=$(find "$BOARD/cards" -name 'in-*.md' 2>/dev/null | wc -l)
	[ "$count" -ge 2 ] && break
	sleep 1
done

echo
echo "── drafted cards ───────────────────────────────────────"
for f in "$BOARD/cards"/in-*.md; do
	echo "=== $f"
	sed -n '1,14p' "$f"
	echo
done

# 4. dedupe: re-flag the email unseen (redelivery) → still exactly 2 cards
cat > "$CTRL/mail-2.json" <<'EOF'
{ "from": "client@holdco.test", "subject": "Renewal quote for Acme", "messageId": "<quote-4711@holdco.test>", "text": "Hi - can you send over the renewal quote for the Acme account before Friday?\nThanks!" }
EOF
sleep 4
count_after=$(find "$BOARD/cards" -name 'in-*.md' 2>/dev/null | wc -l)

discord_card=$(grep -l 'source_type: "discord-message"' "$BOARD/cards"/in-*.md 2>/dev/null | head -1)
email_card=$(grep -l 'source_type: "email"' "$BOARD/cards"/in-*.md 2>/dev/null | head -1)
ok=1
[ -n "$discord_card" ] && grep -q 'drafter: "connector:discord"' "$discord_card" && grep -q 'surfaced_by: "shaurya"' "$discord_card" && grep -q 'status: Draft' "$discord_card" || ok=0
[ -n "$email_card" ] && grep -q 'drafter: "connector:imap"' "$email_card" && grep -q 'surfaced_by: "client@holdco.test"' "$email_card" && grep -q 'quote-4711' "$email_card" || ok=0
[ "$count_after" -eq 2 ] || ok=0

echo
if [ "$ok" = 1 ]; then
	echo "✅ M7 LIVE PROOF PASSED - Discord message + email each drafted exactly one card with full provenance; redelivered email deduped ($count_after cards total)."
	echo "   board kept at $BOARD (inspect, then delete)"
else
	echo "❌ M7 LIVE PROOF FAILED - cards: $count_after, discord: ${discord_card:-none}, email: ${email_card:-none}"
	tail -20 "$BOARD/daemon.log"
	exit 1
fi

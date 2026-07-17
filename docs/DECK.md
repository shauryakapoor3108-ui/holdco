# Deck data contract

The deck UI (built externally against this contract, then ported in) consumes
**one data source**: the holdco observability server (`holdco obs`). This
document is the contract — treat changes to it as data-contract changes
(schema + fixtures in the same PR, see [ARCHITECTURE.md](ARCHITECTURE.md)),
not drive-by edits.

All fixtures and demo feeds are **synthetic** — never derived from real cards,
sessions, or transcripts.

## Server & auth

```
holdco obs [--port N] [--db PATH] [--token T]     # default port 43190
```

Every route except `/health` requires auth: `Authorization: Bearer <token>` or
`?token=<token>` (use the query form for `EventSource`, which cannot set
headers).

## Endpoints

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | liveness: `{ok, version, uptime_s, stage_events_total}` (no auth) |
| `/stage-events` | POST | ingest one event or an array; each is schema-validated; `{ingested, rejected, errors?}` |
| `/stage-events?run_id=&card_id=&limit=` | GET | stored events, ascending `seq` |
| `/runs?limit=` | GET | per-run rollup: `{run_id, card_id, first_ts, last_ts, cost_usd, tokens_in, tokens_out, last_status, event_count}` |
| `/stage-events/stream?run_id=&card_id=` | GET (SSE) | live feed: `event: stage` frames with a StageEvent JSON payload; `retry:` + `event: hello` on connect; `: ping` heartbeat every 15s |

## StageEvent shape

Authoritative schema: `schema/stage-event.schema.json` (strict —
`additionalProperties: false`). Fields:

| Field | Type | Notes |
|---|---|---|
| `run_id` | string | see grouping below |
| `card_id` | string | THE grouping key for deck surfaces |
| `node_id` | string | stable node identity within a run (flow-map node) |
| `node_type` | `agent` \| `deterministic` \| `gate` | flow-map node kind |
| `stage` | string | `classify`, `worker`, `harvest`, `human-gate:approval`, `human-gate:review` today; open set |
| `harness` | string \| null | `pi` / `claude-code` / … — null for deterministic + gate nodes. The ONLY field allowed to differ between harnesses (parity rule) |
| `model` | string? | model id driving an agent node |
| `tier` | `workhorse` \| `frontier`? | routing decision |
| `status` | `started` \| `progress` \| `passed` \| `failed` \| `awaiting_human` | node status |
| `prompt_ref` | string? | path of the exact prompt artifact (inspector: Prompt tab) |
| `payload_ref` | string? | path of the produced artifact, e.g. `card.diff` (inspector: Work tab) |
| `usage` | `{tokens_in, tokens_out, cost_usd}`? | spend (inspector: Spend tab) |
| `ts` | string | ISO timestamp |

## Grouping conventions

- **Group by `card_id`.** A card's flow map is every event with its `card_id`,
  ordered by `seq` (server-assigned, monotonic; use it, not `ts`, for order).
- `run_id` distinguishes spawns: engine-level events (gates, classify) carry
  `run_id = card_id`; each worker spawn carries a per-run nonce
  (`<card>-<nonce>`), so a re-executed card shows two worker runs.
- A flow-map **node** is a distinct `node_id`; its state is the LATEST event
  for that node (`started`/`progress` → spinner, `passed` → tick, `failed` →
  cross, `awaiting_human` → amber pause).

## Surface mapping

- **Attention rail** — cards whose latest gate node event is `awaiting_human`
  (stage names the ask: `human-gate:approval` = approve plan,
  `human-gate:review` = review result). Spend-so-far = the run rollup's
  `cost_usd`; tier/model badges from the latest worker/classify event.
- **Flow map (per card)** — nodes in first-seen `seq` order:
  `approval-gate → classify → worker → harvest → review-gate` today. Agent,
  deterministic, and gate nodes are all first-class.
- **Node inspector** — from the node's latest event: `prompt_ref` (prompt tab),
  `payload_ref` (work tab), `usage` (spend tab), `model`/`tier`/`harness`
  badges.
- **Kanban** — column state comes from the card board itself (the `cards/`
  dir via the engine), NOT from telemetry. In demo mode the deck may derive an
  approximate column from the latest gate/worker event.
- **Parity rule** — the same card run under `pi` and `claude-code` produces
  identical sequences modulo the `harness` field. Render identically modulo
  the harness badge; a difference anywhere else is an engine bug (and
  test-enforced upstream).

## Demo mode

```
holdco obs --port 43190 --token demo
holdco replay --obs-url http://127.0.0.1:43190 --obs-token demo --speed 4
```

`deck/fixtures/demo-board.jsonl` replays a synthetic five-card board: a
parity pair (same card shape on `claude-code` and `pi`), a frontier plan card
parked at approval, a watchdog failure, and a budget kill. Timestamps are
re-anchored to now with relative pacing preserved (gaps capped at 5s;
`--speed 0` = no pacing).

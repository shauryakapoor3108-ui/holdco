# holdco

**A harness-agnostic engine for running real work through AI agents — where the durable asset is the context layer, not the model.**

**Own the context layer, rent the intelligence.** Your board, your gates, your safety policy, your routing table, your telemetry — all plain files you govern. The model behind each worker is a config entry.

> Early public release. The engine, seams, and conformance suites below are implemented and tested; the deck UI is still in flight. Version numbers start at 0.

## Who this is for

Engineers building multi-agent systems who refuse to marry a harness or a model vendor. If you want your orchestration, human gates, write-guards, cost routing, and telemetry to survive swapping Claude Code for Pi for Codex — and a frontier model for a workhorse — this is the layer you own. It's plain Node and plain markdown: no framework, no runtime dependencies, no lock-in.

## The thesis

1. **60/30/10** — 60% dumb infrastructure, 30% orchestration, 10% AI. Models are fuel and fuel commoditizes; the context layer survives every model swap.
2. **Context engineering > prompting** — the durable asset is engineered structure: routing tables, per-card workspaces, constraint files, filed knowledge artifacts.
3. **Human-by-exception** — every work item is a markdown card running a guarded state machine. Humans hold gates only where judgment matters; the engine can never skip one — illegal transitions auto-revert. Every loop closes into a filed artifact, nothing evaporates into chat history.
4. **Harness-agnostic** — the engine doesn't care whether the worker is Pi, Claude Code, or Codex. Coding harnesses plug in on the execution side, connectors (email, Discord) plug in on the intake side, and the engine sits in the middle enforcing the same policy natively on every side.

```
  intake connectors                                  coding harnesses
  ─────────────────          ┌────────────┐          ────────────────
  email (IMAP)  ──┐          │            │          ┌── Pi
  Discord       ──┼── cards ─►   engine   ─ workers ─┼── Claude Code
  telemetry     ──┘          │            │          └── Codex (pluggable)
                             └─────┬──────┘
                                   │ StageEvents (SSE)
                             ┌─────▼──────┐
                             │    deck    │  attention rail · kanban · flow map
                             └────────────┘
```

Deep dives: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/HARNESSES.md](docs/HARNESSES.md) · [docs/ROUTING.md](docs/ROUTING.md) · [docs/DECK.md](docs/DECK.md)

## Quickstart

Requires Node ≥ 24 and the [`claude` CLI](https://claude.com/claude-code) installed + authenticated. No dependencies to install.

```bash
git clone <this-repo> holdco
mkdir my-board && cd my-board && git init -b main
git commit --allow-empty -m init

# 1. run the engine (scaffolds cards/ + knowledge/ on first boot)
node ../holdco/src/cli.ts serve --sweep-ms 1000

# 2. in another terminal: drop a card at the human gate
cat > cards/hello.md <<'EOF'
---
type: card
id: hello
title: "First card"
status: Needs Approval
card_type: maintenance
---

## Brief
Create a file HELLO.md containing one line: `hello from holdco`.

## Reconciler Log
EOF

# 3. approve it — that's the only human step
node ../holdco/src/cli.ts move hello Queued
```

Within a few seconds the daemon classifies the card (cheap model → workhorse tier), cuts an isolated git worktree, runs a headless Claude Code worker in it with the safety policy hooked in natively, and lands the card at `Needs Review` with the harvested diff, outcome, and cost written onto it. `cat cards/hello.md` to see everything. Add `--obs-url` + `holdco obs` for live StageEvent telemetry.

## What's real today

Everything below is implemented in this tree, covered by `npm test` (plain Node, no test framework, no dependencies), and exercised end-to-end by the live proof scripts in `scripts/`.

- **State machine** (`src/engine/state-machine.ts`) — the legal-transition matrix: 8 live columns + 4 sinks, per-edge actor permissions (`human` / `engine`), goal-DAG holding column. Illegal transitions auto-revert.
- **Cards are markdown** (`src/engine/frontmatter.ts`) — the board is a directory of `.md` files; status writes are field-preserving and line-scoped. Any editor is a client.
- **Reconciler** (`src/engine/reconciler.ts`) — snapshot-diff sweep detects human moves, enforces the matrix, quarantines invalid cards, recovers orphaned executions on restart.
- **Worker isolation** (`src/engine/git-ops.ts`, `src/engine/workspace-manager.ts`) — per-card git worktrees; merge-back diffs against creation base (not HEAD) so committed and uncommitted worker output both land; capped concurrency, crash-resume, startup reaper.
- **Worker pool + orchestrator** (`src/engine/worker-pool.ts`, `src/engine/orchestrate.ts`) — N-slot dispatch through the Harness seam; per-run budget kill, activity watchdog, circuit breaker; human pull-backs always win the drain race.
- **Harness seam** (`src/harness/`) — the `spawn / inject / poll / collect / dispose` contract, a shipped conformance suite, and one policy evaluator enforced natively per harness: **Claude Code** (headless sessions, PreToolUse hook guard), **Pi** (herdr panes, tool-call guard extension), **Codex** (documented stub — pass conformance to finish it). See [docs/HARNESSES.md](docs/HARNESSES.md).
- **Unified knowledge layer** (`src/knowledge/store.ts`) — one governed `knowledge/` dir per board: single-source `constraints.md` rendered into every worker on every harness (conformance-tested), single-source `permissions.json` enforced natively per harness (fail-safe: a broken config narrows authority, never widens it), per-card append-only message logs.
- **Classifier + cost routing** (`src/routing/`) — cheap-model triage answers delegation / complexity / outcome per card; `knowledge/routing.json` maps class → tier (`chore → workhorse`, `plan → frontier`). Decision lands on the card as provenance; a human-pinned `model:` always wins; a dead classifier degrades to deterministic rules. See [docs/ROUTING.md](docs/ROUTING.md).
- **Intake connectors** (`src/connectors/`) — `subscribe → normalize → draft card w/ provenance`. Discord (REST polling) + IMAP (minimal IMAP4rev1 over TLS) ship, with a conformance suite as the acceptance bar for Slack/Telegram/webhook contributions. Drafted cards land at Draft — nothing executes until a human promotes them.
- **Telemetry + observability server** (`src/telemetry/`, `src/obs/`) — StageEvents emitted at the harness boundary (identical sequences regardless of adapter — test-enforced parity); `holdco obs` ingests schema-validated events into SQLite and fans them out over SSE.
- **Versioned schemas** (`schema/`) — JSON Schemas for every data contract (card frontmatter, StageEvent, filing artifact, constraints, permissions, routing), fixture-validated in CI by a zero-dep validator.

## Roadmap

- [ ] **Deck UI** — attention rail, kanban, live flow map with per-node prompt/spend inspection. Builds externally against the frozen data contract in [docs/DECK.md](docs/DECK.md); `holdco replay` feeds it a synthetic demo board today.
- [ ] **Codex adapter** — the stub ships with an implementation sketch; the conformance suite is the finish line.
- [ ] **Safety-policy conformance expansion** — broader path-scoped write-guard coverage, enforced natively per harness.

Run the tests: `npm test`. Typecheck: `npm run typecheck`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

## Credits & prior art

holdco grew out of a production system built on **Pi** (`pi-coding-agent`, by Mario Zechner) — a lean, extensible coding-agent substrate whose extension model shaped the seams here. The Pi harness adapter targets it directly, with **herdr** as the pane transport. The intellectual lineage is public and old: Doug Engelbart's augmentation thesis — the machinery around the intelligence is what compounds — and the "thin AI, thick infrastructure" school of agent design that the 60/30/10 split encodes. Thanks to all of it.

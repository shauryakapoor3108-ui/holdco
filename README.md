# holdco

**An operating system for running multiple businesses with AI agents — where the durable asset is engineered context, not the model.**

> ⚠️ Work in progress. Extracted from a private production system; public v1 lands module by module. Watch the repo.

## Thesis

**Own the context layer, rent the intelligence.**

1. **60/30/10** — 60% dumb infrastructure, 30% orchestration, 10% AI. Models are fuel and fuel commoditizes; the context layer survives every model swap.
2. **Context engineering > prompting** — the durable asset is engineered structure: routing tables, per-domain workspaces, constraint files, filed knowledge artifacts.
3. **Human-by-exception** — every work item runs a state-machine lifecycle (`intent → plan → verify → execute → review → file`). Humans hold gates only where judgment matters. Every loop closes into a filed artifact — nothing evaporates into chat history.
4. **Harness-agnostic** — the engine doesn't care whether the worker is Pi, Claude Code, or Codex. Coding harnesses plug in on the execution side, connectors (email, Discord, telemetry) plug in on the intake side, and the engine sits in the middle.

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

## What exists today

- **State machine** (`src/engine/state-machine.ts`) — the legal-transition matrix: 8 live columns + 4 sinks, per-edge actor permissions (`human` / `engine`), goal-DAG holding column. The engine can never skip a human gate — illegal transitions auto-revert.
- **Frontmatter engine** (`src/engine/frontmatter.ts`) — cards are plain markdown notes; status writes are field-preserving and line-scoped. Your kanban is a directory of `.md` files.
- **Reconciler** (`src/engine/reconciler.ts`) — snapshot-diff sweep detects human moves, enforces the matrix, quarantines invalid cards, recovers orphaned executions on restart.
- **Git ops** (`src/engine/git-ops.ts`) — worker isolation via git worktrees; merge-back diffs against creation base (not HEAD) so committed and uncommitted worker output both land.
- **Owner lease** (`src/engine/owner-lease.ts`) — single-owner guard; two engines can't fight over one board.
- **Goal DAG** (`src/engine/goal-dag.ts`) — cards with `depends_on` rest in a holding column until their dependency graph files; cycles rejected at admission.
- **Workspace manager** (`src/engine/workspace-manager.ts`) — per-card scoped dir + git worktree at intake, capped concurrency with a deferred-intake queue, idempotent crash-resume, startup reaper.
- **Worker pool** (`src/engine/worker-pool.ts`) — N-slot dispatch of execution-only workers into isolated worktrees, driven through the Harness seam; per-run budget kill, activity watchdog, circuit breaker, unified git-diff harvest written back to the card.
- **Harness adapters** (`src/harness/`) — the `spawn / inject / poll / collect / dispose` contract (`types.ts`), a shipped conformance suite (`conformance.ts`), one policy evaluator enforced natively per harness (`policy.ts`): **Claude Code** (headless sessions, PreToolUse hook guard), **Pi** (herdr panes, tool-call guard extension), **Codex** (documented stub — pass conformance to finish it).
- **Orchestrator** (`src/engine/orchestrate.ts`) — the daemon glue: workspace at intake, queue drain into free slots (human pull-backs always win), teardown at terminal states.
- **Unified knowledge layer** (`src/knowledge/store.ts`) — ONE governed `knowledge/` dir per board: single-source `constraints.md` rendered natively into every worker on every harness (conformance-tested), single-source `permissions.json` enforced natively per harness (fail-safe: a broken config narrows authority, never widens it), and a per-card append-only message log — the substrate for v2 agent teams.
- **Classifier + model routing** (`src/routing/`) — a cheap-model triage stage answers delegation / complexity / outcome per card, and `knowledge/routing.json` maps its class to a model tier (`chore → workhorse`, `plan/review → frontier`). The decision lands on the card as provenance; a human-pinned `model:` always wins; a dead classifier degrades to deterministic rules, never blocks the board.
- **Schemas** (`schema/`) — versioned JSON Schemas for every data contract (card frontmatter, StageEvent, filing artifact, constraints, permissions, routing), fixture-validated in CI by a zero-dep validator.
- **Connectors** (`src/connectors/`) — the intake mirror of the harness seam: `subscribe → normalize → draft card w/ provenance {surfaced_by, source_type, source_ref, drafter}`. Discord (REST polling) + IMAP (minimal IMAP4rev1 over TLS) ship; a shipped conformance suite (`conformance.ts`) is the acceptance bar for Slack/Telegram/webhook contributions. Drafted cards land at Draft — nothing executes until a human promotes them; dedupe is deterministic on `source_ref`.
- **StageEvent telemetry + observability server** (`src/telemetry/`, `src/obs/`) — the engine emits deck telemetry at the harness boundary (gates, classify, worker, harvest — IDENTICAL sequences regardless of adapter; only the `harness` field differs, and a test enforces it). `holdco obs` ingests schema-validated events into SQLite and fans them out over SSE — the deck's data source.
- **Executor** (`src/engine/executor.ts`) — the single-slot inline dispatcher (the worker pool's REPL-hosted predecessor); usage accumulation, checkpoint heartbeats, outcome extraction.

Run the tests: `npm test` — no dependencies, plain Node ≥ 22.6.

## Roadmap to v1

- [x] `EngineHost` shim — engine runs standalone (daemon CLI), Pi becomes one shell of two
- [x] Worker orchestration standalone — executor / worker pool / workspace manager run against `EngineHost`
- [x] Harness adapter interface (`spawn / inject / poll / collect / dispose` + telemetry conformance)
- [x] Pi adapter (port) + Claude Code adapter (new) + Codex conformance stub — live-proven E2E: `holdco serve` drains a human approval into an isolated worktree, a headless Claude Code worker executes it with the policy hook blocking `git commit` natively, diff + usage/cost harvested back to the card (`scripts/live-m2-daemon.sh`)
- [x] Unified knowledge layer — one store for constraints / permissions / filing / per-card message logs, consumed by all harnesses (`scripts/live-m3-knowledge.sh`)
- [x] Task classifier + cost-aware model routing — cheap-model triage (delegation / complexity / outcome), config-driven tiers in `knowledge/routing.json`, decision written onto the card; live-proven: a chore card auto-ran on the workhorse tier at ~1/5 the cost (`scripts/live-m5-routing.sh`)
- [x] StageEvent telemetry at the adapter boundary + observability server (SQLite + SSE) — live-proven: a real run's full event sequence stored queryably and delivered over SSE (`scripts/live-m6-telemetry.sh`)
- [x] Connector interface + Discord + IMAP reference implementations — live-proven: a Discord message and an email each drafted exactly one provenance-stamped card through the running daemon; redelivery deduped (`scripts/live-m7-intake.sh`)
- [x] Deck data contract — `docs/DECK.md` + synthetic demo fixture + `holdco replay` demo feed over live SSE (`scripts/live-m8-deck-feed.sh`); the deck UI builds externally against this contract
- [ ] Deck UI: attention rail, kanban, live flow map with per-node prompt/spend inspection (separate build track against `docs/DECK.md`)
- [ ] Safety policy conformance (path-scoped write guards, enforced natively per harness)

## License

MIT

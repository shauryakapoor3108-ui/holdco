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

Run the tests: `npm test` — no dependencies, plain Node ≥ 22.6.

## Roadmap to v1

- [ ] `EngineHost` shim — engine runs standalone (daemon CLI), Pi becomes one shell of two
- [ ] Harness adapter interface (`spawn / inject / poll / collect / dispose` + telemetry conformance)
- [ ] Pi adapter (port) + Claude Code adapter (new) + Codex conformance stub
- [ ] Task classifier + cost-aware model routing (chore → workhorse, plan/review → frontier)
- [ ] Connector interface + Discord + IMAP reference implementations
- [ ] Deck: attention rail, kanban, live flow map with per-node prompt/spend inspection
- [ ] Safety policy conformance (path-scoped write guards, enforced natively per harness)

## License

MIT

# Architecture

holdco is a reconciliation engine over a directory of markdown cards, with two
symmetric plug seams: **connectors** feed work in, **harnesses** execute work
out. The engine in the middle owns state, gates, isolation, budgets, and
telemetry - and is the *only* writer of card status.

```
connectors ──► cards/ (markdown) ──► engine ──► workers (via harness seam)
                                       │
                              knowledge/ (governed config)
                                       │
                              StageEvents ──► obs server ──► deck
```

## The card

The universal work primitive is a markdown file with YAML-ish frontmatter
(`type: card`, `id`, `title`, `status`, `card_type`) and body sections
(`## Brief`, `## Reconciler Log`). The board is the `cards/` directory; a
kanban UI, `holdco board`, or plain `ls` are all just views. Schema:
`schema/card-frontmatter.schema.json`.

## Lifecycle: state machine + reconciler

- `src/engine/state-machine.ts` - the legal-transition matrix. 8 live columns
  (`Draft, Held, Intake, Needs Approval, Queued, Executing, Needs Review,
  Filed`) + 4 sinks (`Archived`, `Quarantine`, `Filed (note)`,
  `Filed (intake)`). Every edge carries the actors allowed to make it
  (`human` / `engine`) - the engine has no edge through a human gate, so it
  *cannot* skip one.
- `src/engine/reconciler.ts` - snapshot-diff sweep over `cards/`. Detects
  human moves (file edits ARE the API), auto-reverts illegal transitions,
  quarantines invalid cards, recovers orphaned `Executing` cards on restart.
  A revert-loop breaker caps runaway revert storms per card.
- `src/engine/core.ts` - the loop: single-owner lease
  (`src/engine/owner-lease.ts` - two engines can't fight over one board),
  periodic sweep as the correctness layer, `fs.watch` as an optional latency
  hint only, lifecycle events (`card:queued`, `card:filed`, …) on the host bus.
- `src/engine/goal-dag.ts` - cards with `depends_on` rest in the `Held`
  column until their dependency graph files; cycles rejected at admission.

## Execution path

1. **Intake** - `src/engine/workspace-manager.ts` cuts a per-card scoped dir +
   git worktree (capped concurrency, deferred-intake queue, idempotent
   crash-resume, startup reaper).
2. **Classify** - the triage stage (`src/routing/`) routes the card to a model
   tier before any expensive worker spawns. See [ROUTING.md](ROUTING.md).
3. **Dispatch** - `src/engine/worker-pool.ts` runs N slots through the Harness
   seam: synchronous slot reservation (no TOCTOU double-allocation), per-run
   budget kill, activity watchdog, circuit breaker (max 3 spawns per card per
   session). See [HARNESSES.md](HARNESSES.md).
4. **Harvest** - the worker's worktree diff is taken against its *creation
   base*, not live HEAD (a worker may commit inside its worktree; a HEAD diff
   would silently lose the merge-back). Diff, outcome, usage, and cost are
   written back onto the card, which lands at `Needs Review`.
5. **Glue** - `src/engine/orchestrate.ts` wires it together as pure event
   plumbing: workspace at intake, queue drain into free slots (a human
   pull-back always beats the drain), teardown at terminal states.

`src/engine/executor.ts` is the single-slot inline predecessor of the pool;
it still owns outcome extraction and instruction reading.

## The seams

- **EngineHost** (`src/host/host.ts`) - everything the engine needs from its
  runtime, behind one interface: `events` (bus with disposer-returning `on`),
  `log`, `config` (flag > env > default), `notify`. The standalone daemon
  (`src/cli.ts serve`) implements it natively; a Pi extension shell implements
  it over Pi's ExtensionAPI. The engine never imports a runtime directly.
- **Harness** (`src/harness/types.ts`) - `spawn / inject / poll / collect /
  dispose`. Adapters own transport; the pool owns everything harness-neutral.
  Shipped: Claude Code, Pi, Codex stub. Conformance suite included.
- **Connector** (`src/connectors/types.ts`) - the intake mirror:
  `subscribe → normalize → draft card w/ provenance {surfaced_by, source_type,
  source_ref, drafter}`. Drafting is engine-side (`drafter.ts`) so every
  connector's cards look identical; dedupe is deterministic on `source_ref`.
  Shipped: Discord (REST polling), IMAP (minimal IMAP4rev1 over TLS).
  Conformance suite included (`src/connectors/conformance.ts`).
- **Knowledge layer** (`src/knowledge/store.ts`) - one governed `knowledge/`
  dir per board: `constraints.md` (rendered natively into every worker on
  every harness), `permissions.json` (the safety-policy source, enforced
  natively per harness), `routing.json` (model tiers), `FILING.md`, and
  per-card append-only message logs (`messages/<id>.jsonl`).
- **Telemetry** (`src/telemetry/stage-events.ts`, `src/obs/`) - StageEvents
  emitted at the harness boundary; sinks are fire-and-forget (a dead telemetry
  pipe degrades to silence, never blocks the board). `holdco obs` = SQLite
  ingest + SSE fan-out. Wire contract: [DECK.md](DECK.md).

## Invariants

These are the load-bearing rules, all test-enforced:

- **Single writer** - the engine is the sole writer of `status`; workers write
  only inside their worktree; humans move cards by editing files.
- **Loop suppression** - every engine `writeStatus` pairs with a synchronous
  snapshot update, so the reconciler never re-detects its own write as a
  human move.
- **`poll()` never throws** - a transport hiccup is a verdict
  (`unknown`), never a crash of the sweep; the watchdog decides.
- **Fail-safe config** - malformed `permissions.json` or `routing.json` falls
  back to defaults that *narrow* authority, never widen it.
- **Harness parity** - the same card produces identical StageEvent sequences
  on every harness, modulo the `harness` field (test-enforced).
- **Publishing is a human gate** - workers are natively blocked from
  `git commit/push/merge/…`; the engine harvests the uncommitted worktree.

## Layout

```
src/engine/      state machine, reconciler, pool, workspaces, git ops, glue
src/host/        EngineHost seam + standalone daemon host
src/harness/     Harness contract, adapters, policy evaluator, conformance
src/connectors/  Connector contract, Discord + IMAP, drafter, conformance
src/knowledge/   the governed knowledge store
src/routing/     classifier + routing table
src/telemetry/   StageEvent types + sinks
src/obs/         observability server (node:http + node:sqlite, SSE)
src/cli.ts       holdco serve | obs | replay | board | move
schema/          versioned JSON Schemas + fixtures for every data contract
tests/           one plain-Node test file per module (npm test)
scripts/         live end-to-end proof scripts (live-m2 … live-m8)
```

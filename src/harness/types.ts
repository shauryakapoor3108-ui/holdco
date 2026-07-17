// types.ts — the Harness contract: the seam that makes the engine harness-agnostic.
//
// A Harness adapts one coding-agent runtime (Pi, Claude Code, Codex, …) to five
// verbs: spawn / inject / poll / collect / dispose. The engine (worker pool) owns
// everything harness-neutral — slot accounting, circuit breaker, budget kill,
// watchdog, the unified git-diff harvest, board-state writes. The adapter owns
// transport mechanics: how a worker is launched into a workspace, how its brief is
// delivered (including the adapter's own completion contract), how liveness and
// completion are observed, and how usage/cost + transcript references are
// harvested. Telemetry is part of the contract, not an add-on: an adapter that
// cannot report usage and transcript refs fails conformance.
//
// Two hard rules, carried from the source system's transport adapter:
//   1. poll() RETURNS a value, never throws. A transport hiccup must not crash
//      the engine's sweep — report "unknown" and let the watchdog decide.
//   2. Every write the worker makes lands inside its per-card workspace; the
//      SafetyPolicy is enforced NATIVELY per harness (Pi → tool-call guard
//      extension; Claude Code → PreToolUse hook; Codex → its sandbox config).
//      Same policy, native enforcement — conformance demonstrates the block.

/** Where a worker runs: the per-card git worktree + its metadata dir. */
export interface HarnessWorkspace {
	cardId: string;
	/** Absolute path to the per-card git worktree (the worker's cwd + write scope). */
	dir: string;
	/** Absolute path to the per-card scoped dir (task.md, transcripts, card.diff). */
	scopedDir: string;
}

/** Path-scoped write guard + command bans, enforced natively by each adapter.
 *  (The single-source policy FILE that renders into this shape arrives with the
 *  unified knowledge layer; adapters consume this resolved object.) */
export interface SafetyPolicy {
	/** Writes are allowed ONLY under these absolute dirs (the worktree, its scoped dir). */
	writeScopes: string[];
	/** Shell-command patterns hard-blocked regardless of path (regex source strings). */
	denyCommands: string[];
}

/** The default deny list: a worker must never publish or rewrite history — the
 *  engine harvests its UNCOMMITTED worktree diff, so commits/pushes/merges from
 *  inside a worker break the merge-back contract (and pushing is a human gate). */
export const DEFAULT_DENY_COMMANDS: readonly string[] = [
	"\\bgit\\s+push\\b",
	"\\bgit\\s+commit\\b",
	"\\bgit\\s+merge\\b",
	"\\bgit\\s+rebase\\b",
	"\\bgit\\s+reset\\s+--hard\\b",
	"\\bgit\\s+apply\\b",
];

export interface SpawnRequest {
	workspace: HarnessWorkspace;
	/** The card's executable instruction (brief + human corrections), WITHOUT any
	 *  completion contract — the adapter appends its own transport-appropriate one. */
	instruction: string;
	/** Card metadata the adapter's prompt template may use. */
	card: { id: string; domain: string; cardType: string };
	/** Per-spawn correlation nonce (telemetry tags, transcript naming). */
	runId: string;
	/** Model id for the worker, when the harness supports selection. */
	model?: string;
	policy: SafetyPolicy;
	/** Single-source constraints text (knowledge/constraints.md). The adapter MUST
	 *  render it into the worker's delivered context natively (system injection,
	 *  task preamble, …) and expose the rendered form via session.constraintsRef.
	 *  Conformance-tested. */
	constraints?: string;
}

/** Opaque per-run handle. Adapters may attach private state via subtyping;
 *  the engine treats it as a token to pass back to the other four verbs. */
export interface HarnessSession {
	harness: string;
	cardId: string;
	runId: string;
	/** Absolute path of the prompt artifact the adapter wrote (task.md / prompt.md). */
	promptRef: string;
	/** Absolute path of the RENDERED constraints delivered to the worker (when
	 *  the spawn request carried constraints). Null/absent when none were given. */
	constraintsRef?: string | null;
	startedAt: number;
}

export type SessionState =
	| "starting" // spawned, worker not yet confirmed working
	| "working" // alive and progressing
	| "done" // completion observed; collect() will yield artifacts
	| "failed" // terminal transport/worker failure (never coming back)
	| "unknown"; // transport could not answer THIS poll — not a verdict

/** One non-blocking liveness/usage snapshot. Edge-safe: never throws. */
export interface PollResult {
	state: SessionState;
	/** Best-known accumulated spend (engine's budget kill reads this). Omit when unknown. */
	costUsd?: number;
	/** Epoch ms of the last observed worker activity (engine's watchdog reads this). */
	lastActivityAt?: number;
}

export interface HarnessUsage {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
}

/** What collect() must return — the telemetry half of the contract. */
export interface HarnessArtifacts {
	/** The worker's `OUTCOME:` line, or a truncated fallback of its final output. */
	outcome: string;
	/** Tail of the worker's final output (review evidence). */
	outputTail: string;
	/** Usage rollup; null = telemetry genuinely unavailable (flagged on the card). */
	usage: HarnessUsage | null;
	/** Absolute path to the durable transcript artifact (session log / pane snapshot). */
	transcriptRef: string | null;
	/** Absolute path to the prompt artifact (mirrors session.promptRef). */
	promptRef: string;
	/** Worker-reported error count, when the transport exposes one. */
	errorCount?: number;
}

export interface Harness {
	/** Stable adapter id — lands on cards, StageEvents, and the deck's harness badge. */
	readonly name: string;

	/** Launch a worker on the workspace. Resolves once the worker is running with
	 *  its brief delivered (or rejects — spawn is the ONE verb allowed to throw). */
	spawn(req: SpawnRequest): Promise<HarnessSession>;

	/** Deliver a mid-run message (steer/correction). False = could not deliver. */
	inject(session: HarnessSession, message: string): Promise<boolean>;

	/** Non-blocking status probe. NEVER throws; a transport failure is {state:"unknown"}. */
	poll(session: HarnessSession): Promise<PollResult>;

	/** Harvest telemetry + refs after poll() reported "done" (or on escalation —
	 *  collect() must degrade gracefully mid-run: usage null, best-effort tail). */
	collect(session: HarnessSession): Promise<HarnessArtifacts>;

	/** Tear the worker down (kill process / close pane) and persist the transcript
	 *  snapshot into the scoped dir. Idempotent; never throws. */
	dispose(session: HarnessSession): Promise<void>;
}

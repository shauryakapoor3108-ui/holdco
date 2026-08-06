// types.ts - shared types for the card-engine transition engine (Phase 2).
//
// The card is the universal work primitive: a markdown note with `type: card`
// frontmatter whose `status` field is the canonical lifecycle state. The Base
// Kanban view is a live reactive view over that frontmatter (no mirror - ADR
// Addendum e). This engine reconciles the frontmatter to detect/guard moves.

/**
 * The 8 legal lifecycle columns (the guarded state machine). AL Slice 1 removed
 * the two dead human gates `Needs Greenlight` + `Brief`: planning now happens at
 * `Intake` and the human reviews a verified plan at `Needs Approval` (the
 * Plan-Review gate - relabel deferred to a later cosmetic slice). The goal-system
 * ADR (Held state & dependency DAG) adds `Held` at index 1 - a live holding column
 * (like `Queued`), NOT a sink: goal cards rest here after `/commit-goal` until their
 * `depends_on` DAG is `Filed`, then the goal-gate reactor releases each to `Intake`.
 */
export const LEGAL_COLUMNS = [
	"Draft",
	"Held", // goal system: goal cards rest here after /commit-goal until deps Filed; a live, human-visible holding column, NOT a sink
	"Intake",
	"Needs Approval",
	"Queued", // D1: approved and waiting its turn to execute - a live, human-visible column, NOT a sink
	"Executing",
	"Needs Review",
	"Filed",
] as const;

/**
 * D5: the note-capture SUCCESS terminal. A valid `status` that lives OUTSIDE the
 * guarded execution machine, modelled on the SINK_STATES discipline (terminal,
 * human-only exit, the engine NEVER auto-moves a card out of it - recovery is a
 * deliberate human edit, exactly like de-quarantine). It is distinct from
 * `Archived` (discard) and `Quarantine` (error): `Filed (note)` is where a
 * `note`-type card (`tierOf === null`, non-executing) comes to rest, kept on
 * purpose. The cross-axis rule that ONLY a note-type card may ENTER it is NOT in
 * this file or the adjacency table - it lives in the reconciler (read `card_type`
 * at detect time, mirroring Tier-2 auto-advance). See reconciler.ts step 5.
 */
export const FILED_NOTE = "Filed (note)";

/**
 * Out-of-band sink states: valid `status` values, but OUTSIDE the guarded
 * machine. `Archived` = discard terminal; `Quarantine` = error sink;
 * `Filed (note)` = the D5 note-success terminal. The engine does not auto-move
 * cards out of a sink - only an explicit human edit recovers one (manual
 * recovery, not auto-de-quarantine; see reconciler step 4). `isSink` therefore
 * means "out-of-funnel, terminal, human-only exit" - not strictly "error/discard".
 */
/** S3: `Filed (intake)` is the intake-success terminal - a valid `status` OUTSIDE the
 * guarded execution machine, exactly like `Filed (note)`. An intake-type card
 * (`card_type: "intake"`) comes to rest here after its raw material is processed. The
 * cross-axis rule that ONLY an intake-type card may ENTER it lives in the reconciler. */
export const FILED_INTAKE = "Filed (intake)";

export const SINK_STATES = ["Archived", "Quarantine", FILED_NOTE, FILED_INTAKE] as const;

export const ALL_STATUSES = [...LEGAL_COLUMNS, ...SINK_STATES] as const;

export type CardStatus = (typeof ALL_STATUSES)[number];

export type Actor = "human" | "agent" | "engine";

/** Sentinel for a card whose status is missing / empty / unrecognized. */
export const INVALID = "(invalid)";

// ── Card-type governance taxonomy (D3) ───────────────────────────────────────
// A SEPARATE axis from `status`: `status` is the lifecycle column; `card_type`
// is the governance class that decides the approval tier. This file is the
// single source of truth for the taxonomy + the tier map (spec §2). Read-only
// from the front door's perspective - the engine never WRITES card_type.

/** The 7 legal card types (the governance taxonomy). `note` is reserved for D5; `intake` is the S3 raw-link lane. */
export const CARD_TYPES = ["strategy", "ops", "content", "research", "maintenance", "note", "intake"] as const;

export type CardType = (typeof CARD_TYPES)[number];

export function isValidCardType(s: string): s is CardType {
	return (CARD_TYPES as readonly string[]).includes(s);
}

/**
 * `card_type` → governance tier. THE single source of truth (spec §2). The map
 * is total over `CardType` (compiler-enforced via `Record<CardType, …>`).
 * Tier 1 = explicit human approval; Tier 2 = engine auto-advances (D1);
 * `null` = non-executing (`note`, the D5 lane).
 */
export const CARD_TYPE_TIER: Record<CardType, 1 | 2 | null> = {
	strategy: 1,
	ops: 1,
	content: 2,
	research: 2,
	maintenance: 2,
	note: null,
	intake: null,
};

/**
 * Read-time tier resolution (spec §3). A missing / "" / unrecognised `card_type`
 * resolves to **Tier 1 (conservative)** - NO file write, NO status change. A
 * card is therefore governed conservatively from birth until it is typed.
 */
export function tierOf(rawCardType: string): 1 | 2 | null {
	return isValidCardType(rawCardType) ? CARD_TYPE_TIER[rawCardType] : 1;
}

export interface CardScan {
	id: string; // frontmatter `id` || file basename
	file: string; // absolute path
	status: string; // a valid CardStatus, or INVALID
	rawStatus: string; // the original frontmatter value (for quarantine annotation)
	rawCardType: string; // the original `card_type` frontmatter value ("" if missing)
}

/** cardId -> last-known-legal status (the reconciliation snapshot). */
export type Snapshot = Map<string, string>;

export function isValidStatus(s: string): s is CardStatus {
	return (ALL_STATUSES as readonly string[]).includes(s);
}

export function isSink(s: string): boolean {
	return (SINK_STATES as readonly string[]).includes(s);
}

// ── Slice 2: lifecycle workspace types ─────────────────────────────────────────

/** Label prefix for per-card lifecycle workspaces (herdr workspace create --label). */
export const CARD_WORKSPACE_LABEL_PREFIX = "card-";

/** Per-card lifecycle workspace handle (in-memory, process-local). */
export interface WorkspaceHandle {
	cardId: string;
	/** herdr workspace id (Pi-adapter surface) - null in worktree-only mode. */
	workspaceId: string | null;
	paneId: string | null;
	scopedDir: string; // <scopedBase>/<id>
	worktreePath: string; // <scopedBase>/<id>/worktree (Slice 3: git worktree)
	baseCommit: string; // the commit the worktree was created from - the harvest diffs against THIS, not live HEAD (a worker may git commit)
	createdAt: number;
}

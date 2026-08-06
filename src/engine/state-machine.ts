// state-machine.ts - the legal-transition matrix.
//
// Transcribed from the Phase 2 matrix in tasks/sprint-1-build-plan.md (the
// source of truth). This is the adjacency the guard reads. Each edge carries
// the actor(s) permitted to make it. The goal-system ADR (Held state & dependency
// DAG) adds the `Held` holding column with the Draft↔Held / Held→Intake edges.

import { FILED_INTAKE, FILED_NOTE, type Actor } from "./types.ts";

// D5 CROSS-AXIS NOTE: the `→ Filed (note)` edges below are pure adjacency - legal
// human moves from the early / non-execution columns into the note-success
// terminal. Their legality is FURTHER gated by `card_type` in the reconciler:
// only a note-type card (`tierOf === null`) may actually enter `Filed (note)`; a
// non-note card dragged there fails the gate and hits the normal illegal-
// transition auto-revert. The adjacency table itself stays card_type-AGNOSTIC -
// the cross-axis policy lives in reconciler.ts step 5 (read card_type at detect
// time, exactly like Tier-2 auto-advance reads it in index.ts).

// AL Slice 1 - the autonomous-flow state machine. The two dead human gates
// `Needs Greenlight` + `Brief` are removed (planning happens at Intake now); the
// Tier-2 auto-advance is killed so EVERY card stops once at Needs Approval for a
// human (engine dropped from the Needs Approval → Queued edge); and the reject
// paths exist (Needs Approval → Intake re-plan; Needs Review → Executing rebuild /
// → Intake re-plan). The new edges already carry `engine` where Slice 3 will fire
// them automatically; this slice ships the behaviour and humans advance by hand.
//
// from -> (to -> actors permitted to make this transition)
const EDGES: Record<string, Record<string, Actor[]>> = {
	Draft: { Intake: ["human"], Held: ["human", "engine"], Archived: ["human"], [FILED_NOTE]: ["human"], [FILED_INTAKE]: ["human"] }, // human commits to Intake; Held = the /commit-goal batch write (engine, loop-suppressed) or a manual human add to a goal; Archived = discard; Filed (note) = note-only (reconciler-gated); Filed (intake) = intake-only (reconciler-gated)
	// Goal system (ADR: Held state & dependency DAG). Held is a live holding column, NOT a sink: a
	// goal card rests here after the loop-suppressed /commit-goal batch write until its depends_on DAG
	// reaches Filed. Intake = the goal-gate reactor's automatic release (engine, loop-suppressed via
	// goal:release) + a manual human override release; Draft = human pulls a card back OUT of the goal;
	// Archived = human drops it. NO edge past Intake - every released card re-enters the funnel at
	// Intake so the auto-planner plans it and BOTH AL human gates are preserved.
	Held: { Intake: ["engine", "human"], Draft: ["human"], Archived: ["human"] },
	// Planning happens HERE. The engine auto-advances after plan-gen + plan-verify SOUND (Slice 3
	// fires it); a human may advance manually meanwhile; Draft = park. (Needs Greenlight edge removed.)
	// S4b: auto-intaker adds [agent] edges here
	Intake: { "Needs Approval": ["human", "engine"], Draft: ["human"], [FILED_NOTE]: ["human"], [FILED_INTAKE]: ["human"], Quarantine: ["human"], Archived: ["human"] },
	// GATE 1 (Plan Review): Accept → Queued is HUMAN-ONLY - the Tier-2 auto-advance is REMOVED, so
	// every card waits here for a human. Reject → re-plan = Intake. (Brief edge removed; the Draft
	// reject edge is folded into Intake = the re-plan target.) Filed (note) = drifted-note escape.
	"Needs Approval": { Queued: ["human"], Intake: ["human"], Archived: ["human"], [FILED_NOTE]: ["human"] },
	// D1: Queued is the holding column. Draft = human pulls a card back OUT of the queue before it
	// drains; Executing = the drain pop (engine, loop-suppressed). (Brief pull-back edge removed.)
	Queued: { Executing: ["engine"], Draft: ["human"] }, // drain / pull-back
	Executing: { "Needs Review": ["agent", "engine"] }, // agent-owned (+ Slice-4 build-verify); human drags OUT are illegal
	// GATE 2 (Build Review): Accept → Filed; Reject → Rebuild = Executing (re-run the same approved
	// plan); Reject → Re-plan = Intake (the required escape valve when the plan itself was wrong →
	// back through Needs Approval for re-approval).
	// + Archived (["human"]) on the two post-plan states the pre-execution Archived edges
	// (Draft/Held/Intake/Needs Approval) can't reach: a stuck/abandoned Needs Review and an
	// obsolete Filed card - the dead-card discard the triage needed. Queued/Executing deliberately
	// get NO Archived edge: they hold a live queue slot / running worker, so archiving there would
	// orphan work - pull the card back (→ Draft) or let it complete first.
	"Needs Review": { Filed: ["human"], Executing: ["human"], Intake: ["human"], Archived: ["human"] },
	Filed: { Archived: ["human"] }, // terminal for the funnel (reopen = new card); Archived = human discard of a dead/obsolete Filed card
	[FILED_INTAKE]: {}, // terminal - reopen = new card
};

/**
 * Is `from -> to` a legal transition for `actor`?
 *
 * Provenance rule (build spec §State machine): every reconciler-DETECTED delta
 * is human-originated, because engine writes are loop-suppressed by snapshot-sync
 * and never appear as deltas. So the reconciler always calls
 * isLegal(from, to, "human"). The engine performs agent/engine-only edges (e.g.
 * Executing -> Needs Review on completion or orphan recovery) by writing directly
 * and syncing the snapshot, so reconciliation never sees them as deltas.
 */
export function isLegal(from: string, to: string, actor: Actor): boolean {
	const tos = EDGES[from];
	if (!tos) return false;
	const actors = tos[to];
	return !!actors && actors.includes(actor);
}

export function legalTargets(from: string): string[] {
	return Object.keys(EDGES[from] ?? {});
}

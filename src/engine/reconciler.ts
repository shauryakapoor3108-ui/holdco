// reconciler.ts - snapshot-diff reconciliation + state-machine guards.
//
// Built from the proven tasks/phase0/reconcile-watch.mjs logic (frontmatter
// parse + snapshot-diff). Differences: cards-only (no board-file/mirror per ADR
// Addendum e), and it ENFORCES - auto-revert on illegal, quarantine on invalid,
// orphan recovery on startup. Reconciliation is the correctness layer; fs.watch
// is an optional latency hint.

import * as fs from "node:fs";
import { join } from "node:path";
import { annotate, parseCard, readRawField, removeField, writeStatus } from "./frontmatter.ts";
import { isLegal } from "./state-machine.ts";
import { FILED_INTAKE, FILED_NOTE, INVALID, isSink, isValidCardType, isValidStatus, tierOf, type CardScan, type Snapshot } from "./types.ts";

export interface ReconcileEvent {
	event:
		| "TRANSITION"
		| "ILLEGAL_REVERT"
		| "REVERT_BREAKER_TRIPPED"
		| "QUARANTINE"
		| "DEQUARANTINE"
		| "NEW_CARD"
		| "REMOVED"
		| "ORPHAN_RECOVERED"
		| "CARD_TYPE_INVALID"
		| "CARD_TYPE_CLEARED";
	card: string;
	from?: string;
	to?: string;
	reason?: string;
	via?: string;
	file?: string; // absolute path of the card (set on TRANSITION - Phase 4 dispatch needs it)
}

export class Reconciler {
	readonly snapshot: Snapshot = new Map();

	// T2a layer 1: revert-loop breaker per card - tracks illegal-revert frequency so a
	// ghost/second reconciler storm caps at one flagged card instead of 106-in-10s.
	private readonly revertState = new Map<string, { count: number; firstTs: number; tripped: boolean }>();
	private readonly MAX_REVERTS = 5;
	private readonly REVERT_WINDOW_MS = 10_000;

	private readonly cardsDir: string;

	constructor(cardsDir: string) {
		this.cardsDir = cardsDir;
	}

	/** Reset revert tracking for a card (e.g. after the edge dissipates - test helper). */
	resetRevertState(id: string): void {
		this.revertState.delete(id);
	}

	/** Record one illegal-revert event and return true if the loop breaker should trip. */
	private recordRevert(id: string): boolean {
		const now = Date.now();
		let s = this.revertState.get(id);
		if (!s || (now - s.firstTs > this.REVERT_WINDOW_MS)) {
			s = { count: 1, firstTs: now, tripped: false };
			this.revertState.set(id, s);
			return false;
		}
		s.count++;
		if (s.count >= this.MAX_REVERTS) {
			s.tripped = true;
			return true;
		}
		return false;
	}

	/** Check whether the revert loop breaker is already tripped for this card. */
	private checkRevertBreaker(id: string): boolean {
		const s = this.revertState.get(id);
		if (!s) return false;
		const now = Date.now();
		if (now - s.firstTs > this.REVERT_WINDOW_MS) {
			this.revertState.delete(id);
			return false;
		}
		return s.tripped;
	}

	/** Scan the cards dir -> Map<cardId, CardScan>. Non-cards are ignored. */
	scan(): Map<string, CardScan> {
		const out = new Map<string, CardScan>();
		let files: string[] = [];
		try {
			files = fs.readdirSync(this.cardsDir).filter((f) => f.endsWith(".md"));
		} catch {
			return out; // dir missing -> empty (graceful: empty-vault boot, edge test 9)
		}
		for (const f of files) {
			const file = join(this.cardsDir, f);
			const card = parseCard(file);
			if (!card.isCard) continue; // template (type: card-template), READMEs, etc.
			const valid = card.status !== "" && isValidStatus(card.status);
			out.set(card.id, {
				id: card.id,
				file,
				status: valid ? card.status : INVALID,
				rawStatus: card.status,
				rawCardType: card.cardType,
			});
		}
		return out;
	}

	/**
	 * Startup orphan recovery - run BEFORE arming the loop and seeding nothing else.
	 * Any `Executing` card has no live execution at boot (Sprint 1 = blocking
	 * single-REPL) -> move to `Needs Review` + `interrupted: true`. Invalid cards
	 * are quarantined. Everything else seeds the snapshot at its current status.
	 */
	startupRecovery(): ReconcileEvent[] {
		const events: ReconcileEvent[] = [];
		for (const [id, cur] of this.scan()) {
			if (cur.status === "Executing") {
				writeStatus(cur.file, "Needs Review", {
					annotations: { interrupted: "true" },
					logLine: "orphan recovery: Executing → Needs Review (interrupted on restart)",
				});
				this.snapshot.set(id, "Needs Review");
				events.push({ event: "ORPHAN_RECOVERED", card: id, from: "Executing", to: "Needs Review" });
			} else if (cur.status === INVALID) {
				this.quarantine(id, cur, events, "startup");
			} else {
				this.snapshot.set(id, cur.status);
			}
		}
		return events;
	}

	/** One reconciliation pass. `via` is "sweep" (interval) or "event" (fs.watch). */
	reconcile(via: "sweep" | "event"): ReconcileEvent[] {
		const events: ReconcileEvent[] = [];
		const current = this.scan();

		for (const [id, cur] of current) {
			const prev = this.snapshot.get(id);

			// 0. Reconcile the `card_type` governance axis - NON-destructively (D3 §4 +
			//    D4 §6). Orthogonal to `status`: it only annotates / clears the
			//    `card_type_invalid` mark (never quarantines, never touches the status
			//    line), idempotent. `tierOf` already governs such a card, so this is
			//    audit-only.
			this.reconcileCardType(cur, events, via);

			// 1. Invalid frontmatter -> quarantine. Never silently skipped.
			if (cur.status === INVALID) {
				this.quarantine(id, cur, events, via);
				continue;
			}

			// 2. First sight -> seed snapshot (not a transition).
			if (prev === undefined) {
				this.snapshot.set(id, cur.status);
				// D4: carry `file` on NEW_CARD (mirroring TRANSITION/DEQUARANTINE) so the
				// index.ts emit can fire card:needs-approval for a Tier-1 card first-seen
				// AT Needs Approval (a created/dragged card that seeds the snapshot there
				// and emits no later delta - the Pi round-1 gap).
				events.push({ event: "NEW_CARD", card: id, to: cur.status, via, file: cur.file });
				continue;
			}

			// 3. No change.
			if (prev === cur.status) continue;

			// 4. Recovery OUT of a sink (Quarantine/Archived) - unguarded. A human
			//    explicitly moving the card to a valid status is accepted (manual
			//    recovery; the engine never auto-moves a card out of a sink).
			if (isSink(prev)) {
				this.snapshot.set(id, cur.status);
				events.push({
					event: prev === "Quarantine" ? "DEQUARANTINE" : "TRANSITION",
					card: id,
					from: prev,
					to: cur.status,
					via,
					// D1: carry the path on every TRANSITION route to Needs Approval so Tier-2
					// auto-advance (index.ts) has the file. Backward-compatible - existing
					// consumers ignore the extra field. (DEQUARANTINE deliberately carries it
					// too; the auto-advance filter keys on event === "TRANSITION", so a
					// Quarantine → Needs Approval recovery is NOT auto-advanced - see spec §4.)
					file: cur.file,
				});
				continue;
			}

			// 5. Guarded transition. Detected deltas are human-originated.
			//    D5 CROSS-AXIS GATE: `→ Filed (note)` is legal ONLY for a note-type card
			//    (`tierOf(card_type) === null`). The adjacency table permits the edge from
			//    Draft/Intake/Brief/Needs Approval; this guard couples it to `card_type` at
			//    detect time (read here, exactly like Tier-2 auto-advance reads it in
			//    index.ts - keeps `isLegal` a pure adjacency table). A non-note card dragged
			//    to `Filed (note)` therefore fails legality and falls through to the SAME
			//    illegal-transition auto-revert below - no new machinery, no approval-dodge.
			const noteGateOk = cur.status !== FILED_NOTE || cur.rawCardType === "note";
			// S3 CROSS-AXIS GATE: `→ Filed (intake)` is legal ONLY for an intake-type card.
			const intakeGateOk = cur.status !== FILED_INTAKE || cur.rawCardType === "intake";
			if (isLegal(prev, cur.status, "human") && noteGateOk && intakeGateOk) {
				this.snapshot.set(id, cur.status);
				events.push({ event: "TRANSITION", card: id, from: prev, to: cur.status, via, file: cur.file });
			} else if (isLegal(prev, cur.status, "engine") || isLegal(prev, cur.status, "agent")) {
				// T2a layer 2: a legal engine/agent edge (e.g. Queued→Executing) detected as a
				// delta means a ghost reconciler saw the live engine's loop-suppressed write.
				// Accept the edge by seeding the snapshot and emitting TRANSITION instead of
				// reverting - kills the ghost-revert class. A human cannot meaningfully drag
				// Queued→Executing in Obsidian, so accepting a legal-engine edge is safe.
				this.snapshot.set(id, cur.status);
				events.push({ event: "TRANSITION", card: id, from: prev, to: cur.status, via, file: cur.file });
			} else {
				// Illegal / skip -> auto-revert to last-legal (snapshot held at prev).
				// T2a layer 1: revert-loop breaker - suppress if this card has had too many
				// reverts in a short window (the ghost-reconciler storm). Caps a 106-in-10s
				// storm to a single flagged card.
				if (this.checkRevertBreaker(id)) {
					// Breaker already tripped: suppress the revert entirely (no writeStatus).
					// Events are still emitted so the event bus sees the delta but the card
					// file is not touched.
					events.push({
						event: "REVERT_BREAKER_TRIPPED",
						card: id,
						from: prev,
						to: cur.status,
						reason: `revert loop breaker tripped: ${this.revertState.get(id)?.count ?? 0} reverts in window`,
						via,
					});
				} else {
					writeStatus(cur.file, prev, {
						annotations: {
							reverted_from: cur.status,
							reverted_reason: `illegal transition ${prev} → ${cur.status}`,
						},
						logLine: `auto-revert: illegal ${prev} → ${cur.status}; restored to ${prev}`,
					});
					// snapshot stays at prev; our own write is loop-suppressed.
					this.recordRevert(id);
					events.push({
						event: "ILLEGAL_REVERT",
						card: id,
						from: prev,
						to: cur.status,
						reason: "illegal transition",
						via,
					});
				}
			}
		}

		// 6. Removed cards.
		for (const [id, prev] of this.snapshot) {
			if (!current.has(id)) {
				this.snapshot.delete(id);
				events.push({ event: "REMOVED", card: id, from: prev, via });
			}
		}

		return events;
	}

	/**
	 * Non-destructive, idempotent reconciliation of the `card_type` governance axis
	 * (D3 §4 + D4 §6). Status is NEVER touched on any branch (loop-suppressed).
	 *
	 * - **Valid** `card_type` → **D4 §6 clear:** if a stale `card_type_invalid` mark is
	 *   present on disk, `removeField` it + append an audit line + emit CARD_TYPE_CLEARED.
	 *   This fires for a valid value written by ANY writer - the desktop `/reclassify`
	 *   clears the mark inline (so this is then a no-op, belt-and-braces), but the future
	 *   mobile Meta Bind picker writes `card_type` frontmatter directly and relies on THIS
	 *   to clear+audit. It is **disk-state driven** (no in-memory previous-value tracking),
	 *   so it works even if the correction landed while the owner was down. Idempotent:
	 *   after the clear the mark is gone → the branch never fires again.
	 * - **Missing** ("") → nothing (a card emptied back to "" keeps any historical mark -
	 *   that is not a deliberate reclassify).
	 * - **Present-but-invalid** → a one-time `annotate(card_type_invalid)`, status
	 *   preserved (no quarantine). Idempotency gate (Pi round-4 flag #2): compare the
	 *   stored RAW marker against the exact serialized string we would write - robust to
	 *   embedded quotes/backslashes (a cleaned compare would re-write every 2s sweep).
	 */
	private reconcileCardType(cur: CardScan, events: ReconcileEvent[], via: string): void {
		const raw = cur.rawCardType;
		if (isValidCardType(raw)) {
			// D4 §6: clear a stale invalid mark left over from when this field was malformed.
			if (readRawField(cur.file, "card_type_invalid") !== null) {
				removeField(cur.file, "card_type_invalid");
				annotate(cur.file, {}, `card_type_invalid cleared: card_type now valid (${raw}) - reconciled (${via})`);
				events.push({ event: "CARD_TYPE_CLEARED", card: cur.id, to: raw, via });
			}
			return;
		}
		if (raw === "") return; // missing → nothing
		const marker = JSON.stringify(raw);
		if (readRawField(cur.file, "card_type_invalid") === marker) return; // already marked for this value
		annotate(
			cur.file,
			{ card_type_invalid: marker },
			`card_type invalid ${marker} (${via}) - status preserved; governed Tier 1`,
		);
		events.push({ event: "CARD_TYPE_INVALID", card: cur.id, reason: raw, via });
	}

	private quarantine(id: string, cur: CardScan, events: ReconcileEvent[], via: string): void {
		writeStatus(cur.file, "Quarantine", {
			annotations: { quarantine_invalid_status: JSON.stringify(cur.rawStatus) },
			logLine: `quarantine: invalid status ${JSON.stringify(cur.rawStatus)} (${via})`,
		});
		this.snapshot.set(id, "Quarantine");
		events.push({ event: "QUARANTINE", card: id, reason: cur.rawStatus, via });
	}

	/** Per-status counts over the current snapshot (for the footer + /cards-status). */
	summary(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const status of this.snapshot.values()) counts[status] = (counts[status] ?? 0) + 1;
		return counts;
	}
}

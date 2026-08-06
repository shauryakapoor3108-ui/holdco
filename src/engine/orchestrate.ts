// orchestrate.ts - the daemon's execution glue: workspaces at intake, the queue
// drain into worker slots, teardown at terminal states.
//
// This is what remained of the source system's extension entrypoint after the
// engine loop (core.ts), the pool, and the workspace manager were carved out:
// pure event wiring, no mechanics of its own.
//
//   card:intake      → wsMgr.onIntake (scoped dir + git worktree, capped)
//   card:queued      → drain tick
//   exec:idle        → drain tick (a freed slot should pull the next head now)
//   card:filed/…     → wsMgr.onTerminal + prune + breaker reset
//   every sweep tick → pool.sweep() (monitor active workers) + drain tick
//
// Drain discipline (sovereignty rules carried from the source system):
//   • the engine writes `Queued → Executing` ONLY for a card that is STILL
//     Queued on disk at dispatch time - a human pull-back always stands.
//   • the write is loop-suppressed (writeStatus + synchronous snapshot.set).
//   • halted cards (halt: true) are never drained.
//   • a Queued card with no lifecycle worktree triggers intake instead of
//     dispatch - it dispatches on a later tick once workspace:ready landed.

import type { EngineHost } from "../host/host.ts";
import type { Disposer } from "../host/host.ts";
import type { KnowledgeStore } from "../knowledge/store.ts";
import type { Classifier } from "../routing/classify.ts";
import { routeFor, type RoutingTable } from "../routing/table.ts";
import type { StageEvent, StageEventSink } from "../telemetry/stage-events.ts";
import type { CardEngine } from "./core.ts";
import { readInstruction } from "./executor.ts";
import { parseCard, readRawField, writeStatus } from "./frontmatter.ts";
import type { WorkerPool } from "./worker-pool.ts";
import type { WorkspaceManager } from "./workspace-manager.ts";

const TERMINAL_EVENTS = ["card:filed", "card:archived", "card:quarantine"] as const;

export interface OrchestratorDeps {
	host: EngineHost;
	engine: CardEngine;
	pool: WorkerPool;
	wsMgr: WorkspaceManager;
	/** The board/repo root (worktrees are cut from this repo). */
	cwd: string;
	now?: () => number;
	/** The triage stage: classifies a card before its first dispatch so the
	 *  routing table picks the model tier. Absent → no classification (cards run
	 *  on the pool's default model). */
	classifier?: Classifier;
	/** The model routing table (knowledge/routing.json, loaded by the shell). */
	routing?: RoutingTable;
	/** For message-log entries on classification decisions. */
	knowledge?: KnowledgeStore;
	/** Deck telemetry sink. ENGINE-LEVEL events (approval gate, classify) use the
	 *  CARD id as run_id - the deck groups by card_id, so they join the per-spawn
	 *  worker/harvest runs (which carry the pool's runId nonce) on that key. */
	stageEvents?: StageEventSink;
}

export class Orchestrator {
	private readonly d: OrchestratorDeps;
	private readonly disposers: Disposer[] = [];
	private interval: ReturnType<typeof setInterval> | null = null;
	private draining = false;

	constructor(deps: OrchestratorDeps) {
		this.d = deps;
	}

	private stage(ev: StageEvent): void {
		this.d.stageEvents?.emit(ev);
	}

	private stageApprovalGate(id: string, status: "awaiting_human" | "passed"): void {
		this.stage({
			run_id: id,
			card_id: id,
			node_id: `${id}:approval-gate`,
			node_type: "gate",
			stage: "human-gate:approval",
			harness: null,
			status,
			ts: new Date().toISOString(),
		});
	}

	/** Wire the event subscriptions + arm the sweep tick. */
	start(sweepMs = 2000): void {
		const { host } = this.d;
		this.disposers.push(
			host.events.on("card:intake", (p: any) => {
				if (p?.id && p?.file) void this.d.wsMgr.onIntake(p.id, p.file, this.d.cwd);
			}),
			// A card arriving at Needs Approval IS the approval gate opening - the
			// engine has the landing event; the human move to Queued closes it (the
			// drain emits "passed" when it consumes the approval).
			host.events.on("card:needs-approval", (p: any) => {
				if (p?.id) this.stageApprovalGate(p.id, "awaiting_human");
			}),
			host.events.on("card:queued", () => void this.drain()),
			host.events.on("exec:idle", () => void this.drain()),
			...TERMINAL_EVENTS.map((ev) =>
				host.events.on(ev, (p: any) => {
					if (!p?.id) return;
					this.d.pool.clearDispatchCount(p.id);
					void this.d.wsMgr.onTerminal(p.id, this.d.cwd).then(() => this.d.pool.pruneScopedDir(p.id));
				}),
			),
		);
		this.interval = setInterval(() => {
			void this.d.pool.sweep();
			void this.drain();
		}, sweepMs);
		this.d.host.log.entry("card-engine-log", { event: "ORCHESTRATOR_STARTED", sweepMs, ts: new Date().toISOString() });
	}

	async stop(): Promise<void> {
		if (this.interval) clearInterval(this.interval);
		for (const d of this.disposers.splice(0)) d();
		await this.d.pool.settleLaunches();
		await this.d.pool.reapAll();
		await this.d.wsMgr.shutdown();
	}

	/**
	 * One drain pass: offer Queued heads to free slots, oldest queue-entry first
	 * (approximated by card id order over the reconciler scan - deterministic and
	 * stable; a dedicated FIFO file is not worth its failure modes at this size).
	 */
	async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			const rec = this.d.engine.reconciler;
			if (!rec) return;
			const scans = [...rec.scan().entries()].sort(([a], [b]) => a.localeCompare(b));
			for (const [id, scan] of scans) {
				if (this.d.pool.freeSlots() <= 0) return;
				if (rec.snapshot.get(id) !== "Queued") continue;
				if (this.d.pool.hasSlot(id)) continue;
				if (readRawField(scan.file, "halt") === "true") continue;

				// SOVEREIGNTY: re-parse the card NOW - the snapshot may lag a human
				// pull-back by one sweep. A stale offer is a no-op.
				const cur = parseCard(scan.file);
				if (!cur || cur.status !== "Queued") continue;

				// A Queued card without a lifecycle worktree gets intake, not dispatch
				// (covers boards where a card entered the funnel past Intake).
				if (!this.d.wsMgr.hasWorkspace(id)) {
					void this.d.wsMgr.onIntake(id, scan.file, this.d.cwd);
					continue; // dispatch next tick, once the worktree exists
				}

				// TRIAGE (once per card): classify → route → write the decision ONTO
				// the card (class / tier / model / classified_by). Status is unchanged,
				// so the write produces no reconcile delta. A human-pinned `model:`
				// field always wins - routing never overrides it.
				if (this.d.classifier && this.d.routing && !readRawField(scan.file, "class")) {
					this.stage({
						run_id: id,
						card_id: id,
						node_id: `${id}:classify`,
						node_type: "agent",
						stage: "classify",
						harness: null,
						status: "started",
						ts: new Date().toISOString(),
					});
					const c = await this.d.classifier.classify({
						id,
						title: readRawField(scan.file, "title") ?? "",
						cardType: readRawField(scan.file, "card_type") ?? "",
						instruction: readInstruction(scan.file),
					});
					const { tier, model } = routeFor(this.d.routing, c.class);
					const pinned = readRawField(scan.file, "model");
					// model = the classifier's own model (its `via`) when a model classified;
					// the rules fallback has no model. The rationale stays in the log - the
					// StageEvent schema has no field for it.
					this.stage({
						run_id: id,
						card_id: id,
						node_id: `${id}:classify`,
						node_type: "agent",
						stage: "classify",
						harness: null,
						...(c.via !== "rules" ? { model: c.via } : {}),
						tier,
						status: "passed",
						ts: new Date().toISOString(),
					});
					writeStatus(scan.file, "Queued", {
						annotations: { class: c.class, tier, classified_by: c.via, ...(pinned ? {} : { model }) },
						logLine: `classified ${c.class} → ${tier}${pinned ? ` (model pinned: ${pinned})` : ` (${model})`} via ${c.via}: ${c.rationale}`,
					});
					this.d.host.log.entry("card-engine-log", {
						event: "EXEC_CLASSIFIED",
						card: id,
						class: c.class,
						delegation: c.delegation,
						complexity: c.complexity,
						outcome_shape: c.outcome,
						tier,
						model: pinned || model,
						via: c.via,
						rationale: c.rationale,
						ts: new Date().toISOString(),
					});
					this.d.knowledge?.appendMessage(id, {
						author: "engine",
						kind: "status",
						text: `classified ${c.class} → ${tier} tier (${pinned || model}) via ${c.via}: ${c.rationale}`,
					});
				}

				// The engine edge: Queued → Executing, loop-suppressed, then dispatch.
				writeStatus(scan.file, "Executing", { logLine: "drain: Queued → Executing (engine)" });
				rec.snapshot.set(id, "Executing");
				// The human approval was consumed (Queued → Executing) - gate passed.
				this.stageApprovalGate(id, "passed");
				this.d.host.events.emit("card:dequeued", { id, file: scan.file });
				this.d.pool.dispatch(id, scan.file, { cwd: this.d.cwd });
			}
		} finally {
			this.draining = false;
		}
	}
}

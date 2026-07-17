// core.ts — the engine loop, host-agnostic.
//
// Extracted from the source system's extension entrypoint (index.ts, 1127
// lines): this is the reconciliation core — lease, startup recovery, sweep
// interval, optional fs.watch latency hint, lifecycle event emission — with
// every runtime touchpoint routed through EngineHost. Worker dispatch
// (executor / worker pool / workspaces) arrives with the harness-adapter
// phase; the engine already emits the events those components subscribe to.
//
// Correctness layer = the periodic sweep. fs.watch is an optional latency
// hint (debounced), never load-bearing: disable with events-off for the
// sweep-only proof.

import * as fs from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Disposer, EngineHost } from "../host/host.ts";
import { readRawField } from "./frontmatter.ts";
import { acquireLease, type LeaseOutcome, leasePathFor, releaseLease } from "./owner-lease.ts";
import { Reconciler, type ReconcileEvent } from "./reconciler.ts";

export interface CardEngineOpts {
	cwd?: string;
	/** Skip the single-owner lease (tests only). */
	noLease?: boolean;
}

/** A card is HARD-STOPPED when its frontmatter carries `halt: true`. */
function isHalted(file: string): boolean {
	return readRawField(file, "halt") === "true";
}

// Landing events: a card ARRIVING at a column via any live route triggers the
// column's lifecycle event exactly once per arrival. NEW_CARD is included —
// a card first seen at a column seeds the snapshot and emits no later delta,
// so watching TRANSITION alone would miss it (source-system lesson).
const LANDING_ROUTES = new Set(["TRANSITION", "DEQUARANTINE", "NEW_CARD"]);
const LANDING_EVENTS: Record<string, string> = {
	"Needs Approval": "card:needs-approval",
	Intake: "card:intake",
	Held: "card:held",
	Queued: "card:queued",
	Filed: "card:filed",
	Archived: "card:archived",
	Quarantine: "card:quarantine",
};

export class CardEngine {
	readonly cardsDir: string;
	private readonly host: EngineHost;
	private reconciler: Reconciler | null = null;
	private interval: ReturnType<typeof setInterval> | null = null;
	private watcher: fs.FSWatcher | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private readonly disposers: Disposer[] = [];
	private leasePath: string | null = null;
	private opts: CardEngineOpts;
	lastSweep = 0;

	constructor(host: EngineHost, opts: CardEngineOpts = {}) {
		this.host = host;
		this.opts = opts;
		const cwd = opts.cwd ?? process.cwd();
		const dir = host.config.get("cards-dir") || "cards";
		this.cardsDir = isAbsolute(dir) ? dir : join(cwd, dir);
	}

	private num(key: string, fallback: number, min: number): number {
		const v = Number(this.host.config.get(key) ?? fallback);
		return Number.isFinite(v) && v >= min ? v : fallback;
	}

	/** Boot: lease → startup recovery → arm sweep (+ fs.watch unless events-off). */
	start(): { owner: boolean } {
		fs.mkdirSync(this.cardsDir, { recursive: true });

		if (!this.opts.noLease) {
			this.leasePath = leasePathFor(this.cardsDir);
			const lease: LeaseOutcome = acquireLease(this.leasePath);
			if (!lease.owner) {
				this.host.notify(`engine lease held by pid ${lease.holderPid} — running inert`, "warning");
				this.leasePath = null; // not ours to release
				return { owner: false };
			}
		}

		this.reconciler = new Reconciler(this.cardsDir);
		const recovered = this.reconciler.startupRecovery();
		if (recovered.length) this.logEvents(recovered);

		const sweepMs = this.num("card-sweep-ms", 2000, 250);
		this.interval = setInterval(() => this.runReconcile("sweep"), sweepMs);

		if (this.host.config.get("card-events-off") !== "true") {
			try {
				this.watcher = fs.watch(this.cardsDir, () => {
					if (this.debounce) clearTimeout(this.debounce);
					this.debounce = setTimeout(() => this.runReconcile("event"), 150);
				});
			} catch {
				// fs.watch unavailable → sweep-only; the correctness layer is unaffected.
			}
		}

		this.host.log.entry("card-engine-log", {
			event: "ENGINE_STARTED",
			cardsDir: this.cardsDir,
			sweepMs,
			mode: this.watcher ? "sweep+events" : "sweep-only",
			ts: new Date().toISOString(),
		});
		return { owner: true };
	}

	/** One reconciliation pass; emits landing events for every detected arrival. */
	runReconcile(via: "sweep" | "event"): ReconcileEvent[] {
		if (!this.reconciler) return [];
		this.lastSweep = Date.now();
		const events = this.reconciler.reconcile(via);
		if (events.length) this.logEvents(events);
		for (const e of events) {
			const landing = e.to ? LANDING_EVENTS[e.to] : undefined;
			if (landing && e.file && LANDING_ROUTES.has(e.event) && !isHalted(e.file)) {
				this.host.events.emit(landing, { id: e.card, file: e.file });
			}
			if (e.event === "TRANSITION" && e.from === "Queued" && e.to === "Draft" && e.file) {
				this.host.events.emit("card:dequeued", { id: e.card, file: e.file });
			}
		}
		return events;
	}

	private logEvents(events: ReconcileEvent[]): void {
		for (const e of events) {
			this.host.log.entry("card-engine-log", { ...e, ts: new Date().toISOString() });
			if (e.event === "ILLEGAL_REVERT") this.host.notify(`reverted illegal ${e.from} → ${e.to} (${e.card})`, "warning");
			else if (e.event === "QUARANTINE") this.host.notify(`quarantined ${e.card}: ${e.reason}`, "warning");
			else if (e.event === "ORPHAN_RECOVERED") this.host.notify(`recovered orphan ${e.card}: Executing → Needs Review`, "warning");
		}
	}

	summary(): Record<string, number> {
		return this.reconciler?.summary() ?? {};
	}

	stop(): void {
		if (this.interval) clearInterval(this.interval);
		if (this.debounce) clearTimeout(this.debounce);
		this.watcher?.close();
		for (const d of this.disposers.splice(0)) d();
		if (this.leasePath) releaseLease(this.leasePath);
		this.host.log.entry("card-engine-log", { event: "ENGINE_STOPPED", ts: new Date().toISOString() });
	}
}

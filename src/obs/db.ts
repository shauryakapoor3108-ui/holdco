// db.ts — node:sqlite storage for StageEvent telemetry.
//
// Node port of the source observability server's bun:sqlite layer, reshaped for
// the StageEvent contract: ONE flat stage_events table (every schema field a
// column, usage flattened to usage_* columns) plus two server-side additions:
//   • seq — server-assigned monotonic INTEGER PRIMARY KEY AUTOINCREMENT; the
//     resync cursor for consumers (ascending reads, "since seq N").
//   • a dedupe UNIQUE key on (run_id, node_id, status, ts) — re-POSTing the
//     same event is a no-op (INSERT OR IGNORE), mirroring the source server's
//     idempotent event_id inserts.
// The legacy per-session rollup table is replaced by a per-RUN rollup query
// (runs are the deck's grouping unit; card_id joins engine + worker events).

import { DatabaseSync } from "node:sqlite";
import type { StageEvent } from "../telemetry/stage-events.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stage_events (
	seq              INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id           TEXT NOT NULL,
	card_id          TEXT NOT NULL,
	node_id          TEXT NOT NULL,
	node_type        TEXT NOT NULL,
	stage            TEXT NOT NULL,
	harness          TEXT,
	model            TEXT,
	tier             TEXT,
	status           TEXT NOT NULL,
	payload_ref      TEXT,
	prompt_ref       TEXT,
	usage_tokens_in  INTEGER,
	usage_tokens_out INTEGER,
	usage_cost_usd   REAL,
	ts               TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_events_dedupe ON stage_events(run_id, node_id, status, ts);
CREATE INDEX IF NOT EXISTS idx_stage_events_run ON stage_events(run_id);
CREATE INDEX IF NOT EXISTS idx_stage_events_card ON stage_events(card_id);
`;

/** A persisted event: the wire StageEvent plus the server-assigned seq. */
export interface StoredStageEvent extends StageEvent {
	seq: number;
}

/** Per-run rollup (replaces the source server's per-session rollup). */
export interface RunRollup {
	run_id: string;
	card_id: string;
	first_ts: string;
	last_ts: string;
	cost_usd: number;
	tokens_in: number;
	tokens_out: number;
	last_status: string;
	event_count: number;
}

export interface ObsDb {
	/** Insert (dedupe-aware). Returns true when the event is NEW. */
	insert(ev: StageEvent): boolean;
	/** Events ascending by seq, optionally filtered by run/card. */
	list(filter?: { runId?: string; cardId?: string; limit?: number }): StoredStageEvent[];
	/** Per-run rollups, most recent last_ts first. */
	runs(limit?: number): RunRollup[];
	/** Total persisted events (the /health counter). */
	total(): number;
	close(): void;
}

export function createObsDb(path: string): ObsDb {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(SCHEMA);

	const insertStmt = db.prepare(`
		INSERT OR IGNORE INTO stage_events
			(run_id, card_id, node_id, node_type, stage, harness, model, tier, status,
			 payload_ref, prompt_ref, usage_tokens_in, usage_tokens_out, usage_cost_usd, ts)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const listStmt = db.prepare(`
		SELECT * FROM stage_events
		WHERE (? = '' OR run_id = ?)
		  AND (? = '' OR card_id = ?)
		ORDER BY seq ASC
		LIMIT ?
	`);

	// last_status = the status of the run's newest row (max seq). run_id is the
	// grouping key, so the correlated subquery is well-defined per group.
	const runsStmt = db.prepare(`
		SELECT
			run_id,
			MIN(card_id) AS card_id,
			MIN(ts) AS first_ts,
			MAX(ts) AS last_ts,
			COALESCE(SUM(usage_cost_usd), 0) AS cost_usd,
			COALESCE(SUM(usage_tokens_in), 0) AS tokens_in,
			COALESCE(SUM(usage_tokens_out), 0) AS tokens_out,
			(SELECT s2.status FROM stage_events s2 WHERE s2.run_id = stage_events.run_id ORDER BY s2.seq DESC LIMIT 1) AS last_status,
			COUNT(*) AS event_count
		FROM stage_events
		GROUP BY run_id
		ORDER BY last_ts DESC
		LIMIT ?
	`);

	const totalStmt = db.prepare(`SELECT COUNT(*) AS n FROM stage_events`);

	return {
		insert(ev: StageEvent): boolean {
			const res = insertStmt.run(
				ev.run_id,
				ev.card_id,
				ev.node_id,
				ev.node_type,
				ev.stage,
				ev.harness ?? null,
				ev.model ?? null,
				ev.tier ?? null,
				ev.status,
				ev.payload_ref ?? null,
				ev.prompt_ref ?? null,
				ev.usage ? ev.usage.tokens_in : null,
				ev.usage ? ev.usage.tokens_out : null,
				ev.usage ? ev.usage.cost_usd : null,
				ev.ts,
			);
			return Number(res.changes) > 0;
		},
		list(filter = {}): StoredStageEvent[] {
			const run = filter.runId ?? "";
			const card = filter.cardId ?? "";
			const limit = Math.max(1, Math.min(filter.limit ?? 500, 5000));
			return (listStmt.all(run, run, card, card, limit) as Record<string, unknown>[]).map(rowToEvent);
		},
		runs(limit = 50): RunRollup[] {
			const capped = Math.max(1, Math.min(limit, 500));
			return (runsStmt.all(capped) as Record<string, unknown>[]).map((r) => ({
				run_id: String(r.run_id),
				card_id: String(r.card_id),
				first_ts: String(r.first_ts),
				last_ts: String(r.last_ts),
				cost_usd: Number(r.cost_usd),
				tokens_in: Number(r.tokens_in),
				tokens_out: Number(r.tokens_out),
				last_status: String(r.last_status),
				event_count: Number(r.event_count),
			}));
		},
		total(): number {
			const row = totalStmt.get() as Record<string, unknown>;
			return Number(row.n);
		},
		close(): void {
			db.close();
		},
	};
}

/** Rebuild a StageEvent from a row. `harness` round-trips as null (the schema
 *  allows string|null); other optional fields are OMITTED when NULL so the
 *  reconstructed object stays schema-shaped. */
function rowToEvent(row: Record<string, unknown>): StoredStageEvent {
	const ev: StoredStageEvent = {
		seq: Number(row.seq),
		run_id: String(row.run_id),
		card_id: String(row.card_id),
		node_id: String(row.node_id),
		node_type: String(row.node_type) as StageEvent["node_type"],
		stage: String(row.stage),
		harness: row.harness === null ? null : String(row.harness),
		status: String(row.status) as StageEvent["status"],
		ts: String(row.ts),
	};
	if (row.model !== null) ev.model = String(row.model);
	if (row.tier !== null) ev.tier = String(row.tier) as StageEvent["tier"];
	if (row.payload_ref !== null) ev.payload_ref = String(row.payload_ref);
	if (row.prompt_ref !== null) ev.prompt_ref = String(row.prompt_ref);
	if (row.usage_cost_usd !== null || row.usage_tokens_in !== null || row.usage_tokens_out !== null) {
		ev.usage = {
			tokens_in: Number(row.usage_tokens_in ?? 0),
			tokens_out: Number(row.usage_tokens_out ?? 0),
			cost_usd: Number(row.usage_cost_usd ?? 0),
		};
	}
	return ev;
}

// stage-events.ts - StageEvent telemetry: the deck's wire contract, emitted at
// the engine's harness boundary.
//
// StageEvent mirrors schema/stage-event.schema.json EXACTLY (strict contract,
// additionalProperties false, version 1). Every event the engine emits must
// validate against that schema - the obs server re-validates on ingest, so a
// drifted emitter shows up as rejected[] instead of corrupting the deck.
//
// run_id conventions:
//   • worker/harvest/review-gate events carry the PER-SPAWN runId nonce (the
//     pool's correlation tag) - one run per spawn, retries are separate runs.
//   • engine-level events (approval gate, classify) carry the CARD id - the
//     deck groups by card_id, so both families join on card_id.
//
// Sinks are fire-and-forget: emit() must NEVER throw and never block. A dead
// telemetry pipe degrades to silence - the board's correctness never depends
// on an event landing.

import type { EngineHost } from "../host/host.ts";

export interface StageEventUsage {
	tokens_in: number;
	tokens_out: number;
	cost_usd: number;
}

/** One deck telemetry event. Mirrors schema/stage-event.schema.json exactly. */
export interface StageEvent {
	run_id: string;
	card_id: string;
	node_id: string;
	node_type: "agent" | "deterministic" | "gate";
	stage: string;
	/** Adapter name for agent nodes; null for deterministic/gate nodes. */
	harness?: string | null;
	model?: string;
	tier?: "workhorse" | "frontier";
	status: "started" | "progress" | "passed" | "failed" | "awaiting_human";
	payload_ref?: string;
	prompt_ref?: string;
	usage?: StageEventUsage;
	ts: string;
}

export interface StageEventSink {
	/** Fire-and-forget: MUST never throw and never block. */
	emit(ev: StageEvent): void;
}

// ── HostLogSink - every event lands on the host log (always wired) ───────────

export class HostLogSink implements StageEventSink {
	private readonly host: EngineHost;

	constructor(host: EngineHost) {
		this.host = host;
	}

	emit(ev: StageEvent): void {
		try {
			this.host.log.entry("stage-event", ev as unknown as Record<string, unknown>);
		} catch {
			/* the log line is non-essential; emit never throws. */
		}
	}
}

// ── HttpSink - POST one event to the obs server (fire-and-forget) ────────────

export interface HttpSinkOpts {
	/** Obs server base URL, e.g. http://127.0.0.1:43190 (no trailing slash needed). */
	url: string;
	token?: string;
	/** Injectable for tests. */
	fetchFn?: typeof fetch;
	/** Short timeout - telemetry must never hold the engine hostage. */
	timeoutMs?: number;
}

export class HttpSink implements StageEventSink {
	private readonly url: string;
	private readonly token: string;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number;
	/** One warn per boot: after the first failure, drops are silent. */
	private warned = false;

	constructor(opts: HttpSinkOpts) {
		this.url = opts.url.replace(/\/+$/, "");
		this.token = opts.token ?? "";
		this.fetchFn = opts.fetchFn ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? 1500;
	}

	emit(ev: StageEvent): void {
		try {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
			void this.fetchFn(`${this.url}/stage-events`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				},
				body: JSON.stringify(ev),
				signal: ctrl.signal,
			})
				.then((res) => {
					if (!res.ok) this.warnOnce(`HTTP ${res.status}`);
				})
				.catch((err) => this.warnOnce(String(err)))
				.finally(() => clearTimeout(t));
		} catch (err) {
			this.warnOnce(String(err));
		}
	}

	private warnOnce(detail: string): void {
		if (this.warned) return;
		this.warned = true;
		console.error(`[warning] stage-event http sink: POST ${this.url}/stage-events failed (${detail}) - further drops are silent`);
	}
}

// ── CompositeSink - fan one event out to several sinks ───────────────────────

export class CompositeSink implements StageEventSink {
	private readonly sinks: StageEventSink[];

	constructor(sinks: StageEventSink[]) {
		this.sinks = sinks;
	}

	emit(ev: StageEvent): void {
		for (const sink of this.sinks) {
			try {
				sink.emit(ev);
			} catch {
				/* one bad sink must not starve the others. */
			}
		}
	}
}

// ── MemorySink - test helper: capture every emission in order ────────────────

export class MemorySink implements StageEventSink {
	readonly events: StageEvent[] = [];

	emit(ev: StageEvent): void {
		this.events.push(ev);
	}

	clear(): void {
		this.events.length = 0;
	}
}

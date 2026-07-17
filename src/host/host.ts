// host.ts — the EngineHost seam.
//
// Everything the engine needs from its runtime environment, behind one small
// interface. The Pi shell implements this over Pi's ExtensionAPI (events bus,
// appendEntry, flags); the standalone daemon implements it natively. Phase 0
// measured the full coupling surface — this interface IS that surface:
//   events   ← pi.events.emit / pi.events.on   (71 call sites)
//   log      ← pi.appendEntry                  (40 call sites)
//   config   ← pi.getFlag / registerFlag / env (16 call sites)
//   notify   ← ctx.ui.notify / sendUserMessage
//
// Rule carried over from the source system: `events.on` RETURNS a disposer.
// A host that never disposes leaves ghost handlers holding stale snapshots
// (the reload-leak loop). Engine code stores every disposer and calls them
// all on stop().

import { EventEmitter } from "node:events";

export type Disposer = () => void;

export interface HostEvents {
	emit(event: string, payload?: unknown): void;
	/** Subscribe; MUST return an unsubscribe fn. */
	on(event: string, handler: (payload: any) => void): Disposer;
}

export interface HostLog {
	/** Structured log entry, `kind` is the channel (e.g. "card-engine-log"). */
	entry(kind: string, data: Record<string, unknown>): void;
}

export interface HostConfig {
	/** Resolve a config key: CLI flag > env var > default. Returns undefined when unset. */
	get(key: string): string | undefined;
}

export interface EngineHost {
	events: HostEvents;
	log: HostLog;
	config: HostConfig;
	/** Human-facing notification (UI toast in Pi, stderr line in the daemon). */
	notify(message: string, level: "info" | "warning" | "error"): void;
}

// ── Standalone implementation (the daemon's host) ────────────────────────────

export interface StandaloneHostOpts {
	/** Flag overrides (e.g. parsed CLI args). Checked before process.env. */
	flags?: Record<string, string>;
	/** Sink for log entries; defaults to stdout JSON lines. */
	sink?: (kind: string, data: Record<string, unknown>) => void;
	quiet?: boolean;
}

/** ENV name for a flag key: "card-sweep-ms" → "CARD_SWEEP_MS". */
export function envNameFor(key: string): string {
	return key.replace(/-/g, "_").toUpperCase();
}

export function createStandaloneHost(opts: StandaloneHostOpts = {}): EngineHost {
	const bus = new EventEmitter();
	bus.setMaxListeners(100);
	const sink =
		opts.sink ??
		((kind: string, data: Record<string, unknown>) => {
			if (!opts.quiet) console.log(JSON.stringify({ kind, ...data }));
		});
	return {
		events: {
			emit(event, payload) {
				bus.emit(event, payload);
			},
			on(event, handler) {
				bus.on(event, handler);
				return () => bus.off(event, handler);
			},
		},
		log: {
			entry(kind, data) {
				sink(kind, data);
			},
		},
		config: {
			get(key) {
				return opts.flags?.[key] ?? process.env[envNameFor(key)] ?? undefined;
			},
		},
		notify(message, level) {
			if (!opts.quiet) console.error(`[${level}] ${message}`);
		},
	};
}

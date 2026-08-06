// replay.ts - demo-mode feed: replay a committed StageEvent fixture into the
// observability server at (optionally slowed) real pace, over the same POST
// path live telemetry uses. `holdco obs` + `holdco replay` IS deck demo mode:
// the deck cannot tell a replay from a live run - which is the point (the
// README GIF and the application video capture exactly this, with ZERO real
// data: fixtures are synthetic by hard rule).

import * as fs from "node:fs";
import { validateFile } from "../schema/validate.ts";
import type { StageEvent } from "../telemetry/stage-events.ts";

export interface ReplayOpts {
	/** Path to a .jsonl fixture (one StageEvent per line). */
	file: string;
	/** Obs server base URL (e.g. http://127.0.0.1:43190). */
	url: string;
	token?: string;
	/** Pace divisor: 1 = real time, 2 = twice as fast, 0 = firehose (no pacing). */
	speed?: number;
	/** Re-stamp timestamps anchored at now, preserving relative deltas (default true). */
	anchorNow?: boolean;
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	schemaPath?: string;
}

/** Never let a fixture gap stall a demo - cap each inter-event wait. */
const MAX_GAP_MS = 5_000;

export async function replayFixture(opts: ReplayOpts): Promise<{ sent: number; rejected: number }> {
	const fetchFn = opts.fetchFn ?? fetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const speed = opts.speed ?? 1;
	const anchorNow = opts.anchorNow ?? true;
	const schemaPath = opts.schemaPath ?? new URL("../../schema/stage-event.schema.json", import.meta.url).pathname;

	// Parse + validate up front: a bad COMMITTED fixture must fail loudly before
	// a single event hits the wire.
	const lines = fs
		.readFileSync(opts.file, "utf8")
		.split("\n")
		.filter((l) => l.trim());
	const events: StageEvent[] = lines.map((line, i) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (err) {
			throw new Error(`${opts.file}:${i + 1}: not JSON (${String(err)})`);
		}
		const verdict = validateFile(schemaPath, parsed);
		if (!verdict.valid) throw new Error(`${opts.file}:${i + 1}: schema-invalid StageEvent - ${verdict.errors.join("; ")}`);
		return parsed as StageEvent;
	});
	if (events.length === 0) return { sent: 0, rejected: 0 };

	// Re-anchor: first event = now, later events keep their original deltas.
	const t0 = Date.parse(events[0].ts);
	const anchor = Date.now();
	const stamped = events.map((e) => {
		const delta = Math.max(0, Date.parse(e.ts) - t0);
		return anchorNow ? { ...e, ts: new Date(anchor + delta).toISOString() } : e;
	});

	let sent = 0;
	let rejected = 0;
	let prevTs = Date.parse(stamped[0].ts);
	for (const e of stamped) {
		const gap = Math.max(0, Date.parse(e.ts) - prevTs);
		prevTs = Date.parse(e.ts);
		if (speed > 0 && gap > 0) await sleep(Math.min(gap / speed, MAX_GAP_MS));
		try {
			const res = await fetchFn(`${opts.url}/stage-events`, {
				method: "POST",
				headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
				body: JSON.stringify(e),
			});
			const body: any = await res.json().catch(() => ({}));
			if (res.ok && (body.ingested ?? 0) > 0) sent++;
			else rejected++;
		} catch {
			rejected++;
		}
	}
	return { sent, rejected };
}

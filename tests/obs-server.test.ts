// obs-server.test.ts - the Node observability server: auth wall, schema-gated
// ingest (single + array + rejects + dedupe), filtered reads, per-run rollups,
// and live SSE fan-out. Boots on an EPHEMERAL port (port: 0) against a temp
// SQLite file. Run via `node tests/obs-server.test.ts`.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startObsServer } from "../src/obs/server.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log(`  ✅ ${msg}`);
	} else {
		fail++;
		console.log(`  ❌ ${msg}`);
	}
}

const tmp = fs.mkdtempSync(join(tmpdir(), "obs-server-test-"));
const dbPath = join(tmp, "obs.db");
const TOKEN = "test-token-0000";

const srv = await startObsServer({ port: 0, dbPath, token: TOKEN, quiet: true });
ok(typeof srv.port === "number" && srv.port > 0, `ephemeral port assigned (${srv.port})`);
const base = `http://127.0.0.1:${srv.port}`;
const AUTH = { authorization: `Bearer ${TOKEN}` };
const POST_H = { ...AUTH, "content-type": "application/json" };

/** A valid StageEvent with overrides. */
function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		run_id: "r1",
		card_id: "c1",
		node_id: "r1:worker",
		node_type: "agent",
		stage: "worker",
		harness: "fake",
		status: "started",
		ts: "2026-07-17T10:00:00.000Z",
		...over,
	};
}

async function post(body: unknown): Promise<any> {
	const res = await fetch(`${base}/stage-events`, { method: "POST", headers: POST_H, body: JSON.stringify(body) });
	return res.json();
}

// ── health (unauthenticated) ──────────────────────────────────────────────────
{
	console.log("── health + auth wall");
	const h = await (await fetch(`${base}/health`)).json();
	ok(h.ok === true && h.stage_events_total === 0 && typeof h.uptime_s === "number", "/health open + zeroed counters");

	ok((await fetch(`${base}/stage-events`)).status === 401, "GET /stage-events without token → 401");
	ok((await fetch(`${base}/stage-events`, { method: "POST", body: "{}" })).status === 401, "POST /stage-events without token → 401");
	ok((await fetch(`${base}/runs?token=wrong`)).status === 401, "wrong ?token= → 401");
	ok((await fetch(`${base}/runs?token=${TOKEN}`)).status === 200, "?token= accepted (query-param auth)");
	ok((await fetch(`${base}/runs`, { headers: AUTH })).status === 200, "Bearer header accepted");
}

// ── ingest: single, array, invalid, dedupe ────────────────────────────────────
{
	console.log("── ingest: single + array + schema rejects + dedupe");
	let r = await post(ev());
	ok(r.ingested === 1 && r.rejected === 0, "single valid event → ingested 1");

	r = await post([
		ev({ status: "passed", ts: "2026-07-17T10:01:00.000Z", usage: { tokens_in: 400, tokens_out: 56, cost_usd: 0.01 }, payload_ref: "/x/card.diff" }),
		ev({ node_id: "r1:review-gate", node_type: "gate", stage: "human-gate:review", harness: null, status: "awaiting_human", ts: "2026-07-17T10:01:01.000Z" }),
	]);
	ok(r.ingested === 2 && r.rejected === 0, "array of 2 valid events → ingested 2");

	r = await post(ev({ ts: "2026-07-17T10:02:00.000Z", smuggled_extra_field: true }));
	ok(r.ingested === 0 && r.rejected === 1, "additionalProperties violation → rejected 1");
	ok(Array.isArray(r.errors) && r.errors.some((e: string) => e.includes("smuggled_extra_field")), "response carries the validation errors");

	r = await post([ev({ node_id: "r1:harvest", node_type: "deterministic", stage: "harvest", harness: null, status: "passed", ts: "2026-07-17T10:03:00.000Z" }), ev({ status: "no-such-status" })]);
	ok(r.ingested === 1 && r.rejected === 1 && Array.isArray(r.errors), "mixed array → ingested 1, rejected 1, errors of the FIRST invalid");
	ok(r.errors.some((e: string) => e.includes("no-such-status")), "errors name the enum violation");

	r = await post(ev());
	ok(r.ingested === 0 && r.rejected === 0, "same event twice → dedupe: ingested 0 (not rejected)");

	const h = await (await fetch(`${base}/health`)).json();
	ok(h.stage_events_total === 4, `health counter tracks persisted events (4, got ${h.stage_events_total})`);
}

// ── reads: filters + ascending seq + run rollups ──────────────────────────────
{
	console.log("── reads: /stage-events filters + /runs rollup");
	// A second run on another card, LATER, with its own cost.
	await post([
		ev({ run_id: "r2", card_id: "c2", node_id: "r2:worker", ts: "2026-07-17T11:00:00.000Z" }),
		ev({ run_id: "r2", card_id: "c2", node_id: "r2:worker", status: "passed", ts: "2026-07-17T11:00:30.000Z", usage: { tokens_in: 100, tokens_out: 20, cost_usd: 0.02 } }),
	]);

	let r = await (await fetch(`${base}/stage-events?run_id=r1`, { headers: AUTH })).json();
	ok(Array.isArray(r.events) && r.events.length === 4 && r.events.every((e: any) => e.run_id === "r1"), "run_id filter returns only r1 events");
	ok(r.events.every((e: any, i: number) => i === 0 || e.seq > r.events[i - 1].seq), "events come back in ascending seq");
	const stored = r.events.find((e: any) => e.status === "passed");
	ok(stored?.usage?.tokens_in === 400 && stored?.usage?.cost_usd === 0.01 && stored?.payload_ref === "/x/card.diff", "usage + refs round-trip through SQLite");
	ok(r.events.find((e: any) => e.node_id === "r1:review-gate")?.harness === null, "harness null round-trips");

	r = await (await fetch(`${base}/stage-events?card_id=c2`, { headers: AUTH })).json();
	ok(r.events.length === 2 && r.events.every((e: any) => e.card_id === "c2"), "card_id filter returns only c2 events");

	r = await (await fetch(`${base}/stage-events?run_id=r1&limit=2`, { headers: AUTH })).json();
	ok(r.events.length === 2, "limit param caps the read");

	r = await (await fetch(`${base}/runs`, { headers: AUTH })).json();
	ok(Array.isArray(r.runs) && r.runs.length === 2, "two runs rolled up");
	ok(r.runs[0].run_id === "r2", "most recent run first (by last_ts)");
	const r1 = r.runs.find((x: any) => x.run_id === "r1");
	ok(r1.card_id === "c1" && r1.cost_usd === 0.01 && r1.tokens_in === 400 && r1.tokens_out === 56, "r1 rollup sums cost + tokens from usage rows");
	ok(r1.first_ts === "2026-07-17T10:00:00.000Z" && r1.last_ts === "2026-07-17T10:03:00.000Z", "first_ts/last_ts span the run");
	ok(r1.last_status === "passed" && r1.event_count === 4, "last_status = newest row's status");
	const r2 = r.runs.find((x: any) => x.run_id === "r2");
	ok(r2.cost_usd === 0.02 && r2.last_status === "passed", "r2 rollup independent of r1");
}

// ── SSE: hello frame, live stage frame, clean close ───────────────────────────
{
	console.log("── SSE stream");
	const ctrl = new AbortController();
	const res = await fetch(`${base}/stage-events/stream?token=${TOKEN}`, { signal: ctrl.signal });
	ok(res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream"), "stream opens as text/event-stream");
	const reader = res.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";

	async function readUntil(needle: string, ms = 4000): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (!buf.includes(needle)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return false;
			const chunk = await Promise.race([
				reader.read(),
				new Promise<null>((r) => setTimeout(() => r(null), remaining)),
			]);
			if (chunk === null || chunk.done) return buf.includes(needle);
			buf += dec.decode(chunk.value, { stream: true });
		}
		return true;
	}

	ok(await readUntil("event: hello"), "hello frame arrives");
	ok(buf.includes("retry: 5000"), "hello frame carries retry:");

	const live = ev({ run_id: "r9", card_id: "c9", node_id: "r9:worker", ts: "2026-07-17T12:00:00.000Z" });
	const r = await post(live);
	ok(r.ingested === 1, "live event ingested while stream open");
	ok(await readUntil("event: stage"), "stage frame broadcast to the subscriber");
	ok(buf.includes('"r9:worker"'), "stage frame carries the ingested event JSON");

	// duplicate → NOT rebroadcast
	const before = buf.split("event: stage").length;
	await post(live);
	await new Promise((r2) => setTimeout(r2, 150));
	try {
		const extra = await Promise.race([reader.read(), new Promise<null>((r2) => setTimeout(() => r2(null), 200))]);
		if (extra && !extra.done) buf += dec.decode(extra.value, { stream: true });
	} catch {
		/* stream may already be quiet */
	}
	ok(buf.split("event: stage").length === before, "duplicate POST does NOT rebroadcast");

	ctrl.abort(); // client hangs up → server unsubscribes on 'close'
	await new Promise((r2) => setTimeout(r2, 100));
	const after = await post(ev({ run_id: "r10", card_id: "c10", node_id: "r10:worker", ts: "2026-07-17T12:01:00.000Z" }));
	ok(after.ingested === 1, "ingest keeps working after the subscriber hung up (clean unsubscribe)");
}

await srv.close();

// second boot on the same db: persistence across restarts
{
	console.log("── restart persistence");
	const srv2 = await startObsServer({ port: 0, dbPath, token: TOKEN, quiet: true });
	const h = await (await fetch(`http://127.0.0.1:${srv2.port}/health`)).json();
	ok(h.stage_events_total === 8, `events persisted across restart (8, got ${h.stage_events_total})`);
	await srv2.close();
}

fs.rmSync(tmp, { recursive: true, force: true });

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

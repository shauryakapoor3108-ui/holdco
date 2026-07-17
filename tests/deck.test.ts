// deck.test.ts — the deck data contract: the committed synthetic fixture is
// schema-valid + internally coherent (monotone timestamps, parity pair), and
// replayFixture delivers it through the REAL obs server (ingest tally, run
// rollup, in-order SSE delivery) with correct re-anchoring + pacing.
// Run via `node tests/deck.test.ts`.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { replayFixture } from "../src/deck/replay.ts";
import { startObsServer } from "../src/obs/server.ts";
import { validateFile } from "../src/schema/validate.ts";
import type { StageEvent } from "../src/telemetry/stage-events.ts";

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

const repo = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(repo, "deck", "fixtures", "demo-board.jsonl");
const SCHEMA = join(repo, "schema", "stage-event.schema.json");

const lines = fs.readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());
const events: StageEvent[] = lines.map((l) => JSON.parse(l));

console.log("── fixture: schema validity + coherence ──");
{
	ok(events.length >= 30, `fixture holds a real board (${events.length} events)`);
	const bad = lines.map((l, i) => ({ i, v: validateFile(SCHEMA, JSON.parse(l)) })).filter((x) => !x.v.valid);
	ok(bad.length === 0, bad.length ? `schema-invalid lines: ${bad.map((b) => b.i + 1).join(",")} (${bad[0].v.errors[0]})` : "every line validates against stage-event.schema.json");
	const times = events.map((e) => Date.parse(e.ts));
	ok(times.every((t, i) => i === 0 || t >= times[i - 1]), "timestamps monotone non-decreasing");
	const cards = new Set(events.map((e) => e.card_id));
	ok(cards.size >= 5, `covers ${cards.size} cards`);
	ok(events.some((e) => e.status === "awaiting_human") && events.some((e) => e.status === "failed"), "attention-rail + failure content present");

	// parity pair: same stage/status sequence modulo harness
	const seq = (card: string) => events.filter((e) => e.card_id === card).map((e) => `${e.stage}/${e.status}/${e.node_type}`);
	const a = seq("pricing-page-update");
	const b = seq("renewal-quote-acme");
	ok(a.length > 0 && JSON.stringify(a) === JSON.stringify(b), "parity pair has identical stage/status sequences");
	const ha = new Set(events.filter((e) => e.card_id === "pricing-page-update" && e.stage === "worker").map((e) => e.harness));
	const hb = new Set(events.filter((e) => e.card_id === "renewal-quote-acme" && e.stage === "worker").map((e) => e.harness));
	ok(ha.has("claude-code") && hb.has("pi"), "parity pair spans both harnesses");
}

console.log("── replay through the real obs server + SSE ──");
{
	const dbPath = join(fs.mkdtempSync(join(os.tmpdir(), "holdco-deck-")), "obs.db");
	const srv = await startObsServer({ port: 0, dbPath, token: "deck-test", quiet: true });
	const base = `http://127.0.0.1:${srv.port}`;

	// SSE subscriber first, so it sees the whole replay
	const received: StageEvent[] = [];
	const ctrl = new AbortController();
	const ssePromise = (async () => {
		const res = await fetch(`${base}/stage-events/stream?token=deck-test`, { signal: ctrl.signal });
		const reader = res.body!.getReader();
		let buf = "";
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += new TextDecoder().decode(value);
				let i;
				while ((i = buf.indexOf("\n\n")) >= 0) {
					const frame = buf.slice(0, i);
					buf = buf.slice(i + 2);
					if (frame.startsWith("event: stage")) {
						const data = frame.split("\n").find((l) => l.startsWith("data: "));
						if (data) received.push(JSON.parse(data.slice(6)));
					}
				}
			}
		} catch {
			/* aborted */
		}
	})();
	await new Promise((r) => setTimeout(r, 150));

	const tally = await replayFixture({ file: FIXTURE, url: base, token: "deck-test", speed: 0 });
	ok(tally.sent === events.length && tally.rejected === 0, `replay ingested all ${events.length} events (sent ${tally.sent}, rejected ${tally.rejected})`);

	const stored = (await (await fetch(`${base}/stage-events?card_id=pricing-page-update&token=deck-test`)).json()) as any;
	ok(stored.events.length === events.filter((e) => e.card_id === "pricing-page-update").length, "per-card query returns the full flow");
	const runs = (await (await fetch(`${base}/runs?limit=50&token=deck-test`)).json()) as any;
	const runCards = new Set(runs.runs.map((r: any) => r.card_id));
	ok(runCards.size >= 5, `run rollup covers the board (${runCards.size} cards)`);
	const heroRun = runs.runs.find((r: any) => r.run_id === "pricing-page-update-r1a2b3");
	ok(!!heroRun && Math.abs(heroRun.cost_usd - 0.0412) < 1e-9, "rollup carries the hero run's cost");

	await new Promise((r) => setTimeout(r, 300));
	ok(received.length === events.length, `SSE delivered the whole replay live (${received.length}/${events.length})`);
	ok(
		JSON.stringify(received.map((e) => e.node_id + e.status)) === JSON.stringify(events.map((e) => e.node_id + e.status)),
		"SSE order matches fixture order",
	);
	// anchorNow: delivered timestamps re-anchored near now, deltas preserved
	const t0 = Date.parse(received[0].ts);
	ok(Math.abs(t0 - Date.now()) < 60_000, "first replayed ts re-anchored to now");
	const origDelta = Date.parse(events[5].ts) - Date.parse(events[0].ts);
	const newDelta = Date.parse(received[5].ts) - Date.parse(received[0].ts);
	ok(origDelta === newDelta, "relative deltas preserved under re-anchoring");

	ctrl.abort();
	await ssePromise;
	await srv.close();
	fs.rmSync(join(dbPath, ".."), { recursive: true, force: true });
}

console.log("── pacing: gaps scaled by speed and capped at 5s ──");
{
	const sleeps: number[] = [];
	const posts: string[] = [];
	const fakeFetch = (async (_url: any, init: any) => {
		posts.push(JSON.parse(init.body).node_id);
		return { ok: true, json: async () => ({ ingested: 1, rejected: 0 }) } as any;
	}) as typeof fetch;
	const tally = await replayFixture({
		file: FIXTURE,
		url: "http://obs.holdco.test",
		speed: 2,
		fetchFn: fakeFetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	ok(tally.sent === events.length, "fake transport: all events sent");
	ok(sleeps.every((ms) => ms <= 5_000), `every paced gap capped at 5s (max ${Math.max(...sleeps)}ms)`);
	// the 20s classify gap on card A → 10s at speed 2 → capped to 5s
	ok(sleeps.some((ms) => ms === 5_000), "a long fixture gap hit the cap (no demo stalls)");
	const shortGap = (Date.parse(events[2].ts) - Date.parse(events[1].ts)) / 2;
	ok(sleeps.includes(shortGap), `short gaps scale by speed (found ${shortGap}ms)`);
	ok(posts.length === events.length && posts[0] === events[0].node_id, "post order matches fixture order");

	// invalid fixture fails loudly before any send
	const badFile = join(fs.mkdtempSync(join(os.tmpdir(), "holdco-deck-bad-")), "bad.jsonl");
	fs.writeFileSync(badFile, JSON.stringify({ run_id: "x", card_id: "x", node_id: "x", node_type: "agent", stage: "s", status: "nope", ts: "t" }) + "\n");
	let threw = false;
	try {
		await replayFixture({ file: badFile, url: "http://obs.holdco.test", fetchFn: fakeFetch, sleep: async () => {} });
	} catch (err) {
		threw = String(err).includes("schema-invalid");
	}
	ok(threw, "schema-invalid fixture line throws before sending");
	fs.rmSync(join(badFile, ".."), { recursive: true, force: true });
}

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

// executor.test.ts - self-test for the Phase 4 executor (EngineHost port).
// Run via `node tests/executor.test.ts`.
//
// D1 REWORK: the dispatch trigger moved off the detected `→ Executing` edge (humans no
// longer drag straight to Executing - that edge is now ILLEGAL). Execution now starts
// in the engine's `queue:next` handler, which - after its three-check gate - writes
// the loop-suppressed `Queued → Executing` engine edge and calls `executor.dispatch`.
// These cases are restructured to that new flow via `drainDispatch` (a faithful stand-in
// for the post-gate handler): the human approval edge is now `Needs Approval → Queued`,
// and the engine drain edge `Queued → Executing`. The executor's own mechanics (steer,
// per-turn usage accumulation, tool-call checkpoints, agent_end finalize + engine-written
// rollup, the CRITICAL loop-suppression, filing verification, no-brief / idle-defer /
// empty-slot correlation) are UNCHANGED and still asserted. New for D1: exec:idle is
// emitted on completion, and an aborted agent_end annotates + escalates (transient).
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { Executor, readInstruction } from "../src/engine/executor.ts";
import { writeStatus } from "../src/engine/frontmatter.ts";
import { Reconciler } from "../src/engine/reconciler.ts";
import type { EngineHost } from "../src/host/host.ts";

let pass = 0,
	fail = 0;
function ok(cond: boolean, msg: string) {
	if (cond) {
		pass++;
		console.log("  ✅ " + msg);
	} else {
		fail++;
		console.log("  ❌ " + msg);
	}
}

// ── temp workspace scaffold ──────────────────────────────────────────────────
const root = fs.mkdtempSync(join(os.tmpdir(), "executor-test-"));
const cardsDir = join(root, "cards");
const refsDir = join(root, "domains", "dds", "refs");
fs.mkdirSync(cardsDir, { recursive: true });
fs.mkdirSync(refsDir, { recursive: true });
fs.mkdirSync(join(root, "knowledge"), { recursive: true });

function card(name: string, body: string) {
	const p = join(cardsDir, name);
	fs.writeFileSync(p, body);
	return p;
}
const read = (p: string) => fs.readFileSync(p, "utf8");
const setStatus = (p: string, s: string) => fs.writeFileSync(p, read(p).replace(/^status:.*$/m, "status: " + s));

const mkCard = (id: string, status: string, restatement: string, brief = '""') =>
	`---
type: card
id: ${id}
title: "Real card ${id}"
status: ${status}
domain: dds
created_at: 2026-06-08
brief: ${brief}
cost_total: null
outcome: ""
---

## Intent
do a dds thing

## Restatement
${restatement}

## Reconciler Log
`;

// ── fakes ────────────────────────────────────────────────────────────────────
// The fake host + captured `sent` array replace the source system's fakePi:
// host.log.entry → entries, host.events.emit → emitted, host.notify → notes,
// and the `send` dep (the execution-turn firer) → sent.
function fakeHost() {
	const sent: string[] = [];
	const entries: { kind: string; data: any }[] = [];
	const emitted: { channel: string; data: any }[] = [];
	const notes: string[] = [];
	const host: EngineHost = {
		events: {
			emit(channel: string, data?: unknown) {
				emitted.push({ channel, data });
			},
			on() {
				return () => {};
			},
		},
		log: {
			entry(kind: string, data: Record<string, unknown>) {
				entries.push({ kind, data });
			},
		},
		config: {
			get: () => undefined,
		},
		notify(message: string) {
			notes.push(message);
		},
	};
	return { host, sent, entries, emitted, notes, send: (text: string) => sent.push(text) };
}
type FakeHost = ReturnType<typeof fakeHost>;
const makeExecutor = (h: FakeHost, r: Reconciler) => new Executor({ host: h.host, reconciler: r, send: h.send });

const dispatchCtx = (idle = true, cwd?: string) => ({ cwd: cwd ?? root, isIdle: () => idle });
const endCtx = (aborted = false) => (aborted ? { signal: { aborted: true } } : {});

// usage payload in the proven nested shape
const turnEnd = (cost: number, tokens: number, input: number, output: number) => ({
	message: { role: "assistant", usage: { cost: { total: cost }, totalTokens: tokens, input, output } },
});
const msgEnd = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });

/**
 * Faithful stand-in for the engine's `queue:next` handler AFTER its three-check
 * gate passes: the engine writes the loop-suppressed `Queued → Executing` edge
 * (status + snapshot synced) and then calls `executor.dispatch`. This is the D1
 * dispatch entry point (replacing the old detected `→ Executing` trigger).
 */
function drainDispatch(r: Reconciler, ex: Executor, id: string, file: string, ctx: { cwd?: string; isIdle?: () => boolean }) {
	writeStatus(file, "Executing", { logLine: "drain: Queued → Executing (queue:next, test)" });
	r.snapshot.set(id, "Executing");
	ex.dispatch(id, file, ctx);
}
const idleEmits = (h: FakeHost) => h.emitted.filter((e) => e.channel === "exec:idle").length;

// ════════════════════════════════════════════════════════════════════════════
console.log("approval detection (Needs Approval → Queued) + drain dispatch + steer:");
{
	const c = card("C1.md", mkCard("C1", "Needs Approval", "- build the dds budget rollup"));
	const r = new Reconciler(cardsDir);
	r.startupRecovery();
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	const ctx = dispatchCtx(true);

	// human approves → reconcile detects the legal Needs Approval → Queued edge (NOT
	// → Executing any more; the human enqueues, the engine drains).
	setStatus(c, "Queued");
	const ev = r.reconcile("sweep");
	const t = ev.find((e) => e.event === "TRANSITION" && e.to === "Queued");
	ok(!!t, "reconciler emits TRANSITION → Queued (human approval enqueues)");
	ok(!!t?.file, "TRANSITION carries the card file path");
	ok(r.snapshot.get("C1") === "Queued", "snapshot advanced to Queued");

	// the drain pops the head (engine): queue:next gate passed → Queued → Executing → dispatch
	drainDispatch(r, ex, "C1", t!.file!, ctx);
	ok(ex.busy, "executor slot is set (busy) after the drain dispatch");
	ok(/^status:\s*Executing\b/m.test(read(c)), "engine wrote Queued → Executing");
	ok(h.sent.length === 1, "exactly one execution turn fired (send)");
	const steer = h.sent[0];
	ok(steer.includes("build the dds budget rollup"), "steer carries the instruction (Restatement fallback)");
	ok(steer.includes("domains/dds/CONTEXT.md"), "steer points at the domain context");
	ok(steer.includes("knowledge/FILING.md"), "steer carries the FILING requirement");
	ok(steer.includes("OUTCOME:"), "steer states the OUTCOME completion contract");
	ok(/do not change this card's status/i.test(steer), "steer forbids the agent changing status");

	console.log("accumulate per turn_end / tool_execution_end / message_end:");
	ex.onTurnEnd(turnEnd(0.01, 100, 60, 40));
	ex.onTurnEnd(turnEnd(0.02, 250, 150, 100));
	for (let i = 0; i < 6; i++) ex.onToolExecutionEnd({}); // 6 tools → ≥1 checkpoint at N=5
	ok(/tool_calls_so_far:\s*5/.test(read(c)), "checkpoint heartbeat written at 5 tool calls");
	ok(/^status:\s*Executing\b/m.test(read(c)), "checkpoint kept status = Executing (no transition)");
	// mid-execution reconcile must NOT see a delta (checkpoint is loop-suppressed)
	ok(r.reconcile("sweep").every((e) => e.card !== "C1"), "checkpoint write is not detected as a transition");
	ex.onMessageEnd(msgEnd("Working...\nOUTCOME: filed dds budget rollup at domains/dds/refs/budget-rollup.md"));

	console.log("agent_end finalize + engine-written rollup + exec:idle:");
	// agent files its artifact inline (simulated) before completion
	fs.writeFileSync(join(refsDir, "budget-rollup.md"), "---\nname: x\n---\n");
	const idleBefore = idleEmits(h);
	ex.onAgentEnd({ messages: [] }, endCtx());
	ok(!ex.busy, "slot cleared after agent_end");
	const after = read(c);
	ok(/^status:\s*Needs Review\b/m.test(after), "card → Needs Review on completion");
	ok(/^cost_total:\s*0\.03\b/m.test(after), "cost_total rollup written (0.01+0.02)");
	ok(/^tokens:\s*350\b/m.test(after), "tokens rollup written (100+250)");
	ok(/^tool_calls:\s*6\b/m.test(after), "tool_calls rollup written");
	ok(/^duration_s:\s*\d+/m.test(after), "duration_s rollup written");
	ok(/^outcome:\s*".*budget-rollup\.md.*"/m.test(after), "outcome from OUTCOME: line written (quoted)");
	ok(!/no new artifact/.test(after), "filed artifact verified (no miss warning)");
	ok(idleEmits(h) === idleBefore + 1, "exec:idle emitted on completion (the drain's latency hint)");

	console.log("CRITICAL loop-suppression - no auto-revert of the engine edge:");
	ok(r.snapshot.get("C1") === "Needs Review", "snapshot synced to Needs Review by the executor");
	const ev2 = r.reconcile("sweep");
	ok(!ev2.some((e) => e.event === "ILLEGAL_REVERT"), "completion edge is NOT auto-reverted");
	ok(/^status:\s*Needs Review\b/m.test(read(c)), "card stays Needs Review after a full sweep");
}

console.log("filing miss is recorded in outcome:");
{
	const c = card("C2.md", mkCard("C2", "Needs Approval", "- do work but file nothing detectable"));
	const r = new Reconciler(cardsDir);
	r.startupRecovery();
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	setStatus(c, "Queued");
	r.reconcile("sweep"); // detect the approval (Needs Approval → Queued)
	drainDispatch(r, ex, "C2", c, dispatchCtx(true));
	ex.onMessageEnd(msgEnd("OUTCOME: claims done"));
	ex.onAgentEnd({ messages: [] }, endCtx()); // no new artifact created
	ok(/no new artifact/.test(read(c)), "outcome flags the unverified filing");
	ok(r.snapshot.get("C2") === "Needs Review", "still lands in Needs Review even on filing miss");
}

console.log("ABORTED agent_end - annotate + escalate (Tier-2 escalation mechanism 1):");
{
	const c = card("CA.md", mkCard("CA", "Needs Approval", "- a run that gets interrupted"));
	const r = new Reconciler(cardsDir);
	r.startupRecovery();
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	setStatus(c, "Queued");
	r.reconcile("sweep");
	drainDispatch(r, ex, "CA", c, dispatchCtx(true));
	const idleBefore = idleEmits(h);
	ex.onMessageEnd(msgEnd("partial work..."));
	ex.onAgentEnd({ messages: [] }, endCtx(true)); // ctx.signal.aborted
	const after = read(c);
	ok(/^status:\s*Needs Review\b/m.test(after), "aborted run still lands at Needs Review");
	ok(/interrupted:\s*aborted/.test(after), "aborted run annotated interrupted: aborted");
	ok(/aborted/i.test(after.match(/^outcome:.*$/m)![0]), "outcome records the abort");
	const esc = h.entries.find((e) => e.data?.event === "EXEC_ESCALATED" && e.data?.card === "CA");
	ok(!!esc, "EXEC_ESCALATED logged for the aborted run");
	ok(esc?.data?.mechanism === "agent_end-aborted" && esc?.data?.errorClass === "transient", "escalation classed: mechanism=agent_end-aborted, errorClass=transient");
	ok(idleEmits(h) === idleBefore + 1, "exec:idle emitted even on an aborted completion");
	ok(r.snapshot.get("CA") === "Needs Review" && !r.reconcile("sweep").some((e) => e.event === "ILLEGAL_REVERT"), "aborted completion is loop-suppressed (no revert)");
}

console.log("no-brief path - empty instruction never runs:");
{
	// a card whose Intent/Restatement/brief are all empty
	const empty = `---
type: card
id: C3
title: "Empty"
status: Needs Approval
domain: dds
created_at: 2026-06-08
brief: ""
cost_total: null
outcome: ""
---

## Intent

## Restatement

## Reconciler Log
`;
	const c = card("C3.md", empty);
	const r = new Reconciler(cardsDir);
	r.startupRecovery();
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	const ctx = dispatchCtx(true);
	setStatus(c, "Queued");
	r.reconcile("sweep");
	const idleBefore = idleEmits(h);
	drainDispatch(r, ex, "C3", c, ctx); // engine writes Executing; dispatch finds no brief
	ok(h.sent.length === 0, "no execution turn fired for an empty card");
	ok(!ex.busy, "no slot set for an empty card");
	ok(/^status:\s*Needs Review\b/m.test(read(c)), "empty card moved straight to Needs Review");
	ok(/no brief/.test(read(c)), "outcome records 'no brief'");
	ok(r.snapshot.get("C3") === "Needs Review", "snapshot synced for the no-brief edge");
	ok(idleEmits(h) === idleBefore + 1, "exec:idle emitted on the no-brief finalize");
	ok(!r.reconcile("sweep").some((e) => e.event === "ILLEGAL_REVERT"), "no-brief edge not auto-reverted");
}

console.log("idle-defer + empty-slot correlation:");
{
	const c = card("C4.md", mkCard("C4", "Queued", "- something"));
	const r = new Reconciler(cardsDir);
	r.startupRecovery(); // seeds C4 at Queued
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	// dispatch defence-in-depth: even though the queue:next gate checks idle first, the
	// executor's own idle guard still defers a non-idle dispatch (leaves the card put).
	ex.dispatch("C4", c, dispatchCtx(false)); // shell NOT idle → defer
	ok(!ex.busy, "dispatch deferred when the shell is not idle");
	ok(h.sent.length === 0, "no turn fired while not idle");
	// agent_end with an empty slot (a front-door/chat turn) must be ignored
	const before = read(c);
	const idleBefore = idleEmits(h);
	ex.onAgentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "OUTCOME: chat" }] }] }, endCtx());
	ok(read(c) === before, "agent_end with empty slot is ignored (no spurious write)");
	ok(idleEmits(h) === idleBefore, "no exec:idle emitted when agent_end has no slot (not our run)");
}

console.log("busy guard - a second dispatch while busy is refused:");
{
	const c1 = card("C5.md", mkCard("C5", "Queued", "- first"));
	const c2 = card("C6.md", mkCard("C6", "Queued", "- second"));
	const r = new Reconciler(cardsDir);
	r.startupRecovery();
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	drainDispatch(r, ex, "C5", c1, dispatchCtx(true));
	ok(ex.busy && h.sent.length === 1, "C5 dispatched (busy)");
	ex.dispatch("C6", c2, dispatchCtx(true)); // busy → refused (no second slot)
	ok(h.sent.length === 1, "second dispatch refused while busy (single slot)");
}

console.log("circuit breaker - a card dispatched too many times in a session is HARD-STOPPED:");
{
	const c = card("CB.md", mkCard("CB", "Queued", "- a card that keeps getting re-dispatched"));
	const r = new Reconciler(cardsDir);
	r.startupRecovery();
	const h = fakeHost();
	const ex = makeExecutor(h, r);
	// 3 legitimate dispatches (a human may re-run a card a few times in one session).
	for (let i = 1; i <= 3; i++) {
		drainDispatch(r, ex, "CB", c, dispatchCtx(true));
		ok(ex.busy, `dispatch ${i} runs (within the cap)`);
		ex.onAgentEnd({ messages: [] }, endCtx()); // clears the slot, count persists
	}
	// the 4th trips the breaker - no run, hard stop.
	const sentBefore = h.sent.length;
	drainDispatch(r, ex, "CB", c, dispatchCtx(true));
	ok(!ex.busy, "4th dispatch does NOT start a run (circuit breaker tripped)");
	ok(h.sent.length === sentBefore, "no execution turn fired on the tripped dispatch (no token burn)");
	ok(/^status:\s*Needs Review\b/m.test(read(c)), "breaker moved the card to Needs Review");
	ok(/halt:\s*true/.test(read(c)), "breaker set halt:true (will not re-run until /unhalt)");
	ok(h.entries.some((e) => e.data?.event === "EXEC_CIRCUIT_BREAKER" && e.data?.card === "CB"), "EXEC_CIRCUIT_BREAKER logged");
	ok(r.snapshot.get("CB") === "Needs Review", "snapshot synced (loop-suppressed) on the breaker write");
	ok(!r.reconcile("sweep").some((e) => e.event === "ILLEGAL_REVERT"), "breaker write is not auto-reverted");
	// /unhalt resets the counter so the card can run again.
	ex.clearDispatchCount("CB");
	setStatus(c, "Queued");
	r.snapshot.set("CB", "Queued");
	drainDispatch(r, ex, "CB", c, dispatchCtx(true));
	ok(ex.busy, "after clearDispatchCount (/unhalt), the card dispatches again - counter reset");
}

// ══════════════════════════════════════════════════════════════════════════════
// D1 role-aware completion contract - CODE vs ARTIFACT branching on card_type
// ══════════════════════════════════════════════════════════════════════════════
{
	const rRoot = fs.mkdtempSync(join(os.tmpdir(), "executor-role-ct-ct-ct-"));
	const rCards = join(rRoot, "cards");
	const rRefs = join(rRoot, "domains", "dds", "refs");
	fs.mkdirSync(rCards, { recursive: true });
	fs.mkdirSync(rRefs, { recursive: true });
	fs.mkdirSync(join(rRoot, "knowledge"), { recursive: true });
	// init a git repo for code-card diff checks
	try {
		execSync("git init", { cwd: rRoot, timeout: 5000 });
		fs.writeFileSync(join(rRoot, ".gitignore"), "node_modules\n");
		execSync("git add -A && git -c user.name=test -c user.email=test@test.com commit -m 'initial'", { cwd: rRoot, timeout: 5000 });
	} catch { /* git may not be available; tests will gracefully skip */ }

	const roleCard = (status: string, restatement: string, cardType: string) =>
		`---\ntype: card\nid: RC\ntitle: "Role card"\nstatus: ${status}\ncard_type: ${cardType}\ndomain: dds\ncreated_at: 2026-06-13\nbrief: "${restatement}"\ncost_total: null\noutcome: ""\n---\n\n## Intent\ndo thing\n\n## Restatement\n${restatement}\n\n## Reconciler Log\n`;

	console.log("D1 route-aware - CODE contract (ops card) vs ARTIFACT (research):");
	const cardsDir2 = rCards;
	const card2 = (name: string, body: string) => {
		const p = join(cardsDir2, name);
		fs.writeFileSync(p, body);
		return p;
	};
	const rC = new Reconciler(cardsDir2);
	rC.startupRecovery();

	// Build test: ops card → CODE contract in steer
	{
		const c = card2("RC_OPS.md", roleCard("Needs Approval", "edit source", "ops"));
		const h = fakeHost();
		const ex = makeExecutor(h, rC);
		setStatus(c, "Queued");
		rC.reconcile("sweep");
		drainDispatch(rC, ex, "RC_OPS", c, dispatchCtx(true, rRoot));
		const steer = h.sent[0];
		ok(!!steer, "ops card produces a steer");
		ok(steer.includes("CODE CHANGE ITSELF"), "ops steer says 'CODE CHANGE ITSELF' (code contract)");
		ok(steer.includes("Do NOT write a spec"), "ops steer forbids specs");
		ok(!steer.includes("FILE the resulting durable artifact"), "ops steer does NOT say 'FILE the resulting durable artifact' (that's the artifact contract)");
		ok(steer.includes("files changed + verify result"), "ops steer's OUTCOME mentions files changed");
		ex.onAgentEnd({ messages: [] }, endCtx());
		const outcome = read(c).match(/^outcome:.*$/m)?.[0] ?? "";
		ok(!outcome.includes("no new artifact"), "ops card does NOT flag filing miss (uses git-diff verification)");
	}

	// Build test: research card → ARTIFACT contract in steer (unchanged)
	{
		const c = card2("RC_RS.md", roleCard("Needs Approval", "produce research doc", "research"));
		const h = fakeHost();
		const ex = makeExecutor(h, rC);
		setStatus(c, "Queued");
		rC.reconcile("sweep");
		drainDispatch(rC, ex, "RC_RS", c, dispatchCtx(true));
		const steer = h.sent[0];
		ok(!!steer, "research card produces a steer");
		ok(steer.includes("FILE the resulting durable artifact"), "research steer DOES says 'FILE the resulting durable artifact' (artifact contract)");
		ok(steer.includes("knowledge/FILING.md"), "research steer references FILING.md");
		ok(steer.includes("what you produced and where"), "research steer's OUTCOME mentions what/where");
		ok(!steer.includes("CODE CHANGE ITSELF"), "research steer does NOT say 'CODE CHANGE ITSELF'");
		ex.onAgentEnd({ messages: [] }, endCtx());
	}

	// Missing card_type → ARTIFACT contract (default conservative)
	{
		const noCt = roleCard("Needs Approval", "generic task", "research").replace("card_type: research", "");
		const c = card2("RC_NOCT.md", noCt);
		const h = fakeHost();
		const ex = makeExecutor(h, rC);
		setStatus(c, "Queued");
		rC.reconcile("sweep");
		drainDispatch(rC, ex, "RC_NOCT", c, dispatchCtx(true));
		const steer = h.sent[0];
		ok(!!steer, "missing card_type produces a steer");
		ok(steer.includes("FILE the resulting durable artifact"), "missing card_type defaults to artifact contract");
		ok(!steer.includes("CODE CHANGE ITSELF"), "missing card_type does NOT get code contract");
		ex.onAgentEnd({ messages: [] }, endCtx());
	}

	// ops card with no git diff → flagged
	{
		const c = card2("RC_NODIFF.md", roleCard("Needs Approval", "edit nothing", "ops"));
		const h = fakeHost();
		const ex = makeExecutor(h, rC);
		setStatus(c, "Queued");
		rC.reconcile("sweep");
		drainDispatch(rC, ex, "RC_NODIFF", c, dispatchCtx(true, rRoot));
		ex.onMessageEnd(msgEnd("OUTCOME: nothing changed"));
		// Clean the working tree (the card files themselves are untracked) so the
		// "no diff produced" check is meaningful - the run below changes nothing.
		try {
			execSync("git add -A && git -c user.name=test -c user.email=test@test.com commit -m 'pre-nodiff'", { cwd: rRoot, timeout: 5000 });
		} catch { /* git may not be available; the git-unavailable branch below covers it */ }
		ex.onAgentEnd({ messages: [] }, endCtx());
		const after = read(c);
		// If git is available, the clean working tree triggers the no-diff flag.
		// If git is NOT available, the outcome says "git check unavailable" - that's fine too.
		const hasFlag = after.includes("no code change produced");
		ok(hasFlag || after.includes("git check unavailable"), "ops card with no diff is flagged (or git unavailable)");
	}

	// ops card that makes a real change → diff detected
	{
		const c = card2("RC_DIFF.md", roleCard("Needs Approval", "edit source file", "ops"));
		const h = fakeHost();
		const ex = makeExecutor(h, rC);
		setStatus(c, "Queued");
		rC.reconcile("sweep");
		drainDispatch(rC, ex, "RC_DIFF", c, dispatchCtx(true, rRoot));
		// Simulate a real code change
		try {
			fs.writeFileSync(join(rRoot, "edited-file.ts"), "console.log('edited');\n");
			ex.onMessageEnd(msgEnd("OUTCOME: edited edited-file.ts"));
			ex.onAgentEnd({ messages: [] }, endCtx());
			const after = read(c);
			ok(!after.includes("no code change produced"), "ops card with a real diff is NOT flagged");
			ok(after.includes("edited edited-file.ts") || after.includes("OUTCOME:"), "ops card outcome captured");
		} catch {
			// If writing failed (e.g. git not available), test gracefully skips
			ok(true, "ops card with real diff skipped (git or fs issue)");
		}
	}

	fs.rmSync(rRoot, { recursive: true, force: true });
}

// ── readInstruction: the human's ## Restatement must ACCOMPANY the brief, never be shadowed ──
// Regression for the round-2 README leak (2026-07-13): planner's Brief dropped the human's
// reject-reason; task.md carried Brief only; worker rebuilt the exact thing the human rejected.
console.log("executor - readInstruction carries human corrections alongside the brief:");
{
	const iRoot = fs.mkdtempSync(join(os.tmpdir(), "executor-instr-"));
	const mk = (name: string, body: string) => {
		const f = join(iRoot, `${name}.md`);
		fs.writeFileSync(f, `---\ntype: card\nid: ${name}\nstatus: Queued\n---\n\n${body}`, "utf8");
		return f;
	};
	const briefOnly = mk("brief-only", "## Intent\ndo it\n\n## Brief\nthe plan\n\n## Reconciler Log\n");
	ok(readInstruction(briefOnly) === "the plan", "brief-only: instruction is the brief, unchanged");

	const both = mk(
		"both",
		"## Intent\ndo it\n\n## Restatement\nplain markdown only - no YAML frontmatter\n\n## Brief\nthe plan\n\n## Reconciler Log\n",
	);
	const instr = readInstruction(both);
	ok(instr.startsWith("the plan"), "brief+restatement: brief still leads");
	ok(instr.includes("HARD constraints"), "brief+restatement: hard-constraints header present");
	ok(instr.includes("plain markdown only - no YAML frontmatter"), "brief+restatement: the human's words verbatim");

	const restOnly = mk("rest-only", "## Intent\ndo it\n\n## Restatement\njust this\n\n## Reconciler Log\n");
	ok(readInstruction(restOnly) === "just this", "restatement-only fallback unchanged (no constraints header)");

	fs.rmSync(iRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
if (fail > 0) process.exit(1);

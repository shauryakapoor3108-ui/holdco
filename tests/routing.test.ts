// routing.test.ts — classifier + cost-aware model routing: the rules classifier's
// decisions, the tolerant routing-table loader, and the orchestrator's triage
// stage (decision written onto the card, human-pinned models never overridden,
// no reconcile delta). The headless model classifier's FALLBACK path is covered
// hermetically (a dead binary must degrade to rules, never block the board).
// Run via `node tests/routing.test.ts`.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { CardEngine } from "../src/engine/core.ts";
import { Orchestrator } from "../src/engine/orchestrate.ts";
import { WorkerPool } from "../src/engine/worker-pool.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";
import { createStandaloneHost } from "../src/host/host.ts";
import type { Harness, HarnessArtifacts, HarnessSession, PollResult, SpawnRequest } from "../src/harness/types.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";
import { HeadlessModelClassifier, RuleClassifier } from "../src/routing/classify.ts";
import { DEFAULT_ROUTING, loadRoutingTable, routeFor } from "../src/routing/table.ts";

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

console.log("── RuleClassifier decisions ──");
{
	const r = new RuleClassifier();
	const c1 = await r.classify({ id: "a", title: "Fix typo in README", cardType: "maintenance", instruction: "rename the header" });
	ok(c1.class === "chore" && c1.complexity === "deterministic" && c1.delegation === "auto", "mechanical change → chore/deterministic/auto");
	const c2 = await r.classify({ id: "b", title: "Design the billing architecture", cardType: "strategy", instruction: "produce a plan" });
	ok(c2.class === "plan" && c2.delegation === "human", "strategy/design → plan, human-gated");
	const c3 = await r.classify({ id: "c", title: "Review the auth diff", cardType: "ops", instruction: "review this change for bugs" });
	ok(c3.class === "review" && c3.delegation === "human", "review language → review, human-gated");
	const c4 = await r.classify({ id: "d", title: "Compare vector DB options", cardType: "research", instruction: "summarize trade-offs" });
	ok(c4.class === "research" && c4.outcome === "artifact", "research → research/artifact");
	const c5 = await r.classify({ id: "e", title: "Add rate limiting to the API", cardType: "ops", instruction: "implement per-user rate limits" });
	ok(c5.class === "feature" && c5.outcome === "code", "substantive ops change → feature/code");
	ok([c1, c2, c3, c4, c5].every((c) => c.via === "rules" && c.rationale.length > 0), "every decision carries via=rules + a rationale");
}

console.log("── routing table: loader tolerance + routeFor ──");
{
	const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-routing-"));
	ok(loadRoutingTable(root) === DEFAULT_ROUTING, "missing file → built-in defaults");
	fs.mkdirSync(join(root, "knowledge"), { recursive: true });
	fs.writeFileSync(join(root, "knowledge", "routing.json"), "{bad json");
	const warns: string[] = [];
	ok(loadRoutingTable(root, (m) => warns.push(m)) === DEFAULT_ROUTING && warns.length === 1, "malformed file → defaults + warning");
	fs.writeFileSync(
		join(root, "knowledge", "routing.json"),
		JSON.stringify({ version: 2, tiers: { workhorse: "custom-cheap" }, routes: { chore: "workhorse", weird: "nonsense" } }),
	);
	const t = loadRoutingTable(root, (m) => warns.push(m));
	ok(t.tiers.workhorse === "custom-cheap" && t.tiers.frontier === DEFAULT_ROUTING.tiers.frontier, "partial tiers merge over defaults");
	ok(!("weird" in t.routes) && warns.some((w) => w.includes("weird")), "unknown tier route ignored + warned");
	ok(routeFor(t, "chore").model === "custom-cheap", "routeFor resolves chore → workhorse → custom model");
	ok(routeFor(t, "never-seen").tier === t.routes.default, "unknown class routes via default");
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("── HeadlessModelClassifier: dead binary degrades to rules ──");
{
	const h = new HeadlessModelClassifier({ model: "any", claudeBin: "/nonexistent/holdco-claude", timeoutMs: 2000 });
	const c = await h.classify({ id: "x", title: "Fix typo", cardType: "maintenance", instruction: "rename a header" });
	ok(c.class === "chore" && c.via === "rules", "fallback classification is the rules verdict");
	ok(/fallback/.test(c.rationale), "rationale names the fallback");
}

console.log("── orchestrator triage: decision lands on the card ──");
{
	const board = fs.mkdtempSync(join(os.tmpdir(), "holdco-triage-"));
	const cards = join(board, "cards");
	fs.mkdirSync(cards, { recursive: true });
	fs.writeFileSync(join(board, "README.md"), "x\n");
	execSync("git init -qb main && git add -A && git -c user.name=t -c user.email=t@holdco.test commit -qm init", { cwd: board, stdio: "pipe" });

	const mk = (id: string, extra = "") =>
		fs.writeFileSync(
			join(cards, `${id}.md`),
			`---\ntype: card\nid: ${id}\ntitle: "Fix typo in docs"\nstatus: Needs Approval\ncard_type: maintenance\ndomain: root\n${extra}---\n\n## Brief\nrename the misspelled header\n\n## Reconciler Log\n`,
		);
	mk("t1");
	mk("t2", "model: pinned-by-human\n");

	const host = createStandaloneHost({ flags: { "cards-dir": cards, "card-events-off": "true", "card-sweep-ms": "3600000" }, quiet: true, sink: () => {} });
	const engine = new CardEngine(host, { cwd: board, noLease: true });
	engine.start();
	const store = new KnowledgeStore(board, host);
	store.ensure();
	const spawns: SpawnRequest[] = [];
	const fake: Harness = {
		name: "fake",
		async spawn(req: SpawnRequest): Promise<HarnessSession> {
			spawns.push(req);
			fs.writeFileSync(join(req.workspace.scopedDir, "prompt.md"), req.instruction);
			return { harness: "fake", cardId: req.workspace.cardId, runId: req.runId, promptRef: join(req.workspace.scopedDir, "prompt.md"), startedAt: Date.now() };
		},
		async inject(): Promise<boolean> {
			return true;
		},
		async poll(): Promise<PollResult> {
			return { state: "working" };
		},
		async collect(s: HarnessSession): Promise<HarnessArtifacts> {
			return { outcome: "n/a", outputTail: "", usage: null, transcriptRef: null, promptRef: s.promptRef };
		},
		async dispose(): Promise<void> {},
	};
	const scopedBase = join(board, ".scoped");
	const wsMgr = new WorkspaceManager({ host, scopedBase });
	const pool = new WorkerPool({ host, reconciler: engine.reconciler!, harnesses: { fake }, defaultHarness: "fake", maxSlots: 4, cardBudgetUsd: 5, watchdogMs: 60_000, wsMgr, scopedBase, knowledge: store });
	const orch = new Orchestrator({ host, engine, pool, wsMgr, cwd: board, classifier: new RuleClassifier(), routing: loadRoutingTable(board), knowledge: store });

	// approve both cards
	for (const id of ["t1", "t2"]) {
		const f = join(cards, `${id}.md`);
		fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^status:.*$/m, "status: Queued"));
	}
	engine.runReconcile("sweep");
	await orch.drain(); // pass 1: intake (worktrees)
	await new Promise((r) => setTimeout(r, 300));
	await orch.drain(); // pass 2: classify + dispatch
	await pool.settleLaunches();

	const t1 = fs.readFileSync(join(cards, "t1.md"), "utf8");
	ok(/^class:\s*chore/m.test(t1), "class annotation written (chore)");
	ok(/^tier:\s*workhorse/m.test(t1), "tier annotation written (workhorse)");
	ok(new RegExp(`^model:\\s*${DEFAULT_ROUTING.tiers.workhorse}`, "m").test(t1), "routed model written to the card");
	ok(/^classified_by:\s*rules/m.test(t1), "classified_by recorded");
	ok(/classified chore → workhorse/.test(t1), "tier decision logged on the card's Reconciler Log");
	const s1 = spawns.find((s) => s.workspace.cardId === "t1");
	ok(s1?.model === DEFAULT_ROUTING.tiers.workhorse, "SpawnRequest carries the routed workhorse model");

	const t2 = fs.readFileSync(join(cards, "t2.md"), "utf8");
	ok(/^model:\s*pinned-by-human/m.test(t2), "human-pinned model NOT overridden");
	ok(/^class:\s*chore/m.test(t2) && /model pinned/.test(t2), "pinned card still classified + pin noted in the log");
	const s2 = spawns.find((s) => s.workspace.cardId === "t2");
	ok(s2?.model === "pinned-by-human", "SpawnRequest honors the pinned model");

	ok(store.readMessages("t1").some((m) => /classified chore/.test(m.text)), "classification recorded in the message log");
	const events = engine.runReconcile("sweep");
	ok(!events.some((e) => e.event === "ILLEGAL_REVERT"), "triage writes produce no reconcile delta (no revert)");

	engine.stop();
	fs.rmSync(board, { recursive: true, force: true });
}

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

// knowledge.test.ts - the unified knowledge layer: governed dir scaffold,
// single-source constraints, fail-safe permissions resolution, and the per-card
// append-only message log - plus the pool integration (constraints + policy flow
// from the store into the SpawnRequest; lifecycle entries land in the log).
// Run via `node tests/knowledge.test.ts`.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { Reconciler } from "../src/engine/reconciler.ts";
import { WorkerPool } from "../src/engine/worker-pool.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";
import { createStandaloneHost } from "../src/host/host.ts";
import type { Harness, HarnessArtifacts, HarnessSession, PollResult, SpawnRequest } from "../src/harness/types.ts";
import { KnowledgeStore, KNOWLEDGE_SCHEMA_VERSION } from "../src/knowledge/store.ts";

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

const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-knowledge-"));
const host = createStandaloneHost({ quiet: true, sink: () => {} });

console.log("── ensure() scaffolds, idempotently, never overwriting ──");
{
	const store = new KnowledgeStore(root, host);
	store.ensure();
	ok(fs.existsSync(join(root, "knowledge", "FILING.md")), "FILING.md seeded");
	ok(fs.existsSync(join(root, "knowledge", "constraints.md")), "constraints.md seeded");
	ok(fs.existsSync(join(root, "knowledge", "permissions.json")), "permissions.json seeded");
	ok(fs.existsSync(join(root, "knowledge", "messages")), "messages/ dir created");
	const perms = JSON.parse(fs.readFileSync(join(root, "knowledge", "permissions.json"), "utf8"));
	ok(perms.version === KNOWLEDGE_SCHEMA_VERSION, "seeded permissions carry the schema version");
	ok(perms.writeScopes.includes("{worktree}"), "seeded scopes use the {worktree} token");

	fs.writeFileSync(join(root, "knowledge", "constraints.md"), "---\nversion: 1\n---\nCUSTOM RULE ALPHA\n");
	store.ensure();
	ok(fs.readFileSync(join(root, "knowledge", "constraints.md"), "utf8").includes("CUSTOM RULE ALPHA"), "ensure() never overwrites an edited file");
}

console.log("── loadConstraints strips frontmatter; absent file → \"\" ──");
{
	const store = new KnowledgeStore(root, host);
	const text = store.loadConstraints();
	ok(text === "CUSTOM RULE ALPHA", `frontmatter stripped, body verbatim (got: ${JSON.stringify(text)})`);
	const empty = new KnowledgeStore(fs.mkdtempSync(join(os.tmpdir(), "holdco-know-empty-")), host);
	ok(empty.loadConstraints() === "", "absent constraints.md → empty string");
}

console.log("── policyFor: token resolution + fail-safe fallbacks ──");
{
	const store = new KnowledgeStore(root, host);
	const scope = { worktree: "/w/tree", scopedDir: "/s/dir" };

	fs.writeFileSync(
		join(root, "knowledge", "permissions.json"),
		JSON.stringify({ version: 1, writeScopes: ["{worktree}", "{scopedDir}", "/extra/allowed", "relative/ignored"], denyCommands: ["\\bgit\\s+push\\b"] }),
	);
	const p = store.policyFor(scope);
	ok(p.writeScopes.includes("/w/tree") && p.writeScopes.includes("/s/dir"), "{worktree}/{scopedDir} tokens resolved");
	ok(p.writeScopes.includes("/extra/allowed"), "extra absolute scope kept");
	ok(!p.writeScopes.some((s) => s.includes("relative")), "non-absolute scope filtered out");
	ok(p.denyCommands.length === 1 && p.denyCommands[0] === "\\bgit\\s+push\\b", "denyCommands pass through verbatim");

	fs.writeFileSync(join(root, "knowledge", "permissions.json"), "{ not json");
	const fb = store.policyFor(scope);
	ok(fb.writeScopes.length === 2 && fb.writeScopes[0] === "/w/tree", "malformed file → default deny posture (worktree-scoped)");
	ok(fb.denyCommands.some((d) => d.includes("git")), "fallback carries the default deny list");

	fs.writeFileSync(join(root, "knowledge", "permissions.json"), JSON.stringify({ version: 1, writeScopes: ["relative/only"], denyCommands: [] }));
	const zero = store.policyFor(scope);
	ok(zero.writeScopes.length === 2 && zero.denyCommands.length > 0, "zero resolved scopes → fallback (config can narrow, never widen)");

	// restore a sane file for the pool integration below
	fs.writeFileSync(
		join(root, "knowledge", "permissions.json"),
		JSON.stringify({ version: 1, writeScopes: ["{worktree}", "{scopedDir}"], denyCommands: ["\\bgit\\s+push\\b", "\\bgit\\s+commit\\b"] }),
	);
}

console.log("── message log: append-only, tolerant reader, sanitized ids ──");
{
	const store = new KnowledgeStore(root, host);
	store.appendMessage("m3", { author: "engine", kind: "status", text: "first" });
	store.appendMessage("m3", { author: "human", kind: "steer", text: "second", refs: { card: "cards/m3.md" } });
	const logPath = join(root, "knowledge", "messages", "m3.jsonl");
	ok(fs.existsSync(logPath), "log file per card under knowledge/messages/");
	fs.appendFileSync(logPath, '{"ts":"x","author":"crash"'); // partial line (crash mid-append)
	const entries = store.readMessages("m3");
	ok(entries.length === 2, "reader returns the complete entries");
	ok(entries[0].text === "first" && entries[1].text === "second", "entries in append order");
	ok(entries[1].refs?.card === "cards/m3.md", "refs survive the round trip");
	store.appendMessage("m3", { author: "engine", kind: "note", text: "third" });
	ok(store.readMessages("m3").length === 3, "append after a partial line still lands (append-only survives)");
	store.appendMessage("../evil", { author: "x", kind: "note", text: "y" });
	ok(!fs.existsSync(join(root, "knowledge", "evil.jsonl")) && fs.existsSync(join(root, "knowledge", "messages", ".._evil.jsonl")), "hostile card id cannot escape messages/");
}

console.log("── pool integration: store → SpawnRequest + lifecycle log entries ──");
{
	// real git repo + worktree so dispatch passes HARDENING 1 and the harvest runs
	const board = fs.mkdtempSync(join(os.tmpdir(), "holdco-know-board-"));
	const cards = join(board, "cards");
	fs.mkdirSync(cards, { recursive: true });
	fs.writeFileSync(join(board, "README.md"), "x\n");
	execSync("git init -qb main && git add -A && git -c user.name=t -c user.email=t@holdco.test commit -qm init", { cwd: board, stdio: "pipe" });

	const store = new KnowledgeStore(board, host);
	store.ensure();
	fs.writeFileSync(join(board, "knowledge", "constraints.md"), "---\nversion: 1\n---\nBOARD RULE OMEGA\n");
	fs.writeFileSync(
		join(board, "knowledge", "permissions.json"),
		JSON.stringify({ version: 1, writeScopes: ["{worktree}"], denyCommands: ["\\bcurl\\b"] }),
	);

	const file = join(cards, "k1.md");
	fs.writeFileSync(file, `---\ntype: card\nid: k1\nstatus: Executing\ncard_type: ops\ndomain: root\n---\n\n## Brief\ndo it\n\n## Reconciler Log\n`);
	const reconciler = new Reconciler(cards);
	reconciler.startupRecovery();
	reconciler.snapshot.set("k1", "Executing");

	const scopedBase = join(board, ".scoped");
	const wsMgr = new WorkspaceManager({ host, scopedBase });
	await wsMgr.onIntake("k1", file, board);

	const seen: SpawnRequest[] = [];
	const fake: Harness = {
		name: "fake",
		async spawn(req: SpawnRequest): Promise<HarnessSession> {
			seen.push(req);
			fs.writeFileSync(join(req.workspace.scopedDir, "prompt.md"), req.instruction);
			return { harness: "fake", cardId: req.workspace.cardId, runId: req.runId, promptRef: join(req.workspace.scopedDir, "prompt.md"), startedAt: Date.now() };
		},
		async inject(): Promise<boolean> {
			return true;
		},
		async poll(): Promise<PollResult> {
			return { state: "done" };
		},
		async collect(s: HarnessSession): Promise<HarnessArtifacts> {
			return { outcome: "did k1", outputTail: "OUTCOME: did k1", usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 }, transcriptRef: s.promptRef, promptRef: s.promptRef };
		},
		async dispose(): Promise<void> {},
	};
	const pool = new WorkerPool({
		host,
		reconciler,
		harnesses: { fake },
		defaultHarness: "fake",
		maxSlots: 1,
		cardBudgetUsd: 5,
		watchdogMs: 60_000,
		wsMgr,
		scopedBase,
		knowledge: store,
	});
	pool.dispatch("k1", file, { cwd: board });
	await pool.settleLaunches();
	ok(seen.length === 1, "worker spawned");
	ok(seen[0].constraints === "BOARD RULE OMEGA", "SpawnRequest carries the store's constraints text");
	ok(seen[0].policy.denyCommands.length === 1 && seen[0].policy.denyCommands[0] === "\\bcurl\\b", "SpawnRequest policy comes from permissions.json");
	ok(seen[0].policy.writeScopes.length === 1 && seen[0].policy.writeScopes[0] === wsMgr.getWorkspace("k1")!.worktreePath, "policy {worktree} token resolved to the card's real worktree");
	await pool.sweep();
	const msgs = store.readMessages("k1");
	ok(msgs.some((m) => m.kind === "status" && /spawned on fake/.test(m.text)), "dispatch logged to the card's message log");
	const outcomeMsg = msgs.find((m) => m.kind === "outcome");
	ok(!!outcomeMsg && outcomeMsg.text.includes("did k1"), "outcome logged to the card's message log");
	ok(!!outcomeMsg?.refs?.prompt && !!outcomeMsg?.refs?.diff, "outcome entry carries prompt + diff refs");
	ok(/^status:\s*Needs Review/m.test(fs.readFileSync(file, "utf8")), "card landed at Needs Review");

	fs.rmSync(board, { recursive: true, force: true });
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

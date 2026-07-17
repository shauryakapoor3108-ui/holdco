// harness-pi.test.ts — the Pi harness adapter under the shipped conformance suite
// (runConformance + a ConformanceWorld over a COCKPIT-aware fake herdr + fake obs),
// plus unit tests for the pi-guard extension's pure mapping (evaluatePiToolCall)
// and its default-export handler (inert / fail-closed / loaded paths).
// Run via `node tests/harness-pi.test.ts`.

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cockpit } from "../src/engine/cockpit.ts";
import type { HerdrAdapter } from "../src/engine/herdr-adapter.ts";
import type { ObsClient } from "../src/engine/obs-client.ts";
import { runConformance, type ConformanceWorld } from "../src/harness/conformance.ts";
import piGuard, { evaluatePiToolCall } from "../src/harness/pi-guard.ts";
import { BLOCK_SUFFIX } from "../src/harness/policy.ts";
import { PiHarness, piWorkerLabel, type PiHarnessSession } from "../src/harness/pi.ts";
import { DEFAULT_DENY_COMMANDS, type HarnessWorkspace, type SafetyPolicy, type SpawnRequest } from "../src/harness/types.ts";

// ── Test harness ─────────────────────────────────────────────────────────────

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

const TMP = fs.mkdtempSync(join(tmpdir(), "harness-pi-test-"));

// ── Fakes (the worker-pool test's IdxFakeHerdr pattern, submit-verify aware) ──

interface FPane {
	id: string;
	label?: string;
	tabId: string;
	wsId: string;
	/** the report-agent CHIP state (cockpit paint) — NOT the pi repl status */
	chip: string;
	/** the pi-injected repl agent_status `pane get` reads: "idle" until a steer is
	 *  SUBMITTED (send-keys Enter), then "working" — makes submit-verify honest. */
	agent: string;
}

/** COCKPIT-aware fake herdr: one cockpit workspace, labelled worker splits, worker
 *  output addressed by STABLE label (the adapter re-resolves pane ids by label). */
class FakeHerdr {
	paneCloses: string[] = [];
	runCmds: { pane: string; cmd: string }[] = [];
	sendTexts: { pane: string; text: string }[] = [];
	sendKeys: { pane: string; keys: string[] }[] = [];
	labelOutputs = new Map<string, string>();
	paneOutputs = new Map<string, string>();
	emptyList = false; // paneList → [] (a transient herdr read failure / transport down)
	private pseq = 0;
	private wseq = 0;
	private wsLabels = new Map<string, string>();
	private panes: FPane[] = [];

	async workspaceCreate(label: string, _cwd?: string) {
		const wsId = `ws${++this.wseq}`;
		this.wsLabels.set(wsId, label);
		const id = `p${++this.pseq}`;
		this.panes.push({ id, tabId: `${wsId}:1`, wsId, chip: "unknown", agent: "idle" });
		return { ok: true, workspaceId: wsId, paneId: id };
	}
	async workspaceList() {
		return [...this.wsLabels].map(([workspace_id, label]) => ({ workspace_id, label }));
	}
	async workspaceClose(id: string) {
		this.wsLabels.delete(id);
		this.panes = this.panes.filter((p) => p.wsId !== id);
		return true;
	}
	async paneList(workspaceId?: string) {
		if (this.emptyList) return [];
		return this.panes
			.filter((p) => !workspaceId || p.wsId === workspaceId)
			.map((p) => ({ pane_id: p.id, agent_status: p.chip, label: p.label, tab_id: p.tabId, workspace_id: p.wsId }));
	}
	async tabList(workspaceId?: string) {
		const tabs = new Map<string, { label: string; count: number }>();
		for (const p of this.panes) {
			if (workspaceId && p.wsId !== workspaceId) continue;
			const t = tabs.get(p.tabId) ?? { label: p.tabId.endsWith(":1") ? "1" : "bench", count: 0 };
			t.count++;
			tabs.set(p.tabId, t);
		}
		return [...tabs].map(([tab_id, v]) => ({ tab_id, label: v.label, pane_count: v.count }));
	}
	async paneSplit(paneId: string, _direction: "right" | "down", _cwd?: string) {
		const anchor = this.panes.find((p) => p.id === paneId);
		if (!anchor) return null;
		const id = `p${++this.pseq}`;
		this.panes.push({ id, tabId: anchor.tabId, wsId: anchor.wsId, chip: "unknown", agent: "idle" });
		return id;
	}
	async tabCreate(workspaceId: string, _label: string, _cwd?: string) {
		const id = `p${++this.pseq}`;
		this.panes.push({ id, tabId: `${workspaceId}:bench`, wsId: workspaceId, chip: "unknown", agent: "idle" });
		return { tabId: `${workspaceId}:bench`, paneId: id };
	}
	async paneRename(paneId: string, label: string) {
		const p = this.panes.find((x) => x.id === paneId);
		if (p) p.label = label;
		return true;
	}
	async paneReportAgent(paneId: string, _s: string, _a: string, state: string) {
		const p = this.panes.find((x) => x.id === paneId);
		if (p) p.chip = state;
		return true;
	}
	async paneClose(paneId: string) {
		this.paneCloses.push(paneId);
		this.panes = this.panes.filter((p) => p.id !== paneId);
		return true;
	}
	async paneRun(pane: string, cmd: string) {
		this.runCmds.push({ pane, cmd });
		return true;
	}
	async paneSendText(pane: string, text: string) {
		this.sendTexts.push({ pane, text });
		return true;
	}
	async paneSendKeys(pane: string, ...keys: string[]) {
		this.sendKeys.push({ pane, keys });
		// Submitting via Enter drives the fake pi out of idle → the adapter's
		// submit-verify loop confirms on its first verify poll.
		if (keys.includes("Enter")) {
			const p = this.panes.find((x) => x.id === pane);
			if (p) p.agent = "working";
		}
		return true;
	}
	async paneRead(pane: string, _source: string, _lines: number) {
		const p = this.panes.find((x) => x.id === pane);
		if (p?.label && this.labelOutputs.has(p.label)) return this.labelOutputs.get(p.label)!;
		return this.paneOutputs.get(pane) ?? "";
	}
	async paneAgentStatus(pane: string) {
		return this.panes.find((x) => x.id === pane)?.agent ?? "unknown";
	}
	async waitOutput() {
		return false; // unused by the pi adapter
	}
	// ── test helpers ──
	setLabelOutput(label: string, text: string) {
		this.labelOutputs.set(label, text);
	}
	removePane(label: string) {
		this.panes = this.panes.filter((p) => p.label !== label);
	}
}

class FakeObs {
	async resolveSessionIdByTag() {
		return "sess1";
	}
	async getStats(_sid: string) {
		return { ok: true, stats: { total_cost: 0.002, total_tokens: 150, error_count: 0, latest_ts: new Date().toISOString() } };
	}
	async health() {
		return true;
	}
}

// ── fake pi (ExtensionAPI stand-in) for driving the guard's default export ────

function fakePi() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const entries: { key: string; data: any }[] = [];
	const notices: string[] = [];
	const pi = {
		on(ev: string, h: (event: any, ctx: any) => any) {
			handlers.set(ev, h);
		},
		appendEntry(key: string, data: any) {
			entries.push({ key, data });
		},
	};
	const ctx = { cwd: TMP, ui: { notify: (m: string) => notices.push(m) } };
	return { pi, handlers, entries, notices, ctx };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. pi-guard: the pure mapping (evaluatePiToolCall)
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── 1. pi-guard evaluatePiToolCall (pure event → verdict mapping)");
	const scope = join(TMP, "guard-scope");
	fs.mkdirSync(scope, { recursive: true });
	const policy: SafetyPolicy = { writeScopes: [scope], denyCommands: [...DEFAULT_DENY_COMMANDS] };

	const wOut = evaluatePiToolCall(policy, { toolName: "write", input: { path: "/etc/passwd" } }, scope);
	ok(wOut.block && !!wOut.reason?.includes("outside workspace scope"), "write outside scope BLOCKED");

	const wIn = evaluatePiToolCall(policy, { toolName: "write", input: { path: join(scope, "notes.md") } }, scope);
	ok(!wIn.block, "write inside scope allowed");

	const eOut = evaluatePiToolCall(policy, { toolName: "edit", input: { path: "/etc/hosts" } }, scope);
	ok(eOut.block, "edit outside scope BLOCKED (edit maps like write)");

	const push = evaluatePiToolCall(policy, { toolName: "bash", input: { command: "git push origin main" } }, scope);
	ok(push.block && !!push.reason?.includes("denied command pattern"), "bash `git push` BLOCKED (deny pattern)");

	const redirect = evaluatePiToolCall(policy, { toolName: "bash", input: { command: "echo owned > /etc/motd" } }, scope);
	ok(redirect.block && !!redirect.reason?.includes("outside workspace scope"), "bash redirect to /etc BLOCKED (shell write target)");

	const insideBash = evaluatePiToolCall(policy, { toolName: "bash", input: { command: `echo hi > ${join(scope, "out.txt")}` } }, scope);
	ok(!insideBash.block, "bash redirect INSIDE scope allowed");

	const read = evaluatePiToolCall(policy, { toolName: "read", input: { path: "/etc/shadow" } }, scope);
	ok(!read.block, "read tool NEVER blocked (even outside scope)");
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. pi-guard default export: inert / fail-closed / loaded paths
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── 2. pi-guard handler: inert without HOLDCO_POLICY");
	const savedEnv = process.env.HOLDCO_POLICY;
	delete process.env.HOLDCO_POLICY;
	const g = fakePi();
	piGuard(g.pi);
	await g.handlers.get("session_start")!({}, g.ctx);
	ok(!g.handlers.has("tool_call"), "no HOLDCO_POLICY → tool_call NOT hooked (guard inert)");
	ok(g.notices.some((n) => n.includes("no policy — guard inert")), "inert path notifies `no policy — guard inert`");

	console.log("── 2b. pi-guard handler: unreadable policy → FAIL CLOSED");
	process.env.HOLDCO_POLICY = join(TMP, "does-not-exist", "policy.json");
	const g2 = fakePi();
	piGuard(g2.pi);
	await g2.handlers.get("session_start")!({}, g2.ctx);
	ok(g2.handlers.has("tool_call"), "unreadable policy still hooks tool_call (to fail closed)");
	const tc2 = g2.handlers.get("tool_call")!;
	const w2 = await tc2({ toolName: "write", input: { path: join(TMP, "anything.md") } }, g2.ctx);
	ok(w2.block === true, "fail-closed: write BLOCKED even inside a plausible scope");
	ok(typeof w2.reason === "string" && w2.reason.startsWith("BLOCKED by holdco policy:") && w2.reason.includes("policy file unreadable"), "fail-closed block reason names the unreadable policy");
	ok(typeof w2.reason === "string" && w2.reason.includes(BLOCK_SUFFIX), "block reason carries the BLOCK_SUFFIX no-workaround discipline");
	const b2 = await tc2({ toolName: "bash", input: { command: "ls" } }, g2.ctx);
	ok(b2.block === true, "fail-closed: bash BLOCKED");
	const r2 = await tc2({ toolName: "read", input: { path: "/etc/passwd" } }, g2.ctx);
	ok(r2.block === false, "fail-closed: read still passes (reads never policy-relevant)");
	ok(g2.entries.some((e) => e.key === "policy-guard-log" && e.data.action === "blocked_fail_closed"), "fail-closed block logged to policy-guard-log");

	console.log("── 2c. pi-guard handler: loaded policy enforces the evaluator");
	const scope = join(TMP, "guard-live-scope");
	fs.mkdirSync(scope, { recursive: true });
	const policyPath = join(TMP, "live-policy.json");
	fs.writeFileSync(policyPath, JSON.stringify({ writeScopes: [scope], denyCommands: [...DEFAULT_DENY_COMMANDS] }), "utf8");
	process.env.HOLDCO_POLICY = policyPath;
	const g3 = fakePi();
	piGuard(g3.pi);
	await g3.handlers.get("session_start")!({}, { ...g3.ctx, cwd: scope });
	const tc3 = g3.handlers.get("tool_call")!;
	const wIn = await tc3({ toolName: "write", input: { path: join(scope, "a.md") } }, { cwd: scope });
	ok(wIn.block === false, "loaded: write inside scope allowed");
	const wOut = await tc3({ toolName: "write", input: { path: "/etc/holdco-test" } }, { cwd: scope });
	ok(wOut.block === true && wOut.reason.includes("outside workspace scope"), "loaded: write outside scope BLOCKED with reason");
	const push = await tc3({ toolName: "bash", input: { command: "git push --force" } }, { cwd: scope });
	ok(push.block === true && push.reason.includes(BLOCK_SUFFIX), "loaded: git push BLOCKED with BLOCK_SUFFIX");
	ok(g3.entries.some((e) => e.key === "policy-guard-log" && e.data.action === "blocked"), "loaded block logged to policy-guard-log");

	if (savedEnv === undefined) delete process.env.HOLDCO_POLICY;
	else process.env.HOLDCO_POLICY = savedEnv;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Conformance: PiHarness against the fake transport
// ══════════════════════════════════════════════════════════════════════════════

const herdr = new FakeHerdr();
const obs = new FakeObs();
const cockpit = new Cockpit({ herdr: herdr as unknown as HerdrAdapter, label: "cockpit-test", cwd: TMP });
const extraExt = join(TMP, "extra-observability-ext.ts");
const harness = new PiHarness({
	herdr: herdr as unknown as HerdrAdapter,
	obs: obs as unknown as ObsClient,
	obsToken: "test-token",
	obsServerUrl: "http://127.0.0.1:0",
	cockpit,
	extensions: [extraExt],
	sleep: () => Promise.resolve(),
});

let wsSeq = 0;
const madeWorkspaces: HarnessWorkspace[] = [];

const world: ConformanceWorld = {
	harness,
	async makeWorkspace(): Promise<HarnessWorkspace> {
		const cardId = `c${++wsSeq}`;
		const dir = join(TMP, cardId, "worktree");
		const scopedDir = join(TMP, cardId, "scoped");
		fs.mkdirSync(dir, { recursive: true });
		fs.mkdirSync(scopedDir, { recursive: true });
		const ws = { cardId, dir, scopedDir };
		madeWorkspaces.push(ws);
		return ws;
	},
	async completeRun(session, outcomeText) {
		// The concrete sentinel is `<<CARD-DONE:` + id + `>>>`. The output MUST differ
		// from the spawn-time baseline ("" here) so poll's leave-idle guard opens.
		herdr.setLabelOutput(
			piWorkerLabel(session.cardId),
			`booting pi\ndoing the work\nOUTCOME: ${outcomeText}\n<<CARD-DONE:${session.cardId}>>>`,
		);
	},
	async breakTransport(_session) {
		herdr.emptyList = true; // paneList → [] → the adapter must answer "unknown"
	},
	async attemptViolations(session) {
		// Assert the policy ARTIFACT the adapter generated actually blocks — the same
		// evaluator the worker-side guard runs, fed the same policy.json bytes.
		const s = session as PiHarnessSession;
		const policy: SafetyPolicy = JSON.parse(fs.readFileSync(join(s.scopedDir, "policy.json"), "utf8"));
		const w = evaluatePiToolCall(policy, { toolName: "write", input: { path: "/etc/holdco-conformance-violation" } }, s.worktreeDir);
		const c = evaluatePiToolCall(policy, { toolName: "bash", input: { command: "git push origin main" } }, s.worktreeDir);
		return { writeBlocked: w.block, commandBlocked: c.block, detail: `write: ${w.reason ?? "allowed"} | command: ${c.reason ?? "allowed"}` };
	},
};

console.log("── 3. conformance suite (PiHarness over fake herdr/obs + real Cockpit)");
const checks = await runConformance(world);
for (const c of checks) ok(c.ok, `[conformance] ${c.id}${c.detail ? ` — ${c.detail.split("\n")[0].slice(0, 100)}` : ""}`);
herdr.emptyList = false; // restore the transport after the edge scenario

// ══════════════════════════════════════════════════════════════════════════════
// 4. Adapter mechanics: launch command, sentinel discipline, steer submission
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── 4. carved mechanics: launch command + task.md sentinel + steer submit");
	const first = madeWorkspaces[0];
	const task = fs.readFileSync(join(first.scopedDir, "task.md"), "utf8");
	ok(task.includes("<<CARD-DONE:CARDID>>>"), "task.md describes the sentinel with the CARDID placeholder");
	ok(!task.includes(`<<CARD-DONE:${first.cardId}>>>`), "task.md NEVER contains the concrete sentinel (echo false-positive defeated)");

	const cmd = herdr.runCmds[0]?.cmd ?? "";
	ok(cmd.includes("pi --no-extensions"), "launch command spawns an execution-only pi (--no-extensions)");
	ok(cmd.includes("HOLDCO_POLICY="), "launch command exports HOLDCO_POLICY (the guard's policy file)");
	ok(cmd.includes("pi-guard.ts"), "launch command loads the pi-guard extension via -e (default path resolution)");
	ok(cmd.includes(`-e '${extraExt}'`), "launch command carries the extra -e extension path");
	ok(cmd.includes("HOLDCO_CARD_DIR=") && cmd.includes("run:") && cmd.includes("--session-dir"), "launch command carries card dir, run tag, and session dir");

	const steers = herdr.sendTexts.map((t) => t.text);
	ok(steers.some((t) => t.includes("task.md")), "steer points the worker at task.md");
	ok(!steers.some((t) => t.includes(`<<CARD-DONE:${first.cardId}>>>`)), "steer never carries the concrete sentinel");
	ok(herdr.sendKeys.some((k) => k.keys.includes("Enter")), "steer submitted (send-keys Enter recorded)");
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. poll adjudication: failed (non-empty list, pane gone) vs unknown; inject
// ══════════════════════════════════════════════════════════════════════════════
{
	console.log("── 5. poll: pane gone from a NON-EMPTY list → failed; live poll telemetry; inject");
	const ws = await world.makeWorkspace();
	const req: SpawnRequest = {
		workspace: ws,
		instruction: "poll adjudication scenario — no real work.",
		card: { id: ws.cardId, domain: "conformance", cardType: "ops" },
		runId: `${ws.cardId}-adjudication`,
		policy: { writeScopes: [ws.dir, ws.scopedDir], denyCommands: [...DEFAULT_DENY_COMMANDS] },
	};
	const session = await harness.spawn(req);

	const live = await harness.poll(session);
	ok(live.state === "starting", "pre-work poll reports starting (baseline unchanged)");
	ok(live.costUsd === 0.002, "poll opportunistically reports costUsd from obs");
	ok(typeof live.lastActivityAt === "number" && Number.isFinite(live.lastActivityAt), "poll reports lastActivityAt (Date.parse of latest_ts)");

	const injected = await harness.inject(session, "mid-run correction: prefer the smaller diff");
	ok(injected, "inject delivers to the live pane (true)");
	ok(herdr.sendTexts.some((t) => t.text.includes("mid-run correction")), "injected message typed into the pane");

	// The worker's pane vanishes while the cockpit (owner pane) remains → a GENUINE
	// omission from a NON-EMPTY list → "failed" (not "unknown").
	herdr.removePane(piWorkerLabel(ws.cardId));
	const gone = await harness.poll(session);
	ok(gone.state === "failed", "pane gone from a NON-EMPTY pane list → poll reports failed");

	const injectGone = await harness.inject(session, "anyone there?");
	ok(injectGone === false, "inject on a gone pane returns false (could not deliver)");

	await harness.dispose(session);
	await harness.dispose(session);
	ok(true, "dispose after pane-gone is idempotent and does not throw");
}

// ── Summary ──────────────────────────────────────────────────────────────────

const confPass = checks.filter((c) => c.ok).length;
console.log(`\nConformance: ${confPass}/${checks.length} checks passed`);
console.log(`Pass: ${pass}  Fail: ${fail}`);
try {
	fs.rmSync(TMP, { recursive: true, force: true });
} catch {
	/* best-effort cleanup */
}
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

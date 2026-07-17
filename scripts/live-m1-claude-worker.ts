// live-m1-claude-worker.ts — M1 live proof (run manually: `node scripts/live-m1-claude-worker.ts`).
//
// Drives the PORTED modules end-to-end with a REAL worker doing REAL work:
//   1. temp git repo (cards/ + knowledge/ + NOTES.md), one card with `worker: claude`
//   2. WorkspaceManager.onIntake → real per-card git worktree
//   3. human approval edge (Needs Approval → Queued) detected by the real Reconciler
//   4. drain stand-in writes Queued → Executing + WorkerPool.dispatch
//   5. WorkerPool launches the REAL `claude` CLI (REPL-in-pty) inside the worktree,
//      blocks on the FLEET_DONE sentinel via waitOutput, harvests the REAL git diff,
//      writes the rollup, card lands at Needs Review — and the reconciler sweep
//      confirms no ILLEGAL_REVERT (loop-suppression held).
//
// The ONLY emulated piece is the pane transport: the herdr daemon is not running in
// this environment, so a LocalPaneHerdr satisfies the HerdrAdapter surface by spawning
// pane commands under `script -qec` (a pseudo-tty, which the claude REPL requires) and
// buffering output for paneRead/waitOutput. Everything the milestone ported — dispatch,
// cockpit placement calls, sentinel discipline, diff harvest, status writes — is the
// real shipped code path.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createStandaloneHost } from "../src/host/host.ts";
import { Reconciler } from "../src/engine/reconciler.ts";
import { writeStatus } from "../src/engine/frontmatter.ts";
import { WorkspaceManager } from "../src/engine/workspace-manager.ts";
import { WorkerPool } from "../src/engine/worker-pool.ts";
import { ObsClient } from "../src/engine/obs-client.ts";
import type { HerdrAdapter, WorkspaceCreateResult, WorkspaceInfo, PaneInfo, TabInfo } from "../src/engine/herdr-adapter.ts";

const WATCHDOG_MS = 300_000;

// ── LocalPaneHerdr: HerdrAdapter surface over local processes (pty via script -qec) ──
interface LocalPane {
	id: string;
	label?: string;
	tabId: string;
	wsId: string;
	state: string;
	proc?: ChildProcess;
	buf: string;
}
const stripAnsi = (s: string) =>
	s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");

class LocalPaneHerdr {
	panes: LocalPane[] = [];
	wsLabels = new Map<string, string>();
	private seq = 0;

	private newPane(wsId: string, tabId: string): LocalPane {
		const p: LocalPane = { id: `p${++this.seq}`, tabId, wsId, state: "unknown", buf: "" };
		this.panes.push(p);
		return p;
	}
	async workspaceCreate(label: string, _cwd?: string): Promise<WorkspaceCreateResult> {
		const wsId = `ws${this.wsLabels.size + 1}`;
		this.wsLabels.set(wsId, label);
		const p = this.newPane(wsId, `${wsId}:1`);
		return { ok: true, workspaceId: wsId, paneId: p.id };
	}
	async workspaceList(): Promise<WorkspaceInfo[]> {
		return [...this.wsLabels].map(([workspace_id, label]) => ({ workspace_id, label }));
	}
	async workspaceClose(id: string): Promise<boolean> {
		this.wsLabels.delete(id);
		for (const p of this.panes.filter((p) => p.wsId === id)) p.proc?.kill("SIGKILL");
		this.panes = this.panes.filter((p) => p.wsId !== id);
		return true;
	}
	async paneList(workspaceId?: string): Promise<PaneInfo[]> {
		return this.panes
			.filter((p) => !workspaceId || p.wsId === workspaceId)
			.map((p) => ({ pane_id: p.id, agent_status: p.state, label: p.label, tab_id: p.tabId, workspace_id: p.wsId }));
	}
	async tabList(workspaceId?: string): Promise<TabInfo[]> {
		const tabs = new Map<string, number>();
		for (const p of this.panes) {
			if (workspaceId && p.wsId !== workspaceId) continue;
			tabs.set(p.tabId, (tabs.get(p.tabId) ?? 0) + 1);
		}
		return [...tabs].map(([tab_id, pane_count]) => ({ tab_id, label: tab_id.endsWith(":1") ? "1" : "bench", pane_count }));
	}
	async paneSplit(paneId: string, _dir: "right" | "down", _cwd?: string): Promise<string | null> {
		const anchor = this.panes.find((p) => p.id === paneId);
		return anchor ? this.newPane(anchor.wsId, anchor.tabId).id : null;
	}
	async tabCreate(workspaceId: string, _label: string, _cwd?: string): Promise<{ tabId: string; paneId: string } | null> {
		const p = this.newPane(workspaceId, `${workspaceId}:bench`);
		return { tabId: p.tabId, paneId: p.id };
	}
	async paneRename(paneId: string, label: string): Promise<boolean> {
		const p = this.panes.find((x) => x.id === paneId);
		if (p) p.label = label;
		return true;
	}
	async paneReportAgent(paneId: string, _s: string, _a: string, state: string): Promise<boolean> {
		const p = this.panes.find((x) => x.id === paneId);
		if (p) p.state = state;
		return true;
	}
	async paneClose(paneId: string): Promise<boolean> {
		const p = this.panes.find((x) => x.id === paneId);
		p?.proc?.kill("SIGKILL");
		this.panes = this.panes.filter((x) => x.id !== paneId);
		return true;
	}
	async paneRun(paneId: string, command: string): Promise<boolean> {
		const p = this.panes.find((x) => x.id === paneId);
		if (!p) return false;
		// pty via script(1): the claude REPL refuses a pipe stdin; -qec gives it a terminal.
		// Strip the nested-session env (this proof itself runs under Claude Code) so the
		// worker REPL boots like a fresh pane.
		const env = { ...process.env, TERM: "xterm-256color", COLUMNS: "140", LINES: "40" };
		for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
		const proc = spawn("script", ["-qec", command, "/dev/null"], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// First-run dialog auto-answer — the transport plays the human at the pane.
		// Only dialogs visible in the CURRENT frame (the tail of the stream) are
		// answered, exactly once each: folder-trust → Enter (accept is pre-selected);
		// fullscreen-renderer upsell → Esc (decline — a renderer reload would drop
		// the queued initial prompt). The TUI positions words with cursor moves, so
		// match de-spaced text.
		const answeredDialogs = new Set<string>();
		const debugLog = fs.createWriteStream(join(scopedBase, "pane-raw.log"), { flags: "a" });
		const watch = (chunk: string) => {
			p.buf += chunk;
			debugLog.write(chunk);
			const frame = stripAnsi(p.buf.slice(-900)).replace(/\s+/g, "");
			const answer = (key: string, send: string) => {
				if (answeredDialogs.has(key)) return;
				answeredDialogs.add(key);
				setTimeout(() => proc.stdin?.write(send), 500);
			};
			if (/trustthisfolder/i.test(frame)) answer("trust", "\r");
			else if (/fullscreenrenderer/i.test(frame)) answer("renderer", "\x1b");
		};
		proc.stdout!.on("data", (d) => watch(d.toString()));
		proc.stderr!.on("data", (d) => watch(d.toString()));
		p.proc = proc;
		return true;
	}
	async paneSendText(_paneId: string, _text: string): Promise<boolean> {
		return true;
	}
	async paneSendKeys(_paneId: string, ..._keys: string[]): Promise<boolean> {
		return true;
	}
	async paneRead(paneId: string, _source: string, lines: number): Promise<string> {
		const p = this.panes.find((x) => x.id === paneId);
		if (!p) return "";
		const clean = stripAnsi(p.buf);
		return clean.split("\n").slice(-lines).join("\n");
	}
	async paneAgentStatus(_paneId: string): Promise<string> {
		return "idle";
	}
	async waitOutput(paneId: string, match: string, timeoutMs: number, _source?: string): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const p = this.panes.find((x) => x.id === paneId);
			if (!p) return false;
			if (stripAnsi(p.buf).includes(match)) return true;
			await new Promise((r) => setTimeout(r, 1000));
		}
		return false;
	}
}

// ── scaffold ──────────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-live-m1-"));
const cardsDir = join(root, "cards");
const scopedBase = join(root, "scoped");
fs.mkdirSync(cardsDir, { recursive: true });
fs.mkdirSync(join(root, "knowledge"), { recursive: true });
fs.mkdirSync(join(root, "domains", "demo", "refs"), { recursive: true });
fs.writeFileSync(join(root, "domains", "demo", "CONTEXT.md"), "# demo domain\nA demo domain for the live proof.\n");
fs.writeFileSync(join(root, "knowledge", "FILING.md"), "# Filing\nkebab-case filenames.\n");
fs.writeFileSync(join(root, "NOTES.md"), "# Notes\n");
const G = { cwd: root, stdio: "pipe" as const };
execSync("git init -b main && git add -A && git -c user.name=holdco -c user.email=live@holdco.test commit -m init", G);

const cardFile = join(cardsDir, "m1.md");
fs.writeFileSync(
	cardFile,
	`---
type: card
id: m1
title: "Live proof: claude worker appends a note"
status: Needs Approval
card_type: ops
domain: demo
worker: claude
created_at: 2026-07-17
brief: ""
cost_total: null
outcome: ""
---

## Brief
Append exactly one line to the file NOTES.md in the repo root: \`holdco worker was here\`. Change nothing else. Do not create new files.

## Reconciler Log
`,
);

// ── real engine parts ─────────────────────────────────────────────────────────
const host = createStandaloneHost({ sink: (kind, data) => console.log(`[${kind}] ${JSON.stringify(data)}`) });
const reconciler = new Reconciler(cardsDir);
reconciler.startupRecovery();
const herdr = new LocalPaneHerdr() as unknown as HerdrAdapter;
const wsMgr = new WorkspaceManager({ host, herdr, scopedBase });
const pool = new WorkerPool({
	host,
	reconciler,
	herdr,
	obs: new ObsClient("http://127.0.0.1:1", "unused"), // no obs server — exercises the telemetry-unavailable fallback (claude driver skips obs anyway)
	obsToken: "unused",
	obsServerUrl: "http://127.0.0.1:1",
	maxSlots: 1,
	cardBudgetUsd: 5,
	watchdogMs: WATCHDOG_MS,
	wsMgr,
	scopedBase,
	slug: "live",
});

const fail = (msg: string): never => {
	console.error(`\n❌ LIVE PROOF FAILED: ${msg}`);
	process.exit(1);
};

// 1. intake → real worktree
await wsMgr.onIntake("m1", cardFile, root);
const ws = wsMgr.getWorkspace("m1");
if (!ws?.worktreePath || !fs.existsSync(join(ws.worktreePath, "NOTES.md"))) fail("worktree not created");
console.log(`\n✔ worktree created at ${ws!.worktreePath} (base ${ws!.baseCommit.slice(0, 8)})`);

// 2. human approves: Needs Approval → Queued (detected by the real reconciler)
writeStatus(cardFile, "Queued", { logLine: "human approval (live proof)" });
const ev = reconciler.reconcile("sweep");
if (!ev.some((e) => e.event === "TRANSITION" && e.to === "Queued")) fail("approval transition not detected");
console.log("✔ reconciler detected the human approval edge (Needs Approval → Queued)");

// 3. drain stand-in: Queued → Executing (loop-suppressed) + dispatch
writeStatus(cardFile, "Executing", { logLine: "drain: Queued → Executing (live proof)" });
reconciler.snapshot.set("m1", "Executing");
pool.dispatch("m1", cardFile, { cwd: root });
console.log("✔ dispatched — real `claude` REPL launching in the worktree (this takes a minute or two)…");

// 4. the claude driver path blocks on the sentinel inside settleLaunches
await pool.settleLaunches();

// 5. verify the harvest
const after = fs.readFileSync(cardFile, "utf8");
const status = after.match(/^status:\s*(.*)$/m)?.[1]?.trim();
if (status !== "Needs Review") fail(`card status is ${status}, expected Needs Review\n${after}`);
const diffPath = join(scopedBase, "m1", "card.diff");
const diff = fs.existsSync(diffPath) ? fs.readFileSync(diffPath, "utf8") : "";
if (!diff.includes("holdco worker was here")) fail(`harvested diff does not contain the worker's edit:\n${diff || "(empty)"}`);
if (!/## Diff/.test(after)) fail("card body missing ## Diff section");
const sweep2 = reconciler.reconcile("sweep");
if (sweep2.some((e) => e.event === "ILLEGAL_REVERT")) fail("completion edge was auto-reverted (loop-suppression broken)");

console.log("\n✔ card landed at Needs Review; loop-suppression held (no ILLEGAL_REVERT)");
console.log("✔ harvested card.diff:\n" + diff.split("\n").slice(0, 20).join("\n"));
console.log("\n── card after harvest ──\n" + after);
console.log(`\n✅ LIVE PROOF PASSED — real claude worker, real worktree isolation, real diff harvest.`);
console.log(`   scratch kept at ${root} (inspect, then delete)`);
process.exit(0);

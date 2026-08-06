// harness-claude-code.test.ts - the Claude Code adapter against (a) the guard
// verdict function directly, (b) the shipped conformance suite driven by a
// hermetic fake CLI speaking the real stream-json protocol, and (c) mid-run
// inject with usage accumulation across turns.
// Run via `node tests/harness-claude-code.test.ts`.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runConformance } from "../src/harness/conformance.ts";
import type { ConformanceWorld } from "../src/harness/conformance.ts";
import { ClaudeCodeHarness } from "../src/harness/claude-code.ts";
import { runGuard } from "../src/harness/claude-code-guard.ts";
import type { HarnessSession, HarnessWorkspace, SafetyPolicy } from "../src/harness/types.ts";
import { DEFAULT_DENY_COMMANDS } from "../src/harness/types.ts";

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

const testsDir = dirname(fileURLToPath(import.meta.url));
const fakeClaude = join(testsDir, "fixtures", "fake-claude.mjs");
const guardScript = join(testsDir, "..", "src", "harness", "claude-code-guard.ts");

// ── (a) guard unit tests: runGuard directly ───────────────────────────────────

console.log("── guard verdicts (runGuard)");
{
	const gw = fs.mkdtempSync(join(os.tmpdir(), "holdco-guard-"));
	const policy: SafetyPolicy = { writeScopes: [gw], denyCommands: [...DEFAULT_DENY_COMMANDS] };
	const policyPath = join(gw, "policy.json");
	fs.writeFileSync(policyPath, JSON.stringify(policy));
	const env = { HOLDCO_POLICY: policyPath };
	const hook = (tool_name: string, tool_input: Record<string, unknown>) =>
		JSON.stringify({ tool_name, tool_input, cwd: gw });

	const w1 = runGuard(hook("Write", { file_path: "/etc/holdco-test.txt" }), env);
	ok(w1.exitCode === 2 && w1.stderr.startsWith("BLOCKED by holdco policy:"), "out-of-scope Write blocked (exit 2)");

	const w2 = runGuard(hook("Write", { file_path: join(gw, "a.txt") }), env);
	ok(w2.exitCode === 0 && w2.stderr === "", "in-scope Write allowed");

	const b1 = runGuard(hook("Bash", { command: "git push origin main" }), env);
	ok(b1.exitCode === 2 && b1.stderr.includes("denied command pattern"), "Bash `git push origin main` blocked");

	const b2 = runGuard(hook("Bash", { command: "echo hi > /etc/x" }), env);
	ok(b2.exitCode === 2 && b2.stderr.includes("outside workspace scope"), "Bash redirect to /etc/x blocked");

	const b3 = runGuard(hook("Bash", { command: `echo hi > ${join(gw, "out.txt")}` }), env);
	ok(b3.exitCode === 0, "in-scope bash write allowed");

	const u1 = runGuard(hook("Write", { file_path: join(gw, "a.txt") }), { HOLDCO_POLICY: join(gw, "nope.json") });
	ok(u1.exitCode === 2 && u1.stderr.includes("policy file unreadable"), "unreadable HOLDCO_POLICY + Write → blocked (fail closed)");

	const n1 = runGuard(hook("Write", { file_path: "/etc/holdco-test.txt" }), {});
	ok(n1.exitCode === 0, "no HOLDCO_POLICY → allowed");

	fs.rmSync(gw, { recursive: true, force: true });
}

// ── (b) conformance against the fake CLI ─────────────────────────────────────

const harness = new ClaudeCodeHarness({
	claudeBin: process.execPath,
	claudeArgs: [fakeClaude],
	extraEnv: { FAKE_CLAUDE_CONTROL: "{scopedDir}/control.json" },
});

const roots: string[] = [];
let wsCount = 0;

async function makeWorkspace(): Promise<HarnessWorkspace> {
	const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-cc-"));
	roots.push(root);
	const dir = join(root, "worktree");
	const scopedDir = join(root, "scoped");
	fs.mkdirSync(dir);
	fs.mkdirSync(scopedDir);
	return { cardId: `cc-${++wsCount}`, dir, scopedDir };
}

function controlPathFor(session: HarnessSession): string {
	return join(dirname(session.promptRef), "control.json");
}

function writeControl(path: string, ctrl: Record<string, unknown>): void {
	const tmp = path + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(ctrl));
	fs.renameSync(tmp, path); // atomic: the fake never reads a partial file
}

const world: ConformanceWorld = {
	harness,
	makeWorkspace,
	async completeRun(session, outcomeText) {
		writeControl(controlPathFor(session), { outcome: outcomeText, costUsd: 0.0042, tokensIn: 120, tokensOut: 45 });
	},
	async breakTransport(session) {
		const child = harness._child(session);
		if (!child) return;
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve();
			child.once("exit", () => resolve());
			child.kill("SIGKILL");
		});
	},
	async attemptViolations(session) {
		// Exercise the REAL generated artifacts (policy.json) through the REAL
		// hook entrypoint, exactly as Claude Code would run it: `node <guard>`
		// with the PreToolUse payload on stdin and HOLDCO_POLICY in env.
		const scoped = dirname(session.promptRef);
		const policyPath = join(scoped, "policy.json");
		const runHook = (payload: Record<string, unknown>) =>
			spawnSync(process.execPath, [guardScript], {
				input: JSON.stringify(payload),
				env: { ...process.env, HOLDCO_POLICY: policyPath },
				encoding: "utf8",
				timeout: 10_000,
			});
		const w = runHook({ tool_name: "Write", tool_input: { file_path: "/etc/holdco-test.txt" }, cwd: scoped });
		const c = runHook({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: scoped });
		return {
			writeBlocked: w.status === 2,
			commandBlocked: c.status === 2,
			detail: `write exit=${w.status} (${(w.stderr ?? "").split("\n")[0]}); command exit=${c.status} (${(c.stderr ?? "").split("\n")[0]})`,
		};
	},
};

async function pollUntil(session: HarnessSession, want: string, tries = 50): Promise<string> {
	let last = "unknown";
	for (let i = 0; i < tries; i++) {
		last = (await harness.poll(session)).state;
		if (last === want || last === "failed") return last;
		await new Promise((r) => setTimeout(r, 100));
	}
	return last;
}

async function main(): Promise<void> {
	console.log("── conformance suite (fake claude CLI)");
	const checks = await runConformance(world);
	for (const c of checks) ok(c.ok, `${c.id} - ${c.detail}`);

	// ── (c) inject: second turn, usage accumulates ─────────────────────────────
	console.log("── inject (multi-turn)");
	const ws = await makeWorkspace();
	const session = await harness.spawn({
		workspace: ws,
		instruction: "Inject test: idle between turns.",
		card: { id: ws.cardId, domain: "test", cardType: "ops" },
		runId: `${ws.cardId}-inject`,
		policy: { writeScopes: [ws.dir, ws.scopedDir], denyCommands: [...DEFAULT_DENY_COMMANDS] },
	});
	const control = controlPathFor(session);

	writeControl(control, { outcome: "first turn done", costUsd: 0.001, tokensIn: 100, tokensOut: 10 });
	ok((await pollUntil(session, "done")) === "done", "first turn reaches done");

	const delivered = await harness.inject(session, "Second instruction: do one more thing.");
	ok(delivered, "inject delivers on live session");
	ok((await harness.poll(session)).state === "working", "poll returns to working after inject");

	writeControl(control, { outcome: "second turn done", costUsd: 0.002, tokensIn: 50, tokensOut: 5 });
	ok((await pollUntil(session, "done")) === "done", "second turn reaches done");

	const artifacts = await harness.collect(session);
	ok(artifacts.outcome === "second turn done", `outcome from second turn: ${artifacts.outcome}`);
	ok(artifacts.usage !== null && artifacts.usage.tokensIn === 150 && artifacts.usage.tokensOut === 15, `usage tokens accumulate: ${JSON.stringify(artifacts.usage)}`);
	ok(artifacts.usage !== null && Math.abs(artifacts.usage.costUsd - 0.003) < 1e-9, `usage cost accumulates: ${artifacts.usage?.costUsd}`);
	ok(artifacts.errorCount === 0, "no error results");

	await harness.dispose(session);
	await harness.dispose(session);
	ok(true, "dispose idempotent on inject session");

	ok((await harness.inject(session, "too late")) === false, "inject on disposed session returns false");

	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });

	console.log(`\nPass: ${pass}  Fail: ${fail}`);
	if (fail > 0) process.exit(1);
	console.log("✅ ALL TESTS PASSED");
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});

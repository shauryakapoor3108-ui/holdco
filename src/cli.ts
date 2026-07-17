#!/usr/bin/env node
// cli.ts — the holdco daemon CLI.
//
//   holdco serve [--cards-dir DIR] [--sweep-ms N] [--events-off] [--no-exec]
//                [--worker-harness NAME] [--model M] [--max-slots N]
//                [--card-budget-usd N] [--watchdog-ms N] [--scoped-base DIR]
//       Run the engine: single-owner lease, startup recovery, reconcile loop,
//       and (unless --no-exec) the execution orchestrator — approved cards are
//       drained into isolated worktrees and executed by the configured harness
//       (default: claude-code, headless `claude` sessions).
//   holdco board [--cards-dir DIR]
//       One-shot column summary.
//   holdco move <card-id> <status> [--cards-dir DIR]
//       Make a HUMAN transition (approve = move to Queued, reject = move to
//       Intake, …). The write is validated by the running engine's reconciler:
//       an illegal move is auto-reverted there, exactly like a kanban drag.

import * as fs from "node:fs";
import { basename, join } from "node:path";
import { createStandaloneHost } from "./host/host.ts";
import { CardEngine } from "./engine/core.ts";
import { parseCard, writeStatus } from "./engine/frontmatter.ts";
import { Orchestrator } from "./engine/orchestrate.ts";
import { legalTargets } from "./engine/state-machine.ts";
import { WorkerPool } from "./engine/worker-pool.ts";
import { WorkspaceManager } from "./engine/workspace-manager.ts";
import { DEFAULT_SCOPED_BASE } from "./engine/workspace-paths.ts";
import { ClaudeCodeHarness } from "./harness/claude-code.ts";
import { CodexHarness } from "./harness/codex.ts";
import type { Harness } from "./harness/types.ts";

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
	const [cmd = "help", ...rest] = argv;
	const pos: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else flags[key] = "true";
		} else pos.push(a);
	}
	return { cmd, pos, flags };
}

function cardsDirFrom(flags: Record<string, string>): string {
	const dir = flags["cards-dir"] || process.env.CARDS_DIR || "cards";
	return dir.startsWith("/") ? dir : join(process.cwd(), dir);
}

function findCard(cardsDir: string, id: string): string | null {
	const exact = join(cardsDir, id.endsWith(".md") ? id : `${id}.md`);
	if (fs.existsSync(exact)) return exact;
	const hits = fs.readdirSync(cardsDir).filter((f) => f.endsWith(".md") && f.includes(id));
	return hits.length === 1 ? join(cardsDir, hits[0]) : null;
}

const { cmd, pos, flags } = parseArgs(process.argv.slice(2));

switch (cmd) {
	case "serve": {
		// `--sweep-ms` is the documented spelling; the engine's config key is
		// `card-sweep-ms` (source-system heritage). Honor both.
		if (flags["sweep-ms"] && !flags["card-sweep-ms"]) flags["card-sweep-ms"] = flags["sweep-ms"];
		const host = createStandaloneHost({ flags });
		const engine = new CardEngine(host, {});
		const res = engine.start();
		if (!res.owner) process.exit(1);

		let orchestrator: Orchestrator | null = null;
		if (flags["no-exec"] !== "true") {
			const num = (key: string, dflt: number) => {
				const v = Number(host.config.get(key));
				return Number.isFinite(v) && v > 0 ? v : dflt;
			};
			const cwd = process.cwd();
			const scopedBase = host.config.get("scoped-base") || DEFAULT_SCOPED_BASE;
			// Registered adapters. Pi needs a live herdr session + obs server — it joins
			// the registry when its shell wires it in (or a later `--pi` bring-up); a
			// card asking for an unregistered harness escalates loudly at dispatch.
			const harnesses: Record<string, Harness> = {
				"claude-code": new ClaudeCodeHarness({ claudeBin: host.config.get("claude-bin") || "claude" }),
				codex: new CodexHarness(),
			};
			const wsMgr = new WorkspaceManager({ host, scopedBase });
			const pool = new WorkerPool({
				host,
				reconciler: engine.reconciler!,
				harnesses,
				defaultHarness: host.config.get("worker-harness") || "claude-code",
				maxSlots: num("max-slots", 3),
				cardBudgetUsd: num("card-budget-usd", 0.5),
				watchdogMs: num("watchdog-ms", 600_000),
				wsMgr,
				scopedBase,
				model: host.config.get("model") || undefined,
			});
			orchestrator = new Orchestrator({ host, engine, pool, wsMgr, cwd });
			orchestrator.start(num("sweep-ms", 2000));
			console.error(`holdco: executing via ${host.config.get("worker-harness") || "claude-code"} harness (--no-exec to disable)`);
		}

		console.error(`holdco: serving ${engine.cardsDir} (ctrl-c to stop)`);
		const bye = () => {
			void (async () => {
				if (orchestrator) await orchestrator.stop();
				engine.stop();
				process.exit(0);
			})();
		};
		process.on("SIGINT", bye);
		process.on("SIGTERM", bye);
		break;
	}
	case "board": {
		const dir = cardsDirFrom(flags);
		const counts: Record<string, number> = {};
		for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			if (!f.endsWith(".md") || f.startsWith("_")) continue;
			const scan = parseCard(join(dir, f));
			if (scan) counts[scan.status] = (counts[scan.status] ?? 0) + 1;
		}
		console.log(Object.keys(counts).length ? counts : "no cards");
		break;
	}
	case "move": {
		const [id, ...statusParts] = pos;
		const status = statusParts.join(" ");
		if (!id || !status) {
			console.error("usage: holdco move <card-id> <status>");
			process.exit(2);
		}
		const dir = cardsDirFrom(flags);
		const file = findCard(dir, id);
		if (!file) {
			console.error(`card not found (or ambiguous): ${id}`);
			process.exit(1);
		}
		const cur = parseCard(file);
		if (!cur) {
			console.error(`unreadable card: ${file}`);
			process.exit(1);
		}
		writeStatus(file, status, { logLine: `human move via CLI: ${cur.status} → ${status}` });
		console.log(`${basename(file)}: ${cur.status} → ${status}`);
		const targets = legalTargets(cur.status);
		if (!targets.includes(status)) {
			console.error(`note: ${cur.status} → ${status} is not in the legal matrix — a running engine will revert it`);
		}
		break;
	}
	default:
		console.log(`holdco — harness-agnostic multi-agent engine

  holdco serve [--cards-dir DIR] [--sweep-ms N] [--events-off]
  holdco board [--cards-dir DIR]
  holdco move <card-id> <status> [--cards-dir DIR]
`);
}

// herdr-adapter.ts - the ONE polling transport for every `herdr` call the owner makes.
//
// Port of v3 `extensions/lib/herdr-client.ts` (the one-adapter principle): a single
// typed wrapper around `execFile("herdr", …)` for the D2 worker lifecycle. Two hard
// rules, both carried over from v3:
//   1. **Timeouts / transport failures RETURN a value, never throw.** A herdr hiccup
//      must NOT crash the owner's 2s sweep; the caller inspects `.ok` and the
//      watchdog/reaper handle a genuinely-dead worker. (v3 `waitForStatus` returns
//      "timeout" rather than throwing.)
//   2. **Only the commands in `tasks/_herdr-cli-contract.md`** - workspace
//      create/list/close, pane run/send-text/send-keys/read/list/get. No invented
//      flags or subcommands.
//
// The `exec` fn is injectable so the D2 self-test drives the adapter under a FAKE
// execFile (no real herdr, no real panes) and asserts the JSON parsing + the
// timeout-returns-a-value contract.
//
// JSON shapes (captured live this session from herdr 0.5.10 - F3 grounding):
//   workspace create → result.workspace.workspace_id + result.root_pane.pane_id
//   workspace list   → result.workspaces[] (each {workspace_id, label, …})
//   pane list        → result.panes[] (each {pane_id, agent_status, …})
//   workspace close  → result.type === "ok"
//   pane read        → PLAIN TEXT (not JSON) on stdout
//   pane get         → result.pane.{agent_status,…}

import { execFile } from "node:child_process";

/** Result of one raw `herdr …` invocation. `ok` is false on non-zero exit / timeout / spawn error. */
export interface ExecResult {
	ok: boolean;
	stdout: string;
}

/** Injectable transport: takes the herdr argv (without the leading "herdr") → stdout. */
export type ExecFn = (args: string[], timeoutMs: number) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 15_000;

/** The real transport: spawn `herdr <args>`. Never throws - a failure resolves `{ok:false}`. */
const realExec: ExecFn = (args, timeoutMs) =>
	new Promise<ExecResult>((resolve) => {
		execFile("herdr", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			// HERDR_DEBUG=1: surface the swallowed failure detail (loud-failure doctrine) - a bare
			// "workspace-failed" at the pane-runner told us nothing about WHY (live 2026-07-14).
			if (err && process.env.HERDR_DEBUG === "1") {
				console.error(`[herdr-adapter] FAIL herdr ${args.join(" ")}\n  err=${String((err as any)?.code ?? err)} stderr=${String(stderr ?? "").slice(0, 300)} stdout=${String(stdout ?? "").slice(0, 300)}`);
			}
			if (err) resolve({ ok: false, stdout: typeof stdout === "string" ? stdout : "" });
			else resolve({ ok: true, stdout: stdout ?? "" });
		});
	});

export interface WorkspaceCreateResult {
	ok: boolean;
	workspaceId: string | null;
	paneId: string | null;
}
export interface WorkspaceInfo {
	workspace_id: string;
	label: string;
}
export interface PaneInfo {
	pane_id: string;
	agent_status: string;
	/** COCKPIT: the pane's stable label (owner:/worker:/rpc:). Undefined when unlabelled. */
	label?: string;
	/** COCKPIT: the tab the pane lives in (for per-tab pane counting). */
	tab_id?: string;
	/** COCKPIT: the owning workspace. */
	workspace_id?: string;
}
export interface TabInfo {
	tab_id: string;
	label: string;
	pane_count: number;
}
/** herdr agent-status value (pane report-agent --state). */
export type AgentState = "idle" | "working" | "blocked" | "unknown";

/** Construction options for the production form: `new HerdrAdapter({ session })`. */
export interface HerdrAdapterOpts {
	/** herdr global `--session <name>` prepended to EVERY invocation. Undefined → no `--session`. */
	session?: string;
	/** Per-call timeout (ms). Default 15_000. */
	timeoutMs?: number;
}

export class HerdrAdapter {
	private readonly exec: ExecFn;
	private readonly timeoutMs: number;
	private readonly session?: string;

	/**
	 * Two construction forms, both supported so the config seam (session) coexists with the
	 * long-standing test seam (injectable exec):
	 *   • `new HerdrAdapter()` / `new HerdrAdapter({ session, timeoutMs })` - production.
	 *   • `new HerdrAdapter(fakeExec, timeoutMs)` - the self-tests' FAKE execFile transport.
	 * The first positional arg disambiguates: a function ⇒ the exec transport; an object ⇒ opts.
	 */
	constructor(execOrOpts?: ExecFn | HerdrAdapterOpts, timeoutMs?: number) {
		if (typeof execOrOpts === "function") {
			this.exec = execOrOpts;
			this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
			this.session = undefined;
		} else if (execOrOpts && typeof execOrOpts === "object") {
			this.exec = realExec;
			this.timeoutMs = execOrOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			this.session = execOrOpts.session;
		} else {
			this.exec = realExec;
			this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
			this.session = undefined;
		}
	}

	/** Prepend `--session <name>` when a session is configured; otherwise pass argv through
	 *  UNCHANGED (byte-for-byte identical to the pre-session behavior). */
	private argv(rest: string[]): string[] {
		return this.session ? ["--session", this.session, ...rest] : rest;
	}

	private async json(args: string[]): Promise<any | null> {
		const r = await this.exec(this.argv(args), this.timeoutMs);
		if (!r.ok) return null;
		try {
			return JSON.parse(r.stdout.trim());
		} catch {
			return null;
		}
	}

	/** `herdr workspace create --label <label> --no-focus [--cwd <cwd>]`. */
	async workspaceCreate(label: string, cwd?: string): Promise<WorkspaceCreateResult> {
		const args = ["workspace", "create", "--label", label, "--no-focus"];
		if (cwd) args.push("--cwd", cwd);
		const data = await this.json(args);
		// F3: assert the keys on first run - a shape drift must be loud, not a silent null spawn.
		const workspaceId = data?.result?.workspace?.workspace_id ?? data?.result?.root_pane?.workspace_id ?? null;
		const paneId = data?.result?.root_pane?.pane_id ?? null;
		return { ok: !!(workspaceId && paneId), workspaceId, paneId };
	}

	/** `herdr workspace list` → the workspaces array (empty on failure). */
	async workspaceList(): Promise<WorkspaceInfo[]> {
		const data = await this.json(["workspace", "list"]);
		const arr = data?.result?.workspaces;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((w: any) => typeof w?.workspace_id === "string")
			.map((w: any) => ({ workspace_id: w.workspace_id as string, label: String(w.label ?? "") }));
	}

	/** `herdr workspace close <workspace_id>`. true iff herdr reported ok. */
	async workspaceClose(workspaceId: string): Promise<boolean> {
		const data = await this.json(["workspace", "close", workspaceId]);
		return data?.result?.type === "ok" || data?.result != null;
	}

	/** `herdr pane list [--workspace <ws>]` → the panes array (empty on failure). Parses the
	 *  COCKPIT-relevant `label` / `tab_id` / `workspace_id` when present (herdr 0.5.10 shape). */
	async paneList(workspaceId?: string): Promise<PaneInfo[]> {
		const args = ["pane", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const data = await this.json(args);
		const arr = data?.result?.panes;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((p: any) => typeof p?.pane_id === "string")
			.map((p: any) => ({
				pane_id: p.pane_id as string,
				agent_status: String(p.agent_status ?? "unknown"),
				label: typeof p.label === "string" ? (p.label as string) : undefined,
				tab_id: typeof p.tab_id === "string" ? (p.tab_id as string) : undefined,
				workspace_id: typeof p.workspace_id === "string" ? (p.workspace_id as string) : undefined,
			}));
	}

	/** `herdr tab list [--workspace <ws>]` → the tabs array (empty on failure). COCKPIT. */
	async tabList(workspaceId?: string): Promise<TabInfo[]> {
		const args = ["tab", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const data = await this.json(args);
		const arr = data?.result?.tabs;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((t: any) => typeof t?.tab_id === "string")
			.map((t: any) => ({ tab_id: t.tab_id as string, label: String(t.label ?? ""), pane_count: Number(t.pane_count ?? 0) }));
	}

	/** `herdr pane split <pane> --direction right|down [--cwd <cwd>] --no-focus` → new pane_id
	 *  (null on failure). COCKPIT: how a worker/rpc pane is carved off the cockpit. */
	async paneSplit(paneId: string, direction: "right" | "down", cwd?: string): Promise<string | null> {
		const args = ["pane", "split", paneId, "--direction", direction, "--no-focus"];
		if (cwd) args.push("--cwd", cwd);
		const data = await this.json(args);
		const id = data?.result?.pane?.pane_id;
		return typeof id === "string" ? id : null;
	}

	/** `herdr pane rename <pane> <label>`. true iff herdr reported ok. COCKPIT. */
	async paneRename(paneId: string, label: string): Promise<boolean> {
		const r = await this.exec(this.argv(["pane", "rename", paneId, label]), this.timeoutMs);
		return r.ok;
	}

	/** `herdr pane report-agent <pane> --source <s> --agent <a> --state <state>`. COCKPIT: paints
	 *  the pane's agent chip. Returns true on exit 0 (report-agent emits no stdout on success). */
	async paneReportAgent(paneId: string, source: string, agent: string, state: AgentState): Promise<boolean> {
		const r = await this.exec(this.argv(["pane", "report-agent", paneId, "--source", source, "--agent", agent, "--state", state]), this.timeoutMs);
		return r.ok;
	}

	/** `herdr pane close <pane>`. true iff herdr reported ok. COCKPIT teardown (NOT workspace close).
	 *  herdr auto-closes a tab when its last pane closes (probed on 0.5.10). */
	async paneClose(paneId: string): Promise<boolean> {
		const r = await this.exec(this.argv(["pane", "close", paneId]), this.timeoutMs);
		return r.ok;
	}

	/** `herdr tab create --workspace <ws> [--cwd <cwd>] --label <label> --no-focus` → {tabId, paneId}
	 *  (null on failure). COCKPIT: the "bench" overflow tab (comes with a root pane). */
	async tabCreate(workspaceId: string, label: string, cwd?: string): Promise<{ tabId: string; paneId: string } | null> {
		const args = ["tab", "create", "--workspace", workspaceId, "--label", label, "--no-focus"];
		if (cwd) args.push("--cwd", cwd);
		const data = await this.json(args);
		const tabId = data?.result?.tab?.tab_id;
		const paneId = data?.result?.root_pane?.pane_id;
		return typeof tabId === "string" && typeof paneId === "string" ? { tabId, paneId } : null;
	}

	/** `herdr pane run <pane_id> <command>`. Launches a process in the pane. */
	async paneRun(paneId: string, command: string): Promise<boolean> {
		const r = await this.exec(this.argv(["pane", "run", paneId, command]), this.timeoutMs);
		return r.ok;
	}

	/** `herdr pane send-text <pane_id> <text>` (type without submitting). */
	async paneSendText(paneId: string, text: string): Promise<boolean> {
		const r = await this.exec(this.argv(["pane", "send-text", paneId, text]), this.timeoutMs);
		return r.ok;
	}

	/** `herdr pane send-keys <pane_id> <key…>` (e.g. Enter to submit). */
	async paneSendKeys(paneId: string, ...keys: string[]): Promise<boolean> {
		const r = await this.exec(this.argv(["pane", "send-keys", paneId, ...keys]), this.timeoutMs);
		return r.ok;
	}

	/** `herdr pane read <pane_id> --source <source> --lines <n>` → PLAIN TEXT ("" on failure). */
	async paneRead(paneId: string, source: "visible" | "recent" | "recent-unwrapped", lines: number): Promise<string> {
		const r = await this.exec(this.argv(["pane", "read", paneId, "--source", source, "--lines", String(lines)]), this.timeoutMs);
		return r.ok ? r.stdout : "";
	}

	/** `herdr pane get <pane_id>` → agent_status ("unknown" on failure). Secondary completion signal only. */
	async paneAgentStatus(paneId: string): Promise<string> {
		const data = await this.json(["pane", "get", paneId]);
		return String(data?.result?.pane?.agent_status ?? "unknown");
	}

	/**
	 * `herdr wait output <pane> --match <text> --source <source> --timeout <ms>` (level-scan): BLOCK
	 * until `match` appears in the pane's output (exit 0 → true) or the timeout lapses (→ false). This
	 * is the P6 claude-worker completion signal - the pi path polls the sweep for its regex sentinel;
	 * a claude worker's LAST action echoes `FLEET_DONE_<cardId>` and this call catches it.
	 *
	 * The per-call execFile timeout is set ABOVE herdr's own `--timeout` so herdr's wait deadline fires
	 * FIRST (a clean false), never the transport kill. A transport failure also resolves false - both
	 * routes escalate through the same watchdog path (the caller cannot tell timeout from herdr-down,
	 * and for v1 need not: either way the worker did not signal done in time).
	 */
	async waitOutput(
		paneId: string,
		match: string,
		timeoutMs: number,
		source: "visible" | "recent" | "recent-unwrapped" = "recent",
	): Promise<boolean> {
		const args = ["wait", "output", paneId, "--match", match, "--source", source, "--timeout", String(timeoutMs)];
		const r = await this.exec(this.argv(args), timeoutMs + 5_000);
		return r.ok;
	}
}

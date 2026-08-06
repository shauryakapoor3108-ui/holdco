#!/usr/bin/env node
// fake-claude.mjs - a hermetic stand-in for the `claude` CLI speaking the same
// stream-json protocol the ClaudeCodeHarness adapter drives. Plain Node, zero deps.
//
// Behavior:
//   • parses/ignores the real CLI flags (-p, --verbose, --output-format X,
//     --input-format X, --dangerously-skip-permissions, --model X); records
//     the --settings path.
//   • on start: emits a {"type":"system","subtype":"init"} line.
//   • each {"type":"user"} stdin line starts a "turn": the fake WAITS for the
//     control file named by env FAKE_CLAUDE_CONTROL to appear (poll 50ms, up
//     to 20s), CONSUMES it (read + delete), then emits an assistant line and a
//     result line built from the control JSON:
//       {"outcome":"...","costUsd":0.0042,"tokensIn":120,"tokensOut":45}
//   • keeps reading stdin (next user message = next turn, next control file).
//   • exits 0 when stdin closes.

import * as fs from "node:fs";
import * as readline from "node:readline";

const args = process.argv.slice(2);
let settingsPath = null;
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--settings") {
		settingsPath = args[++i] ?? null;
	} else if (a === "--output-format" || a === "--input-format" || a === "--model") {
		i++; // flag with a value - ignore the value
	}
	// -p / --verbose / --dangerously-skip-permissions / anything else: ignore
}

const controlPath = process.env.FAKE_CLAUDE_CONTROL;
const SESSION_ID = "fake-123";

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

emit({ type: "system", subtype: "init", session_id: SESSION_ID, settings: settingsPath, cwd: process.cwd() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the control file, then consume it (read + delete). */
async function consumeControl() {
	if (!controlPath) return null;
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const parsed = JSON.parse(fs.readFileSync(controlPath, "utf8"));
			fs.unlinkSync(controlPath);
			return parsed;
		} catch {
			await sleep(50);
		}
	}
	return null;
}

async function runTurn() {
	const ctrl = await consumeControl();
	if (!ctrl) {
		emit({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
			num_turns: 1,
			result: "fake-claude: control file never appeared",
			total_cost_usd: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
			session_id: SESSION_ID,
		});
		return;
	}
	emit({ type: "assistant", message: { content: [{ type: "text", text: "working…" }] } });
	emit({
		type: "result",
		subtype: "success",
		is_error: false,
		num_turns: 1,
		result: `All done.\nOUTCOME: ${ctrl.outcome}`,
		total_cost_usd: ctrl.costUsd ?? 0,
		usage: { input_tokens: ctrl.tokensIn ?? 0, output_tokens: ctrl.tokensOut ?? 0 },
		session_id: SESSION_ID,
	});
}

let turnChain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg?.type !== "user") return;
	turnChain = turnChain.then(() => runTurn());
});
rl.on("close", () => {
	turnChain.then(() => process.exit(0));
});

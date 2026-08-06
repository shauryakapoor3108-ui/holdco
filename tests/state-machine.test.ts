// state-machine.test.ts - smoke tests for the legal-transition matrix and
// frontmatter round-trip. Run via `node tests/state-machine.test.ts`.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { isLegal, legalTargets } from "../src/engine/state-machine.ts";
import { parseCard, writeStatus } from "../src/engine/frontmatter.ts";
import { ALL_STATUSES, LEGAL_COLUMNS, isSink, isValidStatus } from "../src/engine/types.ts";

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

// ── Transition matrix ────────────────────────────────────────────────────────
console.log("── state machine");
ok(isLegal("Draft", "Intake", "human"), "Draft → Intake legal for human");
ok(!isLegal("Draft", "Executing", "human"), "Draft → Executing illegal (no skipping the funnel)");
ok(!isLegal("Needs Approval", "Queued", "engine"), "Needs Approval → Queued NOT engine-movable (human gate holds)");
ok(isLegal("Held", "Intake", "engine"), "Held → Intake legal for engine (goal-gate release)");
ok(!isLegal("Filed", "Executing", "engine"), "no engine exit from Filed");
ok(legalTargets("Draft").length > 0, "Draft has legal targets");
ok(legalTargets("__nope__").length === 0, "unknown column has no targets");

// every edge endpoint is a known status
for (const from of LEGAL_COLUMNS) {
	for (const to of legalTargets(from)) {
		if (!isValidStatus(to)) ok(false, `edge target ${from} → ${to} is not a valid status`);
	}
}
ok(true, "every edge target is a valid status");
ok(isSink("Archived") && isSink("Quarantine"), "Archived/Quarantine are sinks");
ok(!isSink("Queued"), "Queued is live, not a sink");
ok(ALL_STATUSES.length >= 12, `status universe present (${ALL_STATUSES.length})`);

// ── Frontmatter round-trip ───────────────────────────────────────────────────
console.log("── frontmatter");
const dir = fs.mkdtempSync(join(os.tmpdir(), "holdco-fm-"));
const card = join(dir, "demo-card.md");
fs.writeFileSync(
	card,
	`---\ntype: card\nstatus: Draft\ncard_type: ops\n---\n\n## Intent\n\nDemo card body stays untouched.\n`,
);
const scan1 = parseCard(card);
ok(scan1 !== null && scan1.status === "Draft", "parseCard reads status Draft");
writeStatus(card, "Intake");
const scan2 = parseCard(card);
ok(scan2 !== null && scan2.status === "Intake", "writeStatus → parseCard round-trips to Intake");
ok(fs.readFileSync(card, "utf8").includes("Demo card body stays untouched."), "body preserved (status-line-only write)");
fs.rmSync(dir, { recursive: true, force: true });

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

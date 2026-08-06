// core.test.ts - engine-loop smoke tests against a fake host and a temp
// cards dir. Proves the standalone engine (no Pi, no daemon) enforces the
// matrix, emits landing events, recovers orphans, and honours halt.
// Run via `node tests/core.test.ts`.

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { CardEngine } from "../src/engine/core.ts";
import { parseCard } from "../src/engine/frontmatter.ts";
import type { EngineHost } from "../src/host/host.ts";
import { createStandaloneHost } from "../src/host/host.ts";

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

function makeCard(dir: string, id: string, status: string, extra = ""): string {
	const file = join(dir, `${id}.md`);
	fs.writeFileSync(file, `---\ntype: card\nstatus: ${status}\ncard_type: ops\n${extra}---\n\n## Intent\n\n${id}\n`);
	return file;
}

function setStatus(file: string, status: string): void {
	const text = fs.readFileSync(file, "utf8");
	fs.writeFileSync(file, text.replace(/^status: .*$/m, `status: ${status}`));
}

interface Capture {
	host: EngineHost;
	emitted: Array<{ event: string; payload: any }>;
	logged: Array<Record<string, unknown>>;
}
function captureHost(flags: Record<string, string>): Capture {
	const emitted: Array<{ event: string; payload: any }> = [];
	const logged: Array<Record<string, unknown>> = [];
	const host = createStandaloneHost({ flags, quiet: true, sink: (_kind, data) => logged.push(data) });
	const origEmit = host.events.emit.bind(host.events);
	host.events.emit = (event, payload) => {
		emitted.push({ event, payload });
		origEmit(event, payload);
	};
	return { host, emitted, logged };
}

const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-core-"));
const cardsDir = join(root, "cards");
fs.mkdirSync(cardsDir);

// Seed BEFORE boot: one orphan (Executing), one normal card.
makeCard(cardsDir, "orphan", "Executing");
makeCard(cardsDir, "alpha", "Draft");

const { host, emitted, logged } = captureHost({ "cards-dir": cardsDir, "card-events-off": "true", "card-sweep-ms": "60000" });
const engine = new CardEngine(host, { cwd: root, noLease: true });

console.log("── boot + orphan recovery");
const boot = engine.start();
ok(boot.owner === true, "engine starts (noLease)");
ok(parseCard(join(cardsDir, "orphan.md")).status === "Needs Review", "orphan Executing → Needs Review at boot");
ok(logged.some((e) => e.event === "ORPHAN_RECOVERED"), "ORPHAN_RECOVERED logged");
ok(logged.some((e) => e.event === "ENGINE_STARTED"), "ENGINE_STARTED logged");

console.log("── legal human move + landing event");
setStatus(join(cardsDir, "alpha.md"), "Intake");
engine.runReconcile("sweep");
ok(parseCard(join(cardsDir, "alpha.md")).status === "Intake", "Draft → Intake sticks (legal human move)");
ok(emitted.some((e) => e.event === "card:intake" && e.payload.id === "alpha"), "card:intake landing event emitted");

console.log("── illegal move auto-reverts");
setStatus(join(cardsDir, "alpha.md"), "Executing");
engine.runReconcile("sweep");
ok(parseCard(join(cardsDir, "alpha.md")).status === "Intake", "Intake → Executing reverted (illegal)");
ok(logged.some((e) => e.event === "ILLEGAL_REVERT"), "ILLEGAL_REVERT logged");

console.log("── needs-approval landing (NEW_CARD route)");
makeCard(cardsDir, "beta", "Needs Approval");
engine.runReconcile("sweep");
ok(emitted.some((e) => e.event === "card:needs-approval" && e.payload.id === "beta"), "card:needs-approval emitted for NEW_CARD landing");

console.log("── halt suppression");
makeCard(cardsDir, "halted", "Intake", "halt: true\n");
const before = emitted.length;
engine.runReconcile("sweep");
ok(!emitted.slice(before).some((e) => e.payload?.id === "halted"), "halted card emits NO landing event");

console.log("── quarantine invalid status");
makeCard(cardsDir, "junk", "Banana");
engine.runReconcile("sweep");
ok(parseCard(join(cardsDir, "junk.md")).status === "Quarantine", "invalid status → Quarantine");

engine.stop();
ok(logged.some((e) => e.event === "ENGINE_STOPPED"), "ENGINE_STOPPED logged on stop()");

fs.rmSync(root, { recursive: true, force: true });

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

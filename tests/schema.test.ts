// schema.test.ts — the schema layer: (i) unit tests for the zero-dep JSON
// Schema validator subset (src/schema/validate.ts), (ii) a fixture walk —
// every schema/fixtures/*.valid.*.json must pass its schema and every
// *.invalid.*.json must fail, (iii) integration — KnowledgeStore.ensure()
// seeds must validate against permissions/constraints schemas.
// Run via `node tests/schema.test.ts`.

import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validate, validateFile } from "../src/schema/validate.ts";
import { KnowledgeStore } from "../src/knowledge/store.ts";

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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = join(repoRoot, "schema");
const fixturesDir = join(schemaDir, "fixtures");

// ── (i) validator subset unit tests ─────────────────────────────────────────

console.log("── validator: type");
ok(validate({ type: "string" }, "hi").valid, "string accepts string");
{
	const r = validate({ type: "string" }, 7);
	ok(!r.valid && r.errors[0].includes("expected string"), "string rejects number with message");
}
ok(validate({ type: "integer" }, 3).valid, "integer accepts 3");
ok(!validate({ type: "integer" }, 3.5).valid, "integer rejects 3.5");
ok(validate({ type: "number" }, 3.5).valid, "number accepts 3.5");
ok(validate({ type: "boolean" }, false).valid, "boolean accepts false");
ok(validate({ type: "null" }, null).valid, "null accepts null");
ok(!validate({ type: "object" }, null).valid, "object rejects null");
ok(!validate({ type: "object" }, [1]).valid, "object rejects array");
ok(validate({ type: "array" }, []).valid, "array accepts []");
ok(validate({ type: ["number", "string"] }, "x").valid, "type array accepts string");
ok(validate({ type: ["number", "string"] }, 1).valid, "type array accepts number");
{
	const r = validate({ type: ["number", "string"] }, true);
	ok(!r.valid && r.errors[0].includes("number|string"), "type array rejects boolean, names both types");
}

console.log("── validator: enum + const");
ok(validate({ enum: ["a", "b"] }, "b").valid, "enum accepts member");
{
	const r = validate({ enum: ["a", "b"] }, "c");
	ok(!r.valid && r.errors[0].includes("not in enum"), "enum rejects non-member with message");
}
ok(validate({ const: "card" }, "card").valid, "const accepts exact value");
{
	const r = validate({ const: "card" }, "deck");
	ok(!r.valid && r.errors[0].includes("expected const"), "const rejects other value with message");
}

console.log("── validator: object keywords");
{
	const r = validate({ type: "object", required: ["id"] }, {});
	ok(!r.valid && r.errors[0].includes('missing required property "id"'), "required reports missing key");
}
{
	const schema = { type: "object", properties: { n: { type: "integer" } } };
	ok(validate(schema, { n: 1 }).valid, "properties validates present key");
	const r = validate(schema, { n: "1" });
	ok(!r.valid && r.errors[0].startsWith("/n:"), "property error carries /n path");
}
{
	const schema = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
	ok(validate(schema, { a: "x" }).valid, "additionalProperties:false accepts declared key");
	const r = validate(schema, { a: "x", b: 1 });
	ok(!r.valid && r.errors[0].includes('unexpected additional property "b"'), "additionalProperties:false rejects extra key");
}
{
	// Nested path shape, mirroring the stage-event usage object.
	const schema = { type: "object", properties: { usage: { type: "object", properties: { cost_usd: { type: "number" } } } } };
	const r = validate(schema, { usage: { cost_usd: "free" } });
	ok(!r.valid && r.errors[0].startsWith("/usage/cost_usd:") && r.errors[0].includes("expected number"), "nested error path is /usage/cost_usd");
}

console.log("── validator: items / pattern / minimum / minLength");
{
	const schema = { type: "array", items: { type: "string", pattern: "^[a-z-]+$" } };
	ok(validate(schema, ["demo-widget", "audit"]).valid, "items accepts conforming array");
	const r = validate(schema, ["ok", "NOT OK"]);
	ok(!r.valid && r.errors[0].startsWith("/1:") && r.errors[0].includes("pattern"), "items pattern failure carries /1 path");
}
{
	const r = validate({ type: "string", pattern: "^[A-Za-z0-9._-]+$" }, "bad id!");
	ok(!r.valid && r.errors[0].includes("does not match pattern"), "pattern rejects with message");
}
ok(validate({ type: "number", minimum: 0 }, 0).valid, "minimum accepts boundary");
{
	const r = validate({ type: "number", minimum: 0 }, -1);
	ok(!r.valid && r.errors[0].includes("minimum"), "minimum rejects -1");
}
ok(validate({ type: "string", minLength: 1 }, "x").valid, "minLength accepts boundary");
{
	const r = validate({ type: "string", minLength: 1 }, "");
	ok(!r.valid && r.errors[0].includes("minLength"), "minLength rejects empty string");
}

console.log("── validator: anyOf");
{
	const schema = { anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }] };
	ok(validate(schema, true).valid, "anyOf accepts first branch");
	ok(validate(schema, "false").valid, "anyOf accepts second branch");
	const r = validate(schema, "yes");
	ok(!r.valid && r.errors[0].includes("anyOf"), "anyOf rejects value matching no branch");
	ok(r.errors[0].startsWith("/:"), "anyOf root error carries / path");
}

// ── (ii) fixture walk ────────────────────────────────────────────────────────

console.log("── fixtures: valid must pass, invalid must fail");
const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
ok(fixtureFiles.length >= 20, `at least 20 fixtures present (found ${fixtureFiles.length})`);
for (const file of fixtureFiles) {
	const m = /^(.+)\.(valid|invalid)\.\d+\.json$/.exec(file);
	if (!m) {
		ok(false, `fixture name unrecognised: ${file}`);
		continue;
	}
	const schemaPath = join(schemaDir, `${m[1]}.schema.json`);
	const value = JSON.parse(fs.readFileSync(join(fixturesDir, file), "utf8"));
	const r = validateFile(schemaPath, value);
	if (m[2] === "valid") {
		ok(r.valid, `${file} passes ${m[1]} schema${r.valid ? "" : ` — ${r.errors.join("; ")}`}`);
	} else {
		ok(!r.valid && r.errors.length >= 1, `${file} fails ${m[1]} schema with >=1 error`);
	}
}

// ── (iii) integration: KnowledgeStore seeds validate ─────────────────────────

console.log("── integration: KnowledgeStore.ensure() seeds validate");
const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-schema-"));
const store = new KnowledgeStore(root);
store.ensure();

{
	const seeded = JSON.parse(fs.readFileSync(join(root, "knowledge", "permissions.json"), "utf8"));
	const r = validateFile(join(schemaDir, "permissions.schema.json"), seeded);
	ok(r.valid, `seeded permissions.json validates${r.valid ? "" : ` — ${r.errors.join("; ")}`}`);
}
{
	const raw = fs.readFileSync(join(root, "knowledge", "constraints.md"), "utf8");
	const m = /^---\nversion:\s*(\d+)\n---\n/.exec(raw);
	ok(m !== null, "seeded constraints.md has version frontmatter");
	const frontmatter = m ? { version: Number(m[1]) } : {};
	const r = validateFile(join(schemaDir, "constraints.schema.json"), frontmatter);
	ok(r.valid, `seeded constraints.md frontmatter validates${r.valid ? "" : ` — ${r.errors.join("; ")}`}`);
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

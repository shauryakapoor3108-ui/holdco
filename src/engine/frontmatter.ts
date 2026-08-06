// frontmatter.ts - parse cards + surgical, field-preserving status writes.
//
// CRITICAL (test 13): writeStatus touches ONLY the `status:` line plus additive
// annotation lines and an appended body-log line. cost_total / log / outcome /
// brief and every other field are left byte-identical. We do a targeted line
// edit, never a full YAML re-serialize (which would reorder/reformat/risk drops).
//
// All writes are SYNCHRONOUS (fs.writeFileSync) per the plan-verifier condition:
// the snapshot is synced by the caller before control returns to the event loop,
// so an fs.watch event fired by our own write sees no delta (loop-suppressed).

import * as fs from "node:fs";
import { basename } from "node:path";
import { isValidCardType } from "./types.ts";

const FM_RE = /^---\n([\s\S]*?)\n---/;

export interface ParsedCard {
	hasFrontmatter: boolean;
	isCard: boolean; // frontmatter `type` === "card"
	id: string; // frontmatter `id` || basename
	status: string; // cleaned scalar value ("" if missing/empty)
	cardType: string; // raw `card_type` scalar ("" if missing/empty) - D3 governance axis
}

/** Strip surrounding quotes and any trailing unquoted `# comment`. */
function cleanScalar(raw: string): string {
	let v = raw.trim();
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
		return v.slice(1, -1);
	}
	const hash = v.search(/\s#/);
	if (hash >= 0) v = v.slice(0, hash).trim();
	return v;
}

/** Raw captured value of `key:` within a frontmatter block, or null if absent. */
function rawField(block: string, key: string): string | null {
	const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
	return m ? m[1] : null;
}

export function parseCard(file: string): ParsedCard {
	const id0 = basename(file).replace(/\.md$/, "");
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { hasFrontmatter: false, isCard: false, id: id0, status: "", cardType: "" };
	}
	const m = text.match(FM_RE);
	if (!m) return { hasFrontmatter: false, isCard: false, id: id0, status: "", cardType: "" };
	const block = m[1];
	const type = cleanScalar(rawField(block, "type") ?? "");
	const id = cleanScalar(rawField(block, "id") ?? "") || id0;
	const status = cleanScalar(rawField(block, "status") ?? "");
	const cardType = cleanScalar(rawField(block, "card_type") ?? "");
	return { hasFrontmatter: true, isCard: type === "card", id, status, cardType };
}

/**
 * Read a single frontmatter line value **raw** (trimmed, NOT cleaned) from
 * `file`, or null if the file / frontmatter / key is absent. Used by the
 * reconciler's idempotency gate for the `card_type_invalid` annotation (D3 §4):
 * the gate compares the stored marker against the exact serialized string it
 * would write (`JSON.stringify(raw)`). It MUST be raw - `cleanScalar`'s
 * quote-stripping is asymmetric for values containing an embedded quote /
 * backslash, which would defeat the comparison and cause a re-write every sweep.
 */
export function readRawField(file: string, key: string): string | null {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const m = text.match(FM_RE);
	if (!m) return null;
	const raw = rawField(m[1], key);
	return raw === null ? null : raw.trim();
}

// ── Goal system (ADR: Held state & dependency DAG) frontmatter fields ──────────
// `goal` (slug scalar), `depends_on` (a DAG edge list), and `goal_blocked` (the
// reactor-owned advisory) are new fields the RECONCILER IGNORES (it diffs only
// `status`). They are read here for `/commit-goal` (goal + depends_on) and the
// goal-gate reactor (depends_on + a dep's status via parseCard), and `goal_blocked`
// is written ONLY by the reactor via `writeGoalBlocked` below. Byte convention:
// the canonical `depends_on` form is inline flow - `depends_on: [a, b]` - a SINGLE
// line, so it survives every flat frontmatter parser round-trip (this file's
// `rawField`, fleet's LINE_RE, `updatePlanningFields`) without dropping edges.

/** The frontmatter YAML block of `file`, or null if the file / fence is absent. */
function readBlock(file: string): string | null {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const m = text.match(FM_RE);
	return m ? m[1] : null;
}

/** Read the `goal` slug scalar (cleaned), or "" if absent. */
export function readGoal(file: string): string {
	const block = readBlock(file);
	return block === null ? "" : cleanScalar(rawField(block, "goal") ?? "");
}

/**
 * Read the `depends_on` DAG edge list (an array of card ids). Canonical byte form is
 * inline flow `depends_on: [a, b]`; this reader ALSO tolerates Obsidian's block-list
 * rewrite (`depends_on:` then `  - a` / `  - b`) so a human editing the property in the
 * Obsidian Properties UI never silently drops edges, and a bare single scalar
 * (`depends_on: a`). Absent / empty ⇒ `[]` (a root card).
 */
export function readDependsOn(file: string): string[] {
	const block = readBlock(file);
	if (block === null) return [];
	const raw = rawField(block, "depends_on");
	if (raw === null) return [];
	const inline = raw.trim();
	if (inline.startsWith("[")) {
		// flow style: [a, b, c] (tolerate a missing closing ]).
		const inner = inline.replace(/^\[/, "").replace(/\]$/, "");
		return inner.split(",").map((s) => cleanScalar(s)).filter(Boolean);
	}
	if (inline !== "") return [cleanScalar(inline)].filter(Boolean); // a bare single scalar
	// block style: read the subsequent `  - item` lines within the frontmatter block.
	const lines = block.split("\n");
	const idx = lines.findIndex((l) => /^depends_on:[ \t]*$/.test(l));
	if (idx < 0) return [];
	const out: string[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		const lm = lines[i].match(/^[ \t]*-[ \t]*(.*)$/);
		if (!lm) break; // first non-list line ends the block
		const v = cleanScalar(lm[1]);
		if (v) out.push(v);
	}
	return out;
}

/** The canonical inline-flow serialization of a `depends_on` list VALUE (`[a, b]`; `[]` when empty). */
export function serializeDependsOn(deps: string[]): string {
	return `[${deps.map((d) => d.trim()).filter(Boolean).join(", ")}]`;
}

/** Read the reactor-owned `goal_blocked` advisory scalar (cleaned), or "" if absent. */
export function readGoalBlocked(file: string): string {
	const block = readBlock(file);
	return block === null ? "" : cleanScalar(rawField(block, "goal_blocked") ?? "");
}

/**
 * Write the reactor-owned advisory `goal_blocked` field (goal-system ADR §5) - the ONLY field the
 * goal-gate reactor may write. It NEVER writes `status` (the single-writer-of-status seam holds: the
 * reactor OFFERS `goal:release`, the engine writes status). Field-preserving + surgical (upsert the
 * one line, every sibling byte-identical), synchronous, plus one audit log line - exactly `annotate`'s
 * loop-suppression contract. Serialized quoted (`goal_blocked: "<dep> is <status>"`) so
 * `readGoalBlocked` round-trips a value containing spaces.
 */
export function writeGoalBlocked(file: string, reason: string): void {
	annotate(file, { goal_blocked: JSON.stringify(reason) }, `goal blocked: ${reason} (goal-gate)`);
}

export interface WriteOpts {
	annotations?: Record<string, string>; // additive frontmatter fields (replace-if-present)
	logLine?: string; // appended under the body "## Reconciler Log" section
}

/**
 * Write `newStatus` to a card's frontmatter, preserving every other field.
 * Throws if the file has no frontmatter (callers only target real cards).
 */
export function writeStatus(file: string, newStatus: string, opts: WriteOpts = {}): void {
	const text = fs.readFileSync(file, "utf8");
	const m = text.match(FM_RE);
	if (!m) throw new Error(`writeStatus: no frontmatter in ${file}`);

	const fullMatch = m[0]; // includes leading --- and trailing ---
	let block = m[1]; // inner YAML

	// 1. Replace (or insert) the `status:` line - surgical, comment-preserving.
	const statusLineRe = /^(status:)([ \t]*)(.*)$/m;
	if (statusLineRe.test(block)) {
		block = block.replace(statusLineRe, (_full, key: string, sp: string, rest: string) => {
			const commentMatch = rest.match(/\s+#.*$/); // preserve a trailing comment
			const comment = commentMatch ? commentMatch[0] : "";
			return `${key}${sp || " "}${newStatus}${comment}`;
		});
	} else {
		block = `${block}\nstatus: ${newStatus}`;
	}

	// 2. Additive annotations - replace the line if present, else append.
	for (const [k, v] of Object.entries(opts.annotations ?? {})) {
		const re = new RegExp(`^${k}:[ \\t]*.*$`, "m");
		const line = `${k}: ${v}`;
		block = re.test(block) ? block.replace(re, line) : `${block}\n${line}`;
	}

	const newFm = `---\n${block}\n---`;
	// Function replacement => literal (no $-pattern interpretation in newFm).
	let out = text.replace(fullMatch, () => newFm);

	// 3. Append a timestamped body-log line under "## Reconciler Log".
	if (opts.logLine) out = appendLog(out, opts.logLine);

	fs.writeFileSync(file, out, "utf8");
}

/**
 * Non-destructive frontmatter annotation (D3 §4). Writes additive frontmatter
 * fields (replace-if-present, else append) and an optional appended body-log
 * line - and NEVER touches the `status:` line. It is exactly `writeStatus` minus
 * the status-replacement step, so a present-but-invalid `card_type` can be
 * surfaced without clobbering a valid `status` (the round-1 Pi flag). Same
 * loop-suppression contract as `writeStatus`: synchronous, status byte-identical.
 */
export function annotate(file: string, annotations: Record<string, string>, logLine?: string): void {
	const text = fs.readFileSync(file, "utf8");
	const m = text.match(FM_RE);
	if (!m) throw new Error(`annotate: no frontmatter in ${file}`);

	const fullMatch = m[0]; // includes leading --- and trailing ---
	let block = m[1]; // inner YAML - status line is NEVER read or rewritten here

	// Additive annotations only - replace the line if present, else append.
	for (const [k, v] of Object.entries(annotations)) {
		const re = new RegExp(`^${k}:[ \\t]*.*$`, "m");
		const line = `${k}: ${v}`;
		block = re.test(block) ? block.replace(re, () => line) : `${block}\n${line}`;
	}

	const newFm = `---\n${block}\n---`;
	// Function replacement => literal (no $-pattern interpretation in newFm).
	let out = text.replace(fullMatch, () => newFm);

	if (logLine) out = appendLog(out, logLine);

	fs.writeFileSync(file, out, "utf8");
}

/**
 * Surgically upsert a body `## <header>` section, preserving every sibling section
 * (and NEVER touching frontmatter or `## Reconciler Log`). Pure: takes the full file
 * text, returns the new text - the caller does the read/write + the rewrite-on-delta
 * gate (so an unchanged section is a no-op write). Used by `card-preview` for the
 * deterministic `## Preview` block (spec D4 Deliverable 1).
 *
 * If the section is absent it is inserted **before** `## Reconciler Log` (so the log
 * stays last), else appended at EOF. If present, its content (everything up to the
 * next `## ` header or EOF) is replaced. Idempotent: replacing identical content
 * yields byte-identical text. Mirrors `card-write.ts`'s `setSection` discipline.
 */
export function upsertBodySection(text: string, header: string, content: string): string {
	const lines = text.split("\n");
	const marker = `## ${header}`;
	const hi = lines.findIndex((l) => l.trim() === marker);
	const bodyLines = content.length ? content.split("\n") : [];

	if (hi === -1) {
		const ri = lines.findIndex((l) => l.trim() === "## Reconciler Log");
		const at = ri === -1 ? lines.length : ri;
		lines.splice(at, 0, marker, ...bodyLines, "");
		return lines.join("\n");
	}

	let next = lines.length;
	for (let i = hi + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			next = i;
			break;
		}
	}
	lines.splice(hi + 1, next - (hi + 1), ...bodyLines, "");
	return lines.join("\n");
}

/**
 * APPEND `line` as a new trailing line to a `## <header>` body section (create the section if
 * absent), reusing `upsertBodySection`'s section-boundary + placement discipline. Pure: takes full
 * card text, returns new text (the caller wraps it in an atomic write). This is the append-mode
 * counterpart of `upsertBodySection` (which REPLACES) - used for `## Discussion`, an append-only
 * thread that both the control-inbox drainer (human comments) and the auto-planner (its Q&A) grow.
 */
export function appendBodySection(text: string, header: string, line: string): string {
	const lines = text.split("\n");
	const hi = lines.findIndex((l) => l.trim() === `## ${header}`);
	if (hi === -1) return upsertBodySection(text, header, line);
	let next = lines.length;
	for (let i = hi + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			next = i;
			break;
		}
	}
	const current = lines.slice(hi + 1, next).join("\n").trim();
	return upsertBodySection(text, header, current ? `${current}\n${line}` : line);
}

/**
 * Surgically DELETE a single frontmatter `key:` line, field-preserving (every other
 * field byte-identical), one atomic write. The minimal field-delete primitive
 * `frontmatter.ts` lacked (`writeStatus`/`annotate` only add/replace). Used by the
 * reconciler's §6 stale-mark clear (D4). **Hard-throws on `key === "status"`** - the
 * single-writer-of-status seam is never deletable either (same guard discipline as
 * `card-write.ts`'s `setField`). Throws if the file has no frontmatter.
 */
export function removeField(file: string, key: string): void {
	if (key === "status") {
		throw new Error("removeField: the single-writer-of-status seam - `status` is never deletable");
	}
	const text = fs.readFileSync(file, "utf8");
	const m = text.match(FM_RE);
	if (!m) throw new Error(`removeField: no frontmatter in ${file}`);
	const fullMatch = m[0];
	let block = m[1];
	block = block.replace(new RegExp(`^${key}:[ \\t]*.*\\n?`, "m"), "");
	const newFm = `---\n${block}\n---`;
	const out = text.replace(fullMatch, () => newFm);
	fs.writeFileSync(file, out, "utf8");
}

/**
 * The SANCTIONED human `card_type` reclassify primitive (D4 Deliverable 2) - distinct
 * from the model's blocked `update_card` path (`card-write.ts:144-145` stays a soft
 * single-set no-op; only this control may overwrite a valid `card_type`). It:
 *   - validates `cardType ∈ CARD_TYPES` via `isValidCardType` (single source of truth) -
 *     THROWS on free text / invalid (the `/reclassify` command pre-validates + lists the
 *     valid set, so a throw here is a programming error, not a human typo);
 *   - is ALLOWED to overwrite an already-valid `card_type` (the whole point);
 *   - writes ONLY the `card_type` field - field-preserving + atomic; NEVER writes
 *     `status` (the single-writer-of-status seam is untouched);
 *   - clears a stale `card_type_invalid` mark INLINE in the SAME atomic write (spec
 *     addendum A): doing it in one write closes the audit-attribution race with the
 *     reconciler-side §6 clear (a 2-write set-then-remove would expose a valid+marked
 *     state a sweep could audit as "reconciled" instead of "(human)");
 *   - appends one `card_type reclassified <old> → <new> (human)` audit line.
 * It is NOT registered as a model tool - invoked only from the human `/reclassify`.
 */
export function reclassifyCardType(file: string, cardType: string): void {
	if (!isValidCardType(cardType)) {
		throw new Error(`reclassifyCardType: invalid card_type ${JSON.stringify(cardType)} (must be one of CARD_TYPES)`);
	}
	const text = fs.readFileSync(file, "utf8");
	const m = text.match(FM_RE);
	if (!m) throw new Error(`reclassifyCardType: no frontmatter in ${file}`);
	const fullMatch = m[0];
	let block = m[1];
	const old = cleanScalar(rawField(block, "card_type") ?? "") || "(unset)";
	// 1. Set card_type - replace the line if present, else append. NEVER touches `status`.
	const ctRe = /^card_type:[ \t]*.*$/m;
	const ctLine = `card_type: ${cardType}`;
	block = ctRe.test(block) ? block.replace(ctRe, () => ctLine) : `${block}\n${ctLine}`;
	// 2. Clear a stale card_type_invalid mark in THIS write (addendum A - atomic).
	block = block.replace(/^card_type_invalid:[ \t]*.*\n?/m, "");
	const newFm = `---\n${block}\n---`;
	let out = text.replace(fullMatch, () => newFm);
	// 3. Append the human audit line under "## Reconciler Log".
	out = appendLog(out, `card_type reclassified ${old} → ${cardType} (human)`);
	fs.writeFileSync(file, out, "utf8");
}

function appendLog(text: string, line: string): string {
	const entry = `- ${new Date().toISOString()} - ${line}`;
	const header = "## Reconciler Log";
	const trimmed = text.replace(/\s*$/, "");
	if (text.includes(header)) return `${trimmed}\n${entry}\n`;
	return `${trimmed}\n\n${header}\n${entry}\n`;
}

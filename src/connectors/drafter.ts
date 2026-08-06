// drafter.ts - normalize(source_event) → a drafted card with provenance.
//
// Engine-side and connector-agnostic: every intake surface produces the SAME
// card shape. The card lands at Draft - the top of the funnel, outside every
// engine-driven edge - so nothing executes until a human (or a later triage
// rule) deliberately promotes it. Dedupe is deterministic: the card id is
// derived from the source_ref hash, so an at-least-once transport can
// redeliver forever and still draft exactly one card.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type { SourceEvent } from "./types.ts";

export interface CardDrafterDeps {
	cardsDir: string;
	/** Provenance value for the `drafter:` field, e.g. "connector:discord". */
	drafter: string;
	/** Log sink (optional). */
	log?: (event: string, data: Record<string, unknown>) => void;
}

export interface DraftResult {
	id: string;
	file: string;
	/** false when the card already existed (redelivery - nothing written). */
	created: boolean;
}

/** Frontmatter-safe one-line scalar (quoted, newlines collapsed, clipped). */
function fmScalar(s: string, max = 180): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return JSON.stringify(flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`);
}

export class CardDrafter {
	private readonly d: CardDrafterDeps;

	constructor(d: CardDrafterDeps) {
		this.d = d;
	}

	/** Deterministic card id for a source item: `in-<8-char sha256 of source_ref>`. */
	idFor(ev: SourceEvent): string {
		return `in-${createHash("sha256").update(ev.sourceRef).digest("hex").slice(0, 8)}`;
	}

	/** Draft the card (idempotent). Returns created:false on redelivery. */
	draft(ev: SourceEvent): DraftResult {
		fs.mkdirSync(this.d.cardsDir, { recursive: true });
		const id = this.idFor(ev);
		const file = join(this.d.cardsDir, `${id}.md`);
		if (fs.existsSync(file)) {
			this.d.log?.("INTAKE_DUPLICATE", { card: id, source_ref: ev.sourceRef });
			return { id, file, created: false };
		}
		const card =
			`---\n` +
			`type: card\n` +
			`id: ${id}\n` +
			`title: ${fmScalar(ev.title || ev.body || ev.sourceRef)}\n` +
			`status: Draft\n` +
			`created_at: ${new Date().toISOString().slice(0, 10)}\n` +
			`surfaced_by: ${fmScalar(ev.surfacedBy)}\n` +
			`source_type: ${fmScalar(ev.sourceType)}\n` +
			`source_ref: ${fmScalar(ev.sourceRef, 400)}\n` +
			`drafter: ${fmScalar(this.d.drafter)}\n` +
			`received_at: ${fmScalar(ev.receivedAt)}\n` +
			`---\n\n` +
			`## Intent\n${ev.body.trim()}\n\n` +
			`## Reconciler Log\n` +
			`- ${new Date().toISOString()} - drafted from ${ev.sourceType} by ${this.d.drafter} (surfaced by ${ev.surfacedBy.replace(/\s+/g, " ").trim()})\n`;
		fs.writeFileSync(file, card, "utf8");
		this.d.log?.("INTAKE_DRAFTED", { card: id, source_type: ev.sourceType, source_ref: ev.sourceRef, surfaced_by: ev.surfacedBy });
		return { id, file, created: true };
	}
}

// conformance.ts - the executable definition of "a working Connector".
//
// Shipped (not test-only) so a contributor adding Slack / Telegram / webhook
// intake runs exactly this against their implementation, the same way harness
// authors run src/harness/conformance.ts. The caller provides a world that can
// inject items into the (real or faked) source.

import * as fs from "node:fs";
import { validateFile } from "../schema/validate.ts";
import { CardDrafter } from "./drafter.ts";
import type { Connector, SourceEvent } from "./types.ts";

export interface ConnectorWorld {
	connector: Connector;
	/** Inject one item into the watched source; the connector must deliver it.
	 *  Returns the source_ref the item will carry. */
	injectItem(n: number): Promise<string>;
	/** Redeliver the SAME item (or restart-equivalent) - dedupe must hold. */
	redeliverLast(): Promise<void>;
	/** A temp cards dir for the drafting checks. */
	cardsDir: string;
	/** Path to schema/card-frontmatter.schema.json. */
	cardSchemaPath: string;
	/** How long to wait for a delivery (poll-cadence dependent). */
	deliveryTimeoutMs?: number;
}

export interface ConnectorCheck {
	id: string;
	ok: boolean;
	detail: string;
}

async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = get();
		if (v !== undefined) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	return get();
}

export async function runConnectorConformance(world: ConnectorWorld): Promise<ConnectorCheck[]> {
	const checks: ConnectorCheck[] = [];
	const push = (id: string, ok: boolean, detail = "") => checks.push({ id, ok, detail });
	const timeout = world.deliveryTimeoutMs ?? 5_000;

	const received: SourceEvent[] = [];
	const stop = await world.connector.start((ev) => received.push(ev));
	push("start", true, world.connector.name);

	// 1. delivery + provenance completeness
	const ref1 = await world.injectItem(1);
	const ev1 = await waitFor(() => received.find((e) => e.sourceRef === ref1), timeout);
	push("delivers-new-item", !!ev1, ev1 ? ev1.sourceRef : `nothing delivered within ${timeout}ms`);
	if (ev1) {
		const fields: Array<keyof SourceEvent> = ["sourceType", "sourceRef", "surfacedBy", "title", "body", "receivedAt"];
		const empty = fields.filter((f) => !String(ev1[f] ?? "").trim());
		push("provenance-complete", empty.length === 0, empty.length ? `empty: ${empty.join(", ")}` : "all provenance fields non-empty");

		// 2. drafting: card exists, schema-valid, Draft, provenance on frontmatter
		const drafter = new CardDrafter({ cardsDir: world.cardsDir, drafter: `connector:${world.connector.name}` });
		const res = drafter.draft(ev1);
		push("drafts-card", res.created && fs.existsSync(res.file), res.file);
		const text = fs.readFileSync(res.file, "utf8");
		push("card-lands-at-draft", /^status:\s*Draft$/m.test(text), text.match(/^status:.*$/m)?.[0] ?? "no status");
		for (const f of ["surfaced_by", "source_type", "source_ref", "drafter"]) {
			push(`provenance-${f}`, new RegExp(`^${f}:\\s*\\S`, "m").test(text), text.match(new RegExp(`^${f}:.*$`, "m"))?.[0] ?? "missing");
		}
		// frontmatter → object (line-scalars only - the drafter writes only scalars)
		const fmText = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
		const fm: Record<string, unknown> = {};
		for (const line of fmText.split("\n")) {
			const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
			if (!m) continue;
			const v = m[2];
			fm[m[1]] = v.startsWith('"') ? JSON.parse(v) : v;
		}
		const verdict = validateFile(world.cardSchemaPath, fm);
		push("card-schema-valid", verdict.valid, verdict.errors.join("; "));

		// 3. dedupe under at-least-once delivery
		await world.redeliverLast();
		await new Promise((r) => setTimeout(r, Math.min(timeout, 1_000)));
		const again = received.filter((e) => e.sourceRef === ref1);
		const res2 = drafter.draft(again[again.length - 1] ?? ev1);
		push("dedupe-on-redelivery", !res2.created && res2.id === res.id, `draft#2 created=${res2.created}`);
	}

	// 4. stop is idempotent + silences delivery
	await stop();
	await stop();
	push("stop-idempotent", true, "stop called twice without throw");
	const countBefore = received.length;
	await world.injectItem(2);
	await new Promise((r) => setTimeout(r, Math.min(timeout, 1_500)));
	push("no-delivery-after-stop", received.length === countBefore, `received ${received.length - countBefore} post-stop event(s)`);

	return checks;
}

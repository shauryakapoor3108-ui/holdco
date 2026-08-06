// types.ts - the Connector contract: the intake mirror of the Harness seam.
//
// Harness adapters plug in on the way OUT (executing work); connectors plug in
// on the way IN (surfacing work). The symmetry IS the architecture: the engine
// sits in the middle and neither side knows the other exists.
//
//   subscribe → normalize(source_event) → draft card w/ provenance
//
// A connector's ONLY job is to watch a source and deliver normalized
// SourceEvents. Drafting is engine-side (CardDrafter) so every connector's
// cards look identical: same frontmatter, same provenance fields
// {surfaced_by, source_type, source_ref, drafter}, same Draft landing -
// a human (or a later triage rule) promotes them into the funnel.
//
// Contract rules (conformance-tested, src/connectors/conformance.ts):
//   1. Every SourceEvent field is non-empty - provenance is not optional.
//   2. Delivery is at-least-once; DEDUPE lives in the drafter (source_ref is
//      the identity), so a redelivered event never drafts a second card.
//   3. stop() is idempotent and silences delivery - no events after stop.
//   4. A transport failure must not throw out of the watch loop - log + retry
//      next poll (the engine's board must never die of a flaky inbox).

export interface SourceEvent {
	/** What kind of source produced it: "discord-message", "email", … */
	sourceType: string;
	/** Stable identity of the source item (message URL/id, RFC-822 Message-ID).
	 *  THE dedupe key - must be identical when the same item is redelivered. */
	sourceRef: string;
	/** Who surfaced it (author handle, From address). */
	surfacedBy: string;
	/** Short human title (subject line / first line of the message). */
	title: string;
	/** The full normalized text body. */
	body: string;
	/** ISO timestamp of the source item (not of the poll). */
	receivedAt: string;
}

export type StopFn = () => Promise<void>;

export interface Connector {
	/** Stable connector id - becomes the card's `drafter: connector:<name>`. */
	readonly name: string;
	/** Begin watching the source. Each NEW item is delivered to onEvent
	 *  (at-least-once). Resolves once the watch is armed; returns stop(). */
	start(onEvent: (ev: SourceEvent) => void): Promise<StopFn>;
}

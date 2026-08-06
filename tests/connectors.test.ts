// connectors.test.ts - hermetic tests for the v1 intake connectors.
// Drafter unit checks, a fake Discord REST endpoint behind an injected
// fetchFn, an in-process fake IMAP4rev1 server on node:net, and the shipped
// connector conformance suite run against both connectors.
// Run via `node tests/connectors.test.ts`.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { join } from "node:path";

import { runConnectorConformance } from "../src/connectors/conformance.ts";
import { DiscordConnector } from "../src/connectors/discord.ts";
import { CardDrafter } from "../src/connectors/drafter.ts";
import { ImapConnector } from "../src/connectors/imap.ts";
import type { SourceEvent } from "../src/connectors/types.ts";
import { validateFile } from "../src/schema/validate.ts";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = get();
		if (v !== undefined) return v;
		if (Date.now() >= deadline) return undefined;
		await sleep(20);
	}
}

/** Parse a card's scalar frontmatter (same approach the conformance uses). */
function parseFrontmatter(text: string): Record<string, unknown> {
	const fmText = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const fm: Record<string, unknown> = {};
	for (const line of fmText.split("\n")) {
		const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
		if (!m) continue;
		fm[m[1]] = m[2].startsWith('"') ? JSON.parse(m[2]) : m[2];
	}
	return fm;
}

const root = fs.mkdtempSync(join(os.tmpdir(), "holdco-connectors-"));
const schemaPath = join(import.meta.dirname, "..", "schema", "card-frontmatter.schema.json");

// ─────────────────────────────────────────────────────────── drafter unit
console.log("── drafter unit");
{
	const dir = join(root, "drafter-cards");
	const logged: string[] = [];
	const drafter = new CardDrafter({ cardsDir: dir, drafter: "connector:test", log: (event) => logged.push(event) });
	const ev: SourceEvent = {
		sourceType: "email",
		sourceRef: "<msg-1@holdco.test>",
		surfacedBy: "operator@holdco.test",
		title: 'He said "hello"\nand then\tleft',
		body: "line one\nline two",
		receivedAt: "2026-07-17T00:00:00.000Z",
	};
	const expected = `in-${createHash("sha256").update(ev.sourceRef).digest("hex").slice(0, 8)}`;
	ok(drafter.idFor(ev) === expected, "card id = in-<8-char sha256(source_ref)> (deterministic)");
	ok(drafter.idFor({ ...ev }) === drafter.idFor(ev), "idFor stable across calls");

	const r1 = drafter.draft(ev);
	ok(r1.created && fs.existsSync(r1.file), "first draft creates the card file");
	const r2 = drafter.draft(ev);
	ok(!r2.created && r2.id === r1.id, "redraft is idempotent (created=false, same id)");
	ok(logged.includes("INTAKE_DUPLICATE"), "duplicate redraft logged");

	const text = fs.readFileSync(r1.file, "utf8");
	const titleLine = text.match(/^title: (.*)$/m)?.[1] ?? "";
	ok(
		titleLine.startsWith('"') && JSON.parse(titleLine) === 'He said "hello" and then left',
		"title scalar quoted, quotes escaped, newlines collapsed to one line",
	);
	const fm = parseFrontmatter(text);
	const verdict = validateFile(schemaPath, fm);
	ok(verdict.valid, `drafted card frontmatter schema-valid${verdict.errors.length ? ` (${verdict.errors.join("; ")})` : ""}`);
	ok(fm.status === "Draft", "card lands at Draft");
}

// ──────────────────────────────────────────────── discord: fake REST layer
interface FakeDiscordMsg {
	id: string;
	content: string;
	timestamp: string;
	author: { username: string; bot?: boolean };
}

interface DiscordFake {
	fetchFn: typeof fetch;
	inject(channelId: string, content: string, opts?: { bot?: boolean; username?: string }): string;
	authHeaders: Array<string | undefined>;
	/** Every request the connector made: when, and whether it got the 429. */
	requestLog: Array<{ at: number; served429: boolean }>;
	failNext?: { status: number; retryAfter?: string };
	/** Serve the last injected message once more (ignoring `after`) - an
	 *  at-least-once transport redelivery. */
	redeliverOnce: boolean;
}

function makeDiscordFake(): DiscordFake {
	const channels = new Map<string, FakeDiscordMsg[]>();
	let nextId = 1000n;
	let lastInjected: FakeDiscordMsg | undefined;
	let lastChannel = "";
	const fake: DiscordFake = {
		authHeaders: [],
		requestLog: [],
		failNext: undefined,
		redeliverOnce: false,
		inject(channelId, content, opts = {}) {
			nextId += 1n;
			const msg: FakeDiscordMsg = {
				id: String(nextId),
				content,
				timestamp: new Date().toISOString(),
				author: { username: opts.username ?? "operator", ...(opts.bot ? { bot: true } : {}) },
			};
			const list = channels.get(channelId) ?? [];
			list.push(msg);
			channels.set(channelId, list);
			lastInjected = msg;
			lastChannel = channelId;
			return msg.id;
		},
		fetchFn: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			fake.authHeaders.push((init?.headers as Record<string, string> | undefined)?.["Authorization"]);
			if (fake.failNext) {
				const f = fake.failNext;
				fake.failNext = undefined;
				fake.requestLog.push({ at: Date.now(), served429: f.status === 429 });
				const headers = new Headers();
				if (f.retryAfter !== undefined) headers.set("retry-after", f.retryAfter);
				return new Response("{}", { status: f.status, headers });
			}
			fake.requestLog.push({ at: Date.now(), served429: false });
			const m = url.match(/\/channels\/([^/]+)\/messages\?limit=50(?:&after=(\d+))?$/);
			if (!m) return new Response("not found", { status: 404 });
			const channelId = m[1];
			const after = m[2];
			let list = (channels.get(channelId) ?? []).filter((msg) => after === undefined || BigInt(msg.id) > BigInt(after));
			if (fake.redeliverOnce && lastInjected !== undefined && lastChannel === channelId) {
				fake.redeliverOnce = false;
				if (!list.includes(lastInjected)) list = [...list, lastInjected];
			}
			const newestFirst = [...list].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1)).slice(0, 50);
			return Response.json(newestFirst);
		}) as typeof fetch,
	};
	return fake;
}

console.log("── discord connector (fake REST)");
{
	const fake = makeDiscordFake();
	const logs: string[] = [];
	// History BEFORE start - the first poll must seed the cursor, not deliver.
	fake.inject("chan-1", "old history 1");
	fake.inject("chan-1", "old history 2");

	const received: SourceEvent[] = [];
	const connector = new DiscordConnector({
		botToken: "test-token",
		channelIds: ["chan-1"],
		pollMs: 40,
		apiBase: "https://discord.holdco.test/api/v10",
		fetchFn: fake.fetchFn,
		log: (event) => logs.push(event),
	});
	const stop = await connector.start((ev) => received.push(ev));
	await sleep(150);
	ok(received.length === 0, "first poll seeds cursor WITHOUT delivering channel history");
	ok(logs.includes("DISCORD_CURSOR_SEEDED"), "cursor seed logged");
	ok(fake.authHeaders.length > 0 && fake.authHeaders.every((h) => h === "Bot test-token"), "sends Authorization: Bot <token>");

	const id1 = fake.inject("chan-1", "first line of message\nsecond line", { username: "alice" });
	const ev1 = await waitFor(() => received.find((e) => e.sourceRef === `discord://chan-1/${id1}`), 2000);
	ok(ev1 !== undefined, "new message after seed is delivered");
	ok(ev1?.sourceType === "discord-message", "sourceType = discord-message");
	ok(ev1?.title === "first line of message", "title = first line of content");
	ok(ev1?.surfacedBy === "alice", "surfacedBy = author.username");
	ok(ev1?.body === "first line of message\nsecond line", "body = full content");

	const id2 = fake.inject("chan-1", "y".repeat(120));
	const ev2 = await waitFor(() => received.find((e) => e.sourceRef === `discord://chan-1/${id2}`), 2000);
	ok(ev2 !== undefined && ev2.title.length === 80 && ev2.title.endsWith("…"), "long first line clipped to ~80 chars");

	const idBot = fake.inject("chan-1", "beep boop from a bot", { bot: true, username: "robo" });
	const id3 = fake.inject("chan-1", "human message after the bot");
	const ev3 = await waitFor(() => received.find((e) => e.sourceRef === `discord://chan-1/${id3}`), 2000);
	ok(ev3 !== undefined, "human message around a bot message still delivered");
	ok(!received.some((e) => e.sourceRef === `discord://chan-1/${idBot}`), "bot-authored message skipped");

	// 500: log + recover on a later poll, never throw.
	fake.failNext = { status: 500 };
	const id4 = fake.inject("chan-1", "survives a 500");
	const ev4 = await waitFor(() => received.find((e) => e.sourceRef === `discord://chan-1/${id4}`), 2000);
	ok(ev4 !== undefined, "500 response: no throw, delivered on next poll");
	ok(logs.includes("DISCORD_HTTP_ERROR"), "500 logged as DISCORD_HTTP_ERROR");

	// 429: honour Retry-After by skipping polls until the window elapses.
	// Asserted via the fake's request log (gap between the 429 and the next
	// request) rather than a wall-clock sleep - load-independent.
	fake.failNext = { status: 429, retryAfter: "0.4" };
	const id5 = fake.inject("chan-1", "after the rate limit");
	const ev5 = await waitFor(() => received.find((e) => e.sourceRef === `discord://chan-1/${id5}`), 3000);
	ok(ev5 !== undefined, "delivery resumes after Retry-After elapses");
	ok(logs.includes("DISCORD_RATE_LIMITED"), "429 logged as DISCORD_RATE_LIMITED");
	const i429 = fake.requestLog.findIndex((r) => r.served429);
	const after429 = i429 >= 0 ? fake.requestLog.slice(i429 + 1).find(() => true) : undefined;
	ok(
		i429 >= 0 && after429 !== undefined && after429.at - fake.requestLog[i429].at >= 380,
		`polls skipped during Retry-After window (next request ${after429 ? after429.at - fake.requestLog[i429].at : "?"}ms after the 429)`,
	);

	// Cursor advance: many polls later, nothing was delivered twice.
	await sleep(200);
	const refs = received.map((e) => e.sourceRef);
	ok(new Set(refs).size === refs.length, "cursor advance: no message ever delivered twice");

	await stop();
	const countAtStop = received.length;
	fake.inject("chan-1", "posted after stop");
	await sleep(150);
	ok(received.length === countAtStop, "no delivery after stop()");
	await stop();
	ok(true, "stop() idempotent (second call did not throw)");
}

console.log("── discord conformance");
{
	const fake = makeDiscordFake();
	const cardsDir = fs.mkdtempSync(join(root, "discord-cards-"));
	const connector = new DiscordConnector({
		botToken: "test-token",
		channelIds: ["conf-chan"],
		pollMs: 50,
		apiBase: "https://discord.holdco.test/api/v10",
		fetchFn: fake.fetchFn,
	});
	const checks = await runConnectorConformance({
		connector,
		injectItem: async (n) => `discord://conf-chan/${fake.inject("conf-chan", `conformance item ${n}`, { username: "conf-user" })}`,
		redeliverLast: async () => {
			fake.redeliverOnce = true;
		},
		cardsDir,
		cardSchemaPath: schemaPath,
		deliveryTimeoutMs: 3000,
	});
	for (const c of checks) ok(c.ok, `[discord] ${c.id}${c.detail ? ` - ${c.detail}` : ""}`);
}

// ─────────────────────────────────────────────── imap: fake IMAP4rev1 server
interface FakeMail {
	headers: string;
	text: string;
	seen: boolean;
}

class FakeImapServer {
	mails: FakeMail[] = [];
	storeCalls: string[] = [];
	logins = 0;
	/** Destroy the socket on the next SEARCH (connection drop mid-poll). */
	dropNextSearch = false;
	private server: net.Server;
	private sockets = new Set<net.Socket>();

	constructor() {
		this.server = net.createServer((s) => this.session(s));
	}

	listen(): Promise<number> {
		return new Promise((resolve) =>
			this.server.listen(0, "127.0.0.1", () => resolve((this.server.address() as net.AddressInfo).port)),
		);
	}

	close(): Promise<void> {
		for (const s of this.sockets) s.destroy();
		return new Promise((resolve) => this.server.close(() => resolve()));
	}

	addMail(headers: string, text: string): void {
		this.mails.push({ headers, text, seen: false });
	}

	private session(sock: net.Socket): void {
		this.sockets.add(sock);
		sock.on("close", () => this.sockets.delete(sock));
		sock.on("error", () => {});
		sock.write("* OK holdco-fake IMAP4rev1 ready\r\n");
		let buf = "";
		sock.on("data", (d) => {
			buf += d.toString("utf8");
			let idx: number;
			while ((idx = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				this.handle(sock, line);
			}
		});
	}

	private handle(sock: net.Socket, line: string): void {
		const m = line.match(/^(\S+)\s+(\w+)(?:\s+(.*))?$/);
		if (!m) return;
		const tag = m[1];
		const rest = m[3] ?? "";
		switch (m[2].toUpperCase()) {
			case "LOGIN":
				this.logins++;
				sock.write(`${tag} OK LOGIN completed\r\n`);
				break;
			case "SELECT":
				sock.write(`* ${this.mails.length} EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
				break;
			case "SEARCH": {
				if (this.dropNextSearch) {
					this.dropNextSearch = false;
					sock.destroy();
					return;
				}
				const ids = this.mails.map((mail, i) => (mail.seen ? 0 : i + 1)).filter((n) => n > 0);
				sock.write(`* SEARCH${ids.length ? ` ${ids.join(" ")}` : ""}\r\n${tag} OK SEARCH completed\r\n`);
				break;
			}
			case "FETCH": {
				const id = Number(rest.split(" ")[0]);
				const mail = this.mails[id - 1];
				if (!mail) {
					sock.write(`${tag} NO no such message\r\n`);
					return;
				}
				const h = `${mail.headers.replace(/\n/g, "\r\n")}\r\n\r\n`;
				const t = mail.text.replace(/\n/g, "\r\n");
				sock.write(`* ${id} FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${Buffer.byteLength(h)}}\r\n`);
				sock.write(h);
				sock.write(` BODY[TEXT] {${Buffer.byteLength(t)}}\r\n`);
				sock.write(t);
				sock.write(`)\r\n${tag} OK FETCH completed\r\n`);
				break;
			}
			case "STORE": {
				const id = Number(rest.split(" ")[0]);
				const mail = this.mails[id - 1];
				if (mail && /\\Seen/i.test(rest)) {
					mail.seen = true;
					this.storeCalls.push(String(id));
				}
				sock.write(`${tag} OK STORE completed\r\n`);
				break;
			}
			case "LOGOUT":
				sock.write(`* BYE holdco-fake signing off\r\n${tag} OK LOGOUT completed\r\n`);
				sock.end();
				break;
			default:
				sock.write(`${tag} OK ${m[2]} ignored\r\n`);
		}
	}
}

console.log("── imap connector (fake server)");
{
	const fake = new FakeImapServer();
	const port = await fake.listen();
	const logs: string[] = [];
	const received: SourceEvent[] = [];
	const connector = new ImapConnector({
		host: "127.0.0.1",
		port,
		user: "operator@holdco.test",
		password: "secret",
		insecurePlaintext: true,
		pollMs: 40,
		log: (event) => logs.push(event),
	});
	const stop = await connector.start((ev) => received.push(ev));

	fake.addMail(
		[
			"From: Alice <operator@holdco.test>",
			"Subject: Hello holdco",
			"Date: Thu, 16 Jul 2026 10:00:00 +0000",
			"Message-ID: <plain-1@holdco.test>",
		].join("\n"),
		"Plain body line 1\nline 2",
	);
	const e1 = await waitFor(() => received.find((e) => e.sourceRef === "<plain-1@holdco.test>"), 3000);
	ok(e1 !== undefined, "unseen mail delivered");
	ok(e1?.sourceType === "email", "sourceType = email");
	ok(e1?.sourceRef === "<plain-1@holdco.test>", "sourceRef = real Message-ID");
	ok(e1?.title === "Hello holdco", "title = Subject");
	ok(e1?.surfacedBy === "Alice <operator@holdco.test>", "surfacedBy = From");
	ok(e1?.body === "Plain body line 1\nline 2", "body = text part with \\r stripped");
	ok(e1?.receivedAt === new Date("Thu, 16 Jul 2026 10:00:00 +0000").toISOString(), "receivedAt from Date header");
	const seen1 = await waitFor(() => (fake.mails[0].seen ? true : undefined), 2000);
	ok(seen1 === true && fake.storeCalls.includes("1"), "STORE +FLAGS (\\Seen) issued AFTER delivery");

	// Folded header, invalid Date, quoted-printable, no Message-ID.
	fake.addMail(
		["From: Bob <bob@holdco.test>", "Subject: This subject is", " folded across lines", "Date: not-a-real-date"].join("\n"),
		"QP=20decoded=3D yes=\ncontinued",
	);
	const e2 = await waitFor(() => received.find((e) => e.surfacedBy.startsWith("Bob")), 3000);
	ok(e2 !== undefined, "second mail delivered");
	ok(e2?.title === "This subject is folded across lines", "folded header unfolded");
	ok(e2?.sourceRef.startsWith("imap:127.0.0.1/INBOX/") === true, "missing Message-ID → synthesized imap:<host>/<mailbox>/<hash>");
	ok(e2?.body === "QP decoded= yescontinued", "trivial quoted-printable (=XX + soft break) decoded");
	ok(e2 !== undefined && !Number.isNaN(new Date(e2.receivedAt).getTime()), "unparseable Date header → receivedAt is still valid ISO");

	fake.addMail(
		["From: carol@holdco.test", "Date: Thu, 16 Jul 2026 11:00:00 +0000", "Message-ID: <nosubj@holdco.test>"].join("\n"),
		"body with no subject",
	);
	const e3 = await waitFor(() => received.find((e) => e.sourceRef === "<nosubj@holdco.test>"), 3000);
	ok(e3?.title === "(no subject)", "missing Subject → \"(no subject)\"");

	// Connection drop mid-poll: reconnect with backoff, no throw.
	const loginsBefore = fake.logins;
	fake.dropNextSearch = true;
	fake.addMail(
		[
			"From: dave@holdco.test",
			"Subject: After the drop",
			"Date: Thu, 16 Jul 2026 12:00:00 +0000",
			"Message-ID: <after-drop@holdco.test>",
		].join("\n"),
		"survived the reconnect",
	);
	const e4 = await waitFor(() => received.find((e) => e.sourceRef === "<after-drop@holdco.test>"), 4000);
	ok(e4 !== undefined, "connection drop mid-poll: reconnect + deliver, no throw");
	ok(fake.logins > loginsBefore, "reconnect performed a fresh LOGIN");
	ok(logs.includes("IMAP_POLL_ERROR"), "drop logged as IMAP_POLL_ERROR");

	await stop();
	await stop();
	ok(true, "stop() idempotent (second call did not throw)");
	const countAtStop = received.length;
	fake.addMail(
		["From: eve@holdco.test", "Subject: Too late", "Message-ID: <post-stop@holdco.test>"].join("\n"),
		"should never deliver",
	);
	await sleep(200);
	ok(received.length === countAtStop, "no delivery after stop()");
	await fake.close();
}

console.log("── imap conformance");
{
	const fake = new FakeImapServer();
	const port = await fake.listen();
	const cardsDir = fs.mkdtempSync(join(root, "imap-cards-"));
	const connector = new ImapConnector({
		host: "127.0.0.1",
		port,
		user: "operator@holdco.test",
		password: "secret",
		insecurePlaintext: true,
		pollMs: 50,
	});
	let last = -1;
	const checks = await runConnectorConformance({
		connector,
		injectItem: async (n) => {
			const ref = `<conformance-${n}@holdco.test>`;
			fake.addMail(
				[
					"From: operator@holdco.test",
					`Subject: Conformance item ${n}`,
					`Date: Thu, 16 Jul 2026 12:0${n}:00 +0000`,
					`Message-ID: ${ref}`,
				].join("\n"),
				`conformance body ${n}`,
			);
			last = fake.mails.length - 1;
			return ref;
		},
		redeliverLast: async () => {
			if (last >= 0) fake.mails[last].seen = false; // \Seen cleared → server redelivers
		},
		cardsDir,
		cardSchemaPath: schemaPath,
		deliveryTimeoutMs: 4000,
	});
	for (const c of checks) ok(c.ok, `[imap] ${c.id}${c.detail ? ` - ${c.detail}` : ""}`);
	await fake.close();
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\nPass: ${pass}  Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✅ ALL TESTS PASSED");

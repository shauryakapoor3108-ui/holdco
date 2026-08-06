// live-m7-fake-sources.mjs - local stand-ins for Discord's REST API and an IMAP
// mailbox, used by live-m7-intake.sh. The daemon's connector CLIENTS are the
// real shipped code speaking real HTTP / real IMAP over real sockets; only the
// remote SERVICES are simulated locally (a build session carries no external
// credentials). Ports are passed as argv; new items are injected by dropping
// JSON files into the control dir (argv[3]).
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { join } from "node:path";

const [discordPort, imapPort, controlDir] = process.argv.slice(2);
fs.mkdirSync(controlDir, { recursive: true });

// ── fake Discord REST: GET /api/v10/channels/:id/messages ────────────────────
const channelMessages = new Map(); // channelId → [{id, content, author, timestamp}]
let snowflake = 1000n;
function drainDiscordControl() {
	for (const f of fs.readdirSync(controlDir).filter((f) => f.startsWith("discord-") && f.endsWith(".json"))) {
		const p = join(controlDir, f);
		const { channel, content, author } = JSON.parse(fs.readFileSync(p, "utf8"));
		fs.rmSync(p);
		const list = channelMessages.get(channel) ?? [];
		list.push({
			id: String(++snowflake),
			content,
			author: { username: author ?? "operator", bot: false },
			timestamp: new Date().toISOString(),
		});
		channelMessages.set(channel, list);
	}
}
const discord = http.createServer((req, res) => {
	drainDiscordControl();
	const m = req.url?.match(/^\/api\/v10\/channels\/([^/]+)\/messages(\?|$)/);
	if (!m || !req.headers.authorization?.startsWith("Bot ")) {
		res.writeHead(m ? 401 : 404).end("{}");
		return;
	}
	const after = new URL(req.url, "http://x").searchParams.get("after");
	let list = channelMessages.get(m[1]) ?? [];
	if (after) list = list.filter((msg) => BigInt(msg.id) > BigInt(after));
	// Discord returns newest-first
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([...list].reverse()));
});
discord.listen(Number(discordPort), "127.0.0.1");

// ── fake IMAP: greeting/LOGIN/SELECT/SEARCH UNSEEN/FETCH/STORE ────────────────
const mailbox = []; // {id, from, subject, messageId, date, text, seen}
let nextUid = 1;
function drainImapControl() {
	for (const f of fs.readdirSync(controlDir).filter((f) => f.startsWith("mail-") && f.endsWith(".json"))) {
		const p = join(controlDir, f);
		const { from, subject, text, messageId } = JSON.parse(fs.readFileSync(p, "utf8"));
		fs.rmSync(p);
		mailbox.push({ id: nextUid++, from, subject, messageId, date: new Date().toUTCString(), text, seen: false });
	}
}
const imap = net.createServer((sock) => {
	sock.write("* OK holdco fake IMAP ready\r\n");
	let buf = "";
	sock.on("data", (d) => {
		buf += d.toString();
		let i;
		while ((i = buf.indexOf("\r\n")) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 2);
			const [tag, cmd, ...rest] = line.split(" ");
			const c = (cmd ?? "").toUpperCase();
			if (c === "LOGIN") sock.write(`${tag} OK LOGIN completed\r\n`);
			else if (c === "SELECT") sock.write(`* 0 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
			else if (c === "SEARCH" || (c === "UID" && rest[0]?.toUpperCase() === "SEARCH")) {
				drainImapControl();
				const unseen = mailbox.filter((msg) => !msg.seen).map((msg) => msg.id);
				sock.write(`* SEARCH${unseen.length ? " " + unseen.join(" ") : ""}\r\n${tag} OK SEARCH completed\r\n`);
			} else if (c === "FETCH") {
				const id = Number(rest[0]);
				const msg = mailbox.find((m) => m.id === id);
				if (!msg) {
					sock.write(`${tag} NO no such message\r\n`);
				} else {
					const header = `From: ${msg.from}\r\nSubject: ${msg.subject}\r\nDate: ${msg.date}\r\nMessage-ID: ${msg.messageId}\r\n\r\n`;
					const text = msg.text.replace(/\n/g, "\r\n");
					sock.write(
						`* ${id} FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] {${Buffer.byteLength(header)}}\r\n${header} BODY[TEXT] {${Buffer.byteLength(text)}}\r\n${text})\r\n${tag} OK FETCH completed\r\n`,
					);
				}
			} else if (c === "STORE") {
				const id = Number(rest[0]);
				const msg = mailbox.find((m) => m.id === id);
				if (msg) msg.seen = true;
				sock.write(`* ${id} FETCH (FLAGS (\\Seen))\r\n${tag} OK STORE completed\r\n`);
			} else if (c === "LOGOUT") {
				sock.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
				sock.end();
			} else sock.write(`${tag} OK ${c} noop\r\n`);
		}
	});
});
imap.listen(Number(imapPort), "127.0.0.1");

console.log("fake sources up");

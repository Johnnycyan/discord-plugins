#!/usr/bin/env node
// CustomFavorites sync server: stores one favorites document and hands it to every client that has the token.
// No dependencies. Configure with environment variables:
//   SYNC_TOKEN  required, the shared secret clients send as "Authorization: Bearer <token>"
//   PORT        default 8787
//   HOST        default 127.0.0.1 (put a TLS reverse proxy such as Caddy in front)
//   DATA_FILE   default ./favorites.json
import { timingSafeEqual } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const TOKEN = process.env.SYNC_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_FILE = process.env.DATA_FILE ?? "./favorites.json";
/** Longest a long-poll request is held open; below common proxy timeouts */
const MAX_WAIT_MS = 25_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

if (TOKEN.length < 16) {
    console.error("Set SYNC_TOKEN to a random secret of at least 16 characters, e.g. `openssl rand -hex 32`.");
    process.exit(1);
}

/** @type {{ revision: number; updatedAt: string | null; data: object | null; }} */
let doc = { revision: 0, updatedAt: null, data: null };
try {
    doc = JSON.parse(await readFile(DATA_FILE, "utf8"));
} catch (e) {
    if (e.code !== "ENOENT") throw e;
}

/** Long-poll requests waiting for the next revision */
const waiters = new Set();

async function save() {
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, DATA_FILE);
}

function authorized(req) {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    const expected = Buffer.from(TOKEN);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body) {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
}

function isValidData(data) {
    return data != null && typeof data === "object"
        && data.state != null && typeof data.state === "object"
        && data.state.favoriteChannels != null && typeof data.state.favoriteChannels === "object";
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");

    // Discord web and desktop run on discord.com, so browsers need CORS; the token is the protection
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, PUT, OPTIONS");
    if (req.method === "OPTIONS") return send(res, 204);

    if (url.pathname === "/v1/health") return send(res, 200, { ok: true });
    if (url.pathname !== "/v1/favorites") return send(res, 404, { error: "not found" });
    if (!authorized(req)) return send(res, 401, { error: "bad token" });

    if (req.method === "GET") {
        const since = Number(url.searchParams.get("since"));
        // Hold the request until something newer than `since` exists
        if (url.searchParams.has("wait") && since === doc.revision) {
            const changed = await new Promise(resolve => {
                const waiter = {
                    resolve(value) {
                        clearTimeout(timer);
                        waiters.delete(waiter);
                        resolve(value);
                    }
                };
                const timer = setTimeout(() => waiter.resolve(false), MAX_WAIT_MS);
                waiters.add(waiter);
                // Client gave up (res closes before we answer)
                res.on("close", () => waiter.resolve(false));
            });
            if (!changed) return send(res, 204);
        }
        return send(res, 200, doc);
    }

    if (req.method === "PUT") {
        let body;
        try {
            body = await readBody(req);
        } catch (e) {
            return send(res, e.status ?? 400, { error: e.status ? "body too large" : "invalid JSON" });
        }
        if (!Number.isInteger(body?.baseRevision) || !isValidData(body.data)) {
            return send(res, 400, { error: "expected { baseRevision, data: { state: { favoriteChannels } } }" });
        }
        // Someone else wrote since this client last synced: hand back the current document to merge with
        if (body.baseRevision !== doc.revision) return send(res, 409, doc);

        doc = { revision: doc.revision + 1, updatedAt: new Date().toISOString(), data: body.data };
        await save();
        [...waiters].forEach(waiter => waiter.resolve(true));
        return send(res, 200, { revision: doc.revision, updatedAt: doc.updatedAt });
    }

    return send(res, 405, { error: "method not allowed" });
}

createServer((req, res) => {
    handle(req, res).catch(e => {
        console.error(e);
        if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
}).listen(PORT, HOST, () => console.log(`CustomFavorites sync server on http://${HOST}:${PORT} (revision ${doc.revision})`));

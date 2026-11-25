// @description Spike: logs how Phoenix loads and saves Favorites, to plan the CustomFavorites port
// @version 0.6.0
// @author Johnnycyan

// Changes nothing in the app: it only observes. Open the report with /cfspike or from the plugin's settings.

// ---------- Report ----------

const MAX_ENTRIES = 1000;
const MAX_ENTRY_CHARS = 40000;

type Entry = { at: string; tag: string; text: string; };

/** Bump with @version: a new version starts a fresh report */
const VERSION = "0.6.0";

const report: Entry[] = phoenix.storage.get("reportVersion") === VERSION ? phoenix.storage.get<Entry[]>("report") ?? [] : [];
phoenix.storage.set("reportVersion", VERSION);

function note(tag: string, value: unknown) {
    let text: string;
    try {
        text = typeof value === "string" ? value : JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
    } catch (e) {
        text = `<unserializable: ${e}>`;
    }
    if (text.length > MAX_ENTRY_CHARS) text = `${text.slice(0, MAX_ENTRY_CHARS)}\n... (${text.length} chars)`;

    report.push({ at: new Date().toISOString(), tag, text });
    if (report.length > MAX_ENTRIES) report.splice(0, report.length - MAX_ENTRIES);
    phoenix.storage.set("report", report);
    phoenix.log.info(`[${tag}] ${text.slice(0, 500)}`);
}

function guard(tag: string, fn: () => void) {
    try {
        fn();
    } catch (e) {
        note(`${tag}:error`, `${(e as Error)?.message ?? e}\n${(e as Error)?.stack ?? ""}`);
    }
}

function reportText() {
    return report.map(e => `### ${e.at} ${e.tag}\n${e.text}`).join("\n\n");
}

function openReport() {
    const text = reportText() || "(empty)";
    phoenix.ui.openPage({
        title: "CustomFavorites spike",
        sections: [
            {
                type: "buttons",
                buttons: [
                    {
                        label: "Copy report",
                        icon: "res://ic_mana_angle_brackets",
                        onPress() {
                            phoenix.ui.copy(text);
                            phoenix.ui.toast(`Copied ${report.length} entries`);
                        },
                    },
                    {
                        label: "Send report to PC",
                        onPress: () => void sendReport(),
                    },
                    {
                        label: "Dump view tree now",
                        onPress: () => guard("tree", dumpTree),
                    },
                ],
            },
            { type: "code", title: `${report.length} entries`, text, monospace: true, highlight: false },
        ],
    });
}

// ---------- Minimal protobuf reading (no helpers in the runtime) ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function fromBase64(text: string): Uint8Array {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bits = 0, value = 0, n = 0;
    for (const ch of clean) {
        value = (value << 6) | B64.indexOf(ch);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (value >> bits) & 0xff;
        }
    }
    return out.subarray(0, n);
}

function utf8(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length;) {
        const b = bytes[i++];
        let cp: number;
        if (b < 0x80) cp = b;
        else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
        else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        out += String.fromCodePoint(cp);
    }
    return out;
}

type Field =
    | { field: number; wire: 0; value: bigint; }
    | { field: number; wire: 1; value: bigint; }
    | { field: number; wire: 2; value: Uint8Array; }
    | { field: number; wire: 5; value: number; };

function parseFields(bytes: Uint8Array): Field[] {
    const fields: Field[] = [];
    let pos = 0;

    const varint = () => {
        let result = 0n, shift = 0n;
        while (true) {
            if (pos >= bytes.length) throw new Error("truncated varint");
            const b = bytes[pos++];
            result |= BigInt(b & 0x7f) << shift;
            if (!(b & 0x80)) return result;
            shift += 7n;
        }
    };

    while (pos < bytes.length) {
        const key = Number(varint());
        const field = key >>> 3, wire = key & 7;
        if (wire === 0) {
            fields.push({ field, wire, value: varint() });
        } else if (wire === 1) {
            let v = 0n;
            for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[pos + i]);
            pos += 8;
            fields.push({ field, wire, value: v });
        } else if (wire === 2) {
            const len = Number(varint());
            if (pos + len > bytes.length) throw new Error(`field ${field}: length ${len} past end`);
            fields.push({ field, wire, value: bytes.subarray(pos, pos + len) });
            pos += len;
        } else if (wire === 5) {
            fields.push({ field, wire, value: (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0 });
            pos += 4;
        } else {
            throw new Error(`field ${field}: unsupported wire type ${wire} at ${pos}`);
        }
    }
    return fields;
}

const summarize = (fields: Field[]) => fields.map(f => f.wire === 2 ? `${f.field}:len(${f.value.length})` : `${f.field}:${f.value}`);

/** Expected field number of `favorites` in PreloadedUserSettings (settings-proto type 1). Verified by this spike. */
const FAVORITES_FIELD = 15;

/** Decodes Favorites { map<fixed64, FavoriteChannel> favorite_channels = 1; bool muted = 2; ... } */
function decodeFavorites(bytes: Uint8Array) {
    const channels: Record<string, unknown> = {};
    const other: string[] = [];
    for (const f of parseFields(bytes)) {
        if (f.field === 1 && f.wire === 2) {
            let id = "?";
            let entry: Record<string, unknown> = {};
            for (const kv of parseFields(f.value)) {
                if (kv.field === 1 && kv.wire === 1) id = kv.value.toString();
                else if (kv.field === 2 && kv.wire === 2) {
                    for (const c of parseFields(kv.value)) {
                        if (c.field === 1 && c.wire === 2) entry.nickname = utf8(c.value);
                        else if (c.field === 2 && c.wire === 0) entry.type = Number(c.value);
                        else if (c.field === 3 && c.wire === 0) entry.position = Number(c.value);
                        else if (c.field === 4 && c.wire === 1) entry.parentId = c.value.toString();
                        else entry[`f${c.field}`] = c.wire === 2 ? summarize(parseFields(c.value)).join(",") : c.value.toString();
                    }
                }
            }
            channels[id] = entry;
        } else {
            other.push(...summarize([f]));
        }
    }
    return { count: Object.keys(channels).length, channels, otherFields: other };
}

function fromHex(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

/** Logs the top-level fields of a settings proto (base64 or raw bytes) and its favorites, if any */
function inspectSettingsProto(tag: string, data: string | Uint8Array) {
    guard(tag, () => {
        const bytes = typeof data === "string" ? fromBase64(data) : data;
        const fields = parseFields(bytes);
        const fav = fields.find((f): f is Extract<Field, { wire: 2; }> => f.field === FAVORITES_FIELD && f.wire === 2);
        if (!fav) {
            note(tag, { bytes: bytes.length, topLevel: summarize(fields), favorites: "none" });
            return;
        }
        const decoded = decodeFavorites(fav.value);
        note(tag, {
            bytes: bytes.length,
            favoritesBytes: fav.value.length,
            count: decoded.count,
            otherFields: decoded.otherFields,
            changes: diffFavorites(decoded.channels as Record<string, Record<string, unknown>>),
        });
    });
}

/**
 * Compares favorites with the last ones seen from any source, so the report shows which source
 * carried each change. The first time, it logs a few entries as a sample.
 */
function diffFavorites(next: Record<string, Record<string, unknown>>) {
    const prev = phoenix.storage.get<Record<string, Record<string, unknown>>>("lastFavorites");
    phoenix.storage.set("lastFavorites", next);
    if (!prev) return { first: true, sample: Object.fromEntries(Object.entries(next).slice(0, 4)) };

    const changes: Record<string, unknown> = {};
    for (const id of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        const a = JSON.stringify(prev[id] ?? null), b = JSON.stringify(next[id] ?? null);
        if (a !== b) changes[id] = { before: prev[id] ?? null, after: next[id] ?? null };
    }
    return Object.keys(changes).length ? changes : "unchanged";
}

/** Finds base64 settings protos anywhere in a JSON value (REST bodies and gateway payloads) */
function findProtos(value: unknown, path = "$", out: [string, string][] = [], depth = 0): [string, string][] {
    if (depth > 6 || value == null) return out;
    if (typeof value === "string") {
        if (value.length >= 8 && /^[A-Za-z0-9+/]+=*$/.test(value) && /(settings|proto)/i.test(path)) out.push([path, value]);
    } else if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) findProtos(v, `${path}.${k}`, out, depth + 1);
    }
    return out;
}

// ---------- 1. Gateway: which events exist, and what READY / settings updates carry ----------

guard("gateway", () => {
    const gw = phoenix.gateway as Record<string, unknown>;
    const names = new Set<string>(Object.keys(gw));
    for (const k in gw) names.add(k);
    const all = [...names].sort();
    note("gateway:events", { count: all.length, watched: all.filter(n => /setting|favorite|proto/i.test(n)) });

    phoenix.on(phoenix.gateway.ready, payload => guard("ready", () => {
        const p = payload as unknown as Record<string, unknown>;
        note("ready:keys", Object.keys(p));
        for (const [path, b64] of findProtos(p)) inspectSettingsProto(`ready:proto ${path}`, b64);
    }));

    for (const name of all.filter(n => /setting|favorite|proto/i.test(n))) {
        const s = gw[name] as Phoenix.Sig<unknown> | undefined;
        if (!s) continue;
        phoenix.on(s, payload => guard(`gw:${name}`, () => {
            note(`gw:${name}`, payload);
            for (const [path, b64] of findProtos(payload)) inspectSettingsProto(`gw:${name} proto ${path}`, b64);
        }));
    }
});

// ---------- 2. REST: settings-proto reads and writes ----------

guard("rest", () => {
    phoenix.discord.onRequest({ pathIncludes: "settings" }, req => {
        guard("req", () => {
            note(`req ${req.method} ${req.path}`, `body ${req.body.length} chars`);
            for (const [path, b64] of findProtos(req.json())) inspectSettingsProto(`req ${req.method} ${req.path} ${path}`, b64);
        });
    });

    phoenix.discord.onResponse({ pathIncludes: "settings" }, res => {
        guard("res", () => {
            note(`res ${res.status} ${res.method} ${res.path}`, `body ${res.body.length} chars`);
            for (const [path, b64] of findProtos(res.json())) inspectSettingsProto(`res ${res.method} ${res.path} ${path}`, b64);
        });
    });
});

// ---------- 3. Cache database: does Phoenix keep settings or favorites locally? ----------

// Blobs come back as arrays of numbers, so read them as hex. Tables of other people's data (users,
// members, messages) are left alone: only key names and sizes of the small key-value tables are logged.
async function dumpCache() {
    const protos = await phoenix.stores.sql<{ k: string; v: string; }>("SELECT k, hex(v) AS v FROM user_settings_proto");
    for (const row of protos) {
        // Only the preloaded settings hold favorites; for the others, the first bytes show the format
        if (row.k === "settings.preloaded") inspectSettingsProto(`sql:${row.k}`, fromHex(row.v));
        else note(`sql:${row.k}`, { bytes: row.v.length / 2, head: row.v.slice(0, 96) });
    }

    for (const table of ["prefs", "meta"]) {
        try {
            const rows = await phoenix.stores.sql<{ k: string; n: number; }>(`SELECT k, length(v) AS n FROM ${table}`);
            note(`sql:${table} keys`, rows.map(r => `${r.k} (${r.n} bytes)`));
        } catch (e) {
            const [schema] = await phoenix.stores.sql<{ sql: string; }>("SELECT sql FROM sqlite_master WHERE name = ?", table);
            note(`sql:${table}:error`, `${e}\n${schema?.sql}`);
        }
    }
}

// ---------- 4. View tree: accessibility ids, to find the Favorites screen and channel rows ----------

function treeLines(root: number, all = false) {
    const lines: string[] = [];
    let visited = 0;
    const walk = (id: number, depth: number) => {
        if (visited++ > 6000 || depth > 80) return;
        const n = phoenix.ui.node(id);
        if (!n) return;
        if (all || n.accessibilityId || n.list != null) {
            lines.push(`${"  ".repeat(Math.min(depth, 20))}${n.kind ?? "?"} #${id} ${n.accessibilityId ?? ""}${n.on.length ? ` on=[${n.on}]` : ""}`);
        }
        n.children.forEach(c => walk(c, depth + 1));
    };
    walk(root, 0);
    return { visited, lines: lines.join("\n") };
}

function dumpTree() {
    const root = phoenix.ui.root();
    if (root == null) {
        note("tree", "no root yet");
        return;
    }
    note("tree", treeLines(root));
}

// ---------- 5. View events: find the "Add to Favorites" row and what pressing it does ----------

/** Accessibility ids from the node up to the root, nearest first */
function ancestry(id: number) {
    const chain: string[] = [];
    let current: number | null = id;
    for (let i = 0; current != null && i < 15; i++) {
        const n = phoenix.ui.node(current);
        if (!n) break;
        chain.push(`${n.kind ?? "?"}#${current}${n.accessibilityId ? ` ${n.accessibilityId}` : ""}`);
        current = n.parent;
    }
    return chain;
}

const dumpedSheets = new Set<number>();

const EVENTS = ["press", "longPress", "rowLongPress", "rowPress", "rowDoubleTap", "dismiss"];
for (const name of EVENTS) {
    guard(`event:${name}`, () => {
        phoenix.ui.onEvent(name, ev => guard(`ev:${name}`, () => {
            const n = phoenix.ui.node(ev.node);
            note(`ev:${name} ${ev.accessibilityId ?? ""}`, {
                node: ev.node,
                kind: n?.kind,
                payload: ev.payload,
                channelId: ev.channelId,
                messageId: ev.messageId,
                sheet: n?.sheet,
                list: n?.list,
                ancestry: ancestry(ev.node),
            });
            // A press inside a sheet: dump the whole sheet once, with every node, to see its rows
            if (n?.sheet != null && !dumpedSheets.has(n.sheet)) {
                dumpedSheets.add(n.sheet);
                note(`sheet #${n.sheet}`, treeLines(n.sheet, true));
            }
        }));
    });
}

// Every accessibility id Phoenix creates, once each, to learn the names of menu rows
const seenIds = new Set<string>();
guard("nodes", () => {
    phoenix.ui.onNode({ prefix: "" }, n => {
        if (!n.accessibilityId || seenIds.has(n.accessibilityId) || seenIds.size > 3000) return;
        seenIds.add(n.accessibilityId);
        if (/fav|channel|menu|sheet|action|mute|mark|copy|invite|notif/i.test(n.accessibilityId)) {
            note(`node ${n.accessibilityId}`, { id: n.id, kind: n.kind, on: n.on, sheet: n.sheet, parents: ancestry(n.parent ?? n.id).slice(0, 4) });
        }
    });
});

// ---------- 6. Catch "Add to Favorites" and work out which channel the menu is for ----------

const CHANNEL_PREFIX = "navigation.channel:";

/** The list's row containers in child order, with the channel each one holds */
function listRows(list: number) {
    return (phoenix.ui.node(list)?.children ?? []).map((child, i) => {
        const found = phoenix.ui.findDown(child, { prefix: CHANNEL_PREFIX }, 4);
        const id = found != null ? phoenix.ui.node(found)?.accessibilityId ?? null : null;
        return { i, child, channel: id ? id.slice(CHANNEL_PREFIX.length) : null };
    });
}

let lastLongPress: { list: number; index: number; rows: ReturnType<typeof listRows>; } | null = null;

guard("longpress-rows", () => {
    phoenix.ui.onEvent("rowLongPress", ev => guard("longpress-rows", () => {
        const index = (ev.payload as { index?: number; } | null)?.index;
        if (typeof index !== "number") return;
        const rows = listRows(ev.node);
        lastLongPress = { list: ev.node, index, rows };
        note(`rows at long-press index ${index}`, {
            list: ev.node,
            childCount: rows.length,
            childAtIndex: rows[index] ?? null,
            rows: rows.map(r => `${r.i}: #${r.child} ${r.channel ?? "-"}`).join("\n"),
        });
    }));
});

guard("intercept", () => {
    phoenix.ui.onEvent("press", ev => {
        if (ev.accessibilityId !== "Add to Favorites") return false;
        guard("intercept", () => {
            const guess = lastLongPress?.rows[lastLongPress.index]?.channel ?? null;
            note("intercepted Add to Favorites", { guess, lastLongPress: lastLongPress && { list: lastLongPress.list, index: lastLongPress.index } });
            phoenix.ui.toast(`Spike caught Add to Favorites (channel ${guess ?? "unknown"})`);
        });
        // Consumed: Phoenix should not see the press, so no Nitro upsell
        return true;
    }, { intercept: true });
});

function noteSeenIds() {
    note("node ids", [...seenIds].sort().join("\n"));
}

// ---------- Entry points ----------

/** Plugins can't write files, so the report goes to report-receiver.mjs on the PC */
async function sendReport() {
    const url = settings.reportUrl.trim();
    if (!/^https?:\/\//.test(url)) {
        phoenix.ui.toast("Set the Report URL first (run npm run receive on the PC)");
        return;
    }
    noteSeenIds();
    try {
        const res = await phoenix.fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: reportText() });
        phoenix.ui.toast(res.ok ? `Sent ${report.length} entries: ${res.text()}` : `Send failed: HTTP ${res.status}`);
    } catch (e) {
        phoenix.ui.toast(`Send failed: ${(e as Error)?.message ?? e}`);
    }
}

const settings = phoenix.settings.define({
    reportUrl: {
        type: "text",
        title: "Report URL",
        description: "Printed by npm run receive on the PC, like http://192.168.1.10:8787/report",
        default: "",
    },
    send: { type: "button", title: "Send report to PC", onPress: () => void sendReport() },
    open: { type: "button", title: "Open report", onPress: openReport },
    tree: { type: "button", title: "Dump view tree", description: "Open the Favorites screen first", onPress: () => guard("tree", dumpTree) },
    cache: { type: "button", title: "Dump cache tables", onPress: () => void dumpCache().catch(e => note("sql:error", String(e))) },
    clear: {
        type: "button",
        title: "Clear report",
        onPress() {
            report.length = 0;
            phoenix.storage.set("report", report);
            phoenix.ui.toast("Report cleared");
        },
    },
});

phoenix.commands.register({
    name: "cfspike",
    description: "CustomFavorites spike: open the report (`tree` dumps the view tree first, `send` sends it to the PC)",
    execute(args) {
        const arg = args.trim();
        if (arg === "send") return sendReport();
        if (arg === "tree") guard("tree", dumpTree);
        openReport();
    },
});

note("loaded", "spike plugin loaded");
void dumpCache().catch(e => note("sql:error", String(e)));

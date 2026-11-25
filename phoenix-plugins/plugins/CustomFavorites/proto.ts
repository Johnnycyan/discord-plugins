/*
 * Just enough protobuf to read and replace Favorites in Discord's settings proto (PreloadedUserSettings,
 * settings-proto type 1). The Phoenix runtime has no protobuf, base64 or TextDecoder helpers.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Field number of `favorites` in PreloadedUserSettings */
export const FAVORITES_FIELD = 15;

export interface FavoriteEntry {
    nickname: string;
    type: number;
    position: number;
    parentId: string;
    collapsed?: boolean;
    channelType?: { value: number; };
}

export interface FavoritesState {
    favoriteChannels: Record<string, FavoriteEntry>;
    muted?: boolean;
    [key: string]: unknown;
}

// ---------- Bytes ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function fromBase64(text: string): Uint8Array {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bits = 0, value = 0, n = 0;
    for (const ch of clean) {
        value = ((value << 6) | B64.indexOf(ch)) & 0xffffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (value >> bits) & 0xff;
        }
    }
    return out.subarray(0, n);
}

export function toBase64(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
        out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
        out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
        out += c === undefined ? "=" : B64[c & 63];
    }
    return out;
}

export function fromHex(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

export function decodeUtf8(bytes: Uint8Array): string {
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

function encodeUtf8(text: string): number[] {
    const out: number[] = [];
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return out;
}

// ---------- Wire format ----------

export interface Field {
    field: number;
    wire: number;
    /** varint and fixed64 values */
    int?: bigint;
    /** length-delimited payload */
    bytes?: Uint8Array;
    /** The whole field (key included) as it was read, to write it back unchanged */
    raw: Uint8Array;
}

export function parseFields(bytes: Uint8Array): Field[] {
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
        const start = pos;
        const key = Number(varint());
        const field = key >>> 3, wire = key & 7;
        const f: Field = { field, wire, raw: bytes };
        if (wire === 0) {
            f.int = varint();
        } else if (wire === 1) {
            if (pos + 8 > bytes.length) throw new Error("truncated fixed64");
            let v = 0n;
            for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[pos + i]);
            f.int = v;
            pos += 8;
        } else if (wire === 2) {
            const len = Number(varint());
            if (pos + len > bytes.length) throw new Error(`field ${field}: length past end`);
            f.bytes = bytes.subarray(pos, pos + len);
            pos += len;
        } else if (wire === 5) {
            pos += 4;
        } else {
            throw new Error(`field ${field}: unsupported wire type ${wire}`);
        }
        f.raw = bytes.subarray(start, pos);
        fields.push(f);
    }
    return fields;
}

function varint(value: bigint | number): number[] {
    let n = BigInt(value);
    const out: number[] = [];
    do {
        let b = Number(n & 0x7fn);
        n >>= 7n;
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return out;
}

const key = (field: number, wire: number) => varint((field << 3) | wire);

function fixed64(value: string): number[] {
    let n = BigInt(value);
    const out: number[] = [];
    for (let i = 0; i < 8; i++) {
        out.push(Number(n & 0xffn));
        n >>= 8n;
    }
    return out;
}

const lengthDelimited = (field: number, payload: ArrayLike<number>) => [...key(field, 2), ...varint(payload.length), ...Array.from(payload)];

function concat(parts: ArrayLike<number>[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

// ---------- Favorites ----------

// Favorites { map<fixed64, FavoriteChannel> favorite_channels = 1; bool muted = 2; ... }
// FavoriteChannel { string nickname = 1; type = 2; uint32 position = 3; fixed64 parent_id = 4;
//                   Int32Value channel_type = 5; bool collapsed = 6; }

function decodeEntry(bytes: Uint8Array): FavoriteEntry {
    const entry: FavoriteEntry = { nickname: "", type: 0, position: 0, parentId: "0" };
    for (const f of parseFields(bytes)) {
        if (f.field === 1 && f.bytes) entry.nickname = decodeUtf8(f.bytes);
        else if (f.field === 2 && f.wire === 0) entry.type = Number(f.int);
        else if (f.field === 3 && f.wire === 0) entry.position = Number(f.int);
        else if (f.field === 4 && f.wire === 1) entry.parentId = f.int!.toString();
        else if (f.field === 5 && f.bytes) {
            const value = parseFields(f.bytes).find(v => v.field === 1 && v.wire === 0);
            entry.channelType = { value: value ? Number(BigInt.asIntN(32, value.int!)) : 0 };
        } else if (f.field === 6 && f.wire === 0) entry.collapsed = f.int !== 0n;
    }
    return entry;
}

function encodeEntry(entry: FavoriteEntry): number[] {
    const out: number[] = [];
    if (entry.nickname) out.push(...lengthDelimited(1, encodeUtf8(entry.nickname)));
    if (entry.type) out.push(...key(2, 0), ...varint(entry.type));
    if (entry.position) out.push(...key(3, 0), ...varint(Math.max(0, Math.trunc(entry.position))));
    if (entry.parentId && entry.parentId !== "0") out.push(...key(4, 1), ...fixed64(entry.parentId));
    if (entry.channelType) {
        const value = entry.channelType.value;
        out.push(...lengthDelimited(5, value ? [...key(1, 0), ...varint(BigInt.asUintN(64, BigInt(value)))] : []));
    }
    if (entry.collapsed) out.push(...key(6, 0), 1);
    return out;
}

export function decodeFavorites(bytes: Uint8Array): FavoritesState {
    const state: FavoritesState = { favoriteChannels: {}, muted: false };
    for (const f of parseFields(bytes)) {
        if (f.field === 1 && f.bytes) {
            let id: string | null = null;
            let entry: FavoriteEntry | null = null;
            for (const kv of parseFields(f.bytes)) {
                if (kv.field === 1 && kv.wire === 1) id = kv.int!.toString();
                else if (kv.field === 2 && kv.bytes) entry = decodeEntry(kv.bytes);
            }
            if (id != null) state.favoriteChannels[id] = entry ?? decodeEntry(new Uint8Array(0));
        } else if (f.field === 2 && f.wire === 0) {
            state.muted = f.int !== 0n;
        }
    }
    return state;
}

/**
 * Encodes favorites. Fields this file doesn't model (anything but channels and muted) are copied
 * from `template`, the favorites Discord last sent, so they survive the rewrite.
 */
export function encodeFavorites(state: FavoritesState, template?: Uint8Array): Uint8Array {
    const parts: ArrayLike<number>[] = [];
    for (const [id, entry] of Object.entries(state.favoriteChannels)) {
        if (!/^\d+$/.test(id)) continue;
        parts.push(lengthDelimited(1, [...key(1, 1), ...fixed64(id), ...lengthDelimited(2, encodeEntry(entry))]));
    }
    if (state.muted) parts.push([...key(2, 0), 1]);
    if (template) {
        for (const f of parseFields(template)) {
            if (f.field !== 1 && f.field !== 2) parts.push(f.raw);
        }
    }
    return concat(parts);
}

/** The favorites field of a settings proto, or null if it has none */
export function getFavoritesBytes(settings: Uint8Array): Uint8Array | null {
    return parseFields(settings).find(f => f.field === FAVORITES_FIELD && f.bytes)?.bytes ?? null;
}

/** Settings proto with its favorites replaced by `favorites`, or removed when it is null */
export function setFavoritesBytes(settings: Uint8Array, favorites: Uint8Array | null): Uint8Array {
    const parts: ArrayLike<number>[] = parseFields(settings).filter(f => f.field !== FAVORITES_FIELD).map(f => f.raw);
    if (favorites) parts.push(lengthDelimited(FAVORITES_FIELD, favorites));
    return concat(parts);
}

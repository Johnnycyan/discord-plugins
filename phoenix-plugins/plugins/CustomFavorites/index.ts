// @description Keeps Favorites on this device instead of Discord's servers, synced with the Equicord and Kettu plugins
// @version 0.3.3
// @author Johnnycyan

/*
 * CustomFavorites for Phoenix (Sunbird).
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Phoenix keeps favorites in field 15 of Discord's settings proto. Every change is a PATCH of
 * /users/@me/settings-proto/1 carrying all favorites; Discord answers with the full settings and
 * echoes them as a userSettingsProtoUpdate gateway event, and Phoenix caches what it last applied.
 * This plugin saves the favorites from each PATCH locally and sends Discord its own copy back
 * unchanged, then puts the local favorites into every settings proto Phoenix receives.
 */

import { findRestoreIndex, orderedChildren, PlacementHistory, updatePlacementHistory } from "../../../equicord-plugins/CustomFavorites/placement";
import { createSync, SyncData, SyncMeta, SyncStatus, Timers } from "../../../equicord-plugins/CustomFavorites/sync";
import { decodeFavorites, decodeUtf8, encodeFavorites, FavoritesState, fromBase64, fromHex, getFavoritesBytes, setFavoritesBytes, toBase64 } from "./proto";

/** Favorite entry type for categories (channels and DMs are 1) */
const ENTRY_TYPE_CATEGORY = 2;
/** parentId for "no category" */
const NO_PARENT = "0";
/** Phoenix's fetch gives up after 15 s, so long-polls must return sooner */
const LONG_POLL_MS = 10_000;
const SETTINGS_PATH = "/users/@me/settings-proto/1";

const log = phoenix.log;
const storage = phoenix.storage;
const settingsUpdate = phoenix.gateway.userSettingsProtoUpdate as Phoenix.Sig<SettingsUpdate> | undefined;

interface SettingsUpdate {
    settings?: { type?: number; proto?: string; };
    partial?: boolean;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const emptyState = (): FavoritesState => ({ favoriteChannels: {}, muted: false, autoAddJoinedThreads: false });

/** Validates and cleans favorites (from Discord, the sync server, or storage). Returns null if unusable. */
function normalize(raw: any): FavoritesState | null {
    if (raw == null || typeof raw !== "object") return null;
    if (raw.favoriteChannels == null || typeof raw.favoriteChannels !== "object") return null;

    let state: FavoritesState;
    try {
        state = clone(raw);
    } catch (e) {
        log.error("Failed to copy favorites", e);
        return null;
    }

    for (const [id, entry] of Object.entries<any>(state.favoriteChannels)) {
        if (!/^\d+$/.test(id) || entry == null || typeof entry !== "object" || typeof entry.type !== "number") {
            delete state.favoriteChannels[id];
            continue;
        }
        entry.nickname = typeof entry.nickname === "string" ? entry.nickname : "";
        entry.position = Number(entry.position) || 0;
        entry.parentId = entry.parentId ? String(entry.parentId) : NO_PARENT;
    }

    // Channels pointing at a category that no longer exists become uncategorized
    for (const entry of Object.values(state.favoriteChannels)) {
        if (entry.parentId === NO_PARENT) continue;
        if (state.favoriteChannels[entry.parentId]?.type !== ENTRY_TYPE_CATEGORY) entry.parentId = NO_PARENT;
    }

    return state;
}

function countEntries(state: FavoritesState | null) {
    const entries = Object.values(state?.favoriteChannels ?? {});
    return {
        channels: entries.filter(e => e.type !== ENTRY_TYPE_CATEGORY).length,
        categories: entries.filter(e => e.type === ENTRY_TYPE_CATEGORY).length,
    };
}

// ---------- Timers ----------

// The runtime has no setTimeout. Due timers run whenever the plugin gets a callback: a gateway event
// it listens to, a request it intercepts, or a fetch finishing (the sync long-poll returns at least
// every LONG_POLL_MS while syncing).
const pendingTimers = new Map<number, { at: number; callback: () => void; }>();
let nextTimerId = 1;

const timers: Timers = {
    setTimeout(callback, ms) {
        const id = nextTimerId++;
        pendingTimers.set(id, { at: Date.now() + ms, callback });
        return id;
    },
    clearTimeout(handle) {
        pendingTimers.delete(handle as number);
    },
};

function runDueTimers() {
    const now = Date.now();
    for (const [id, timer] of [...pendingTimers]) {
        if (timer.at > now) continue;
        pendingTimers.delete(id);
        try {
            timer.callback();
        } catch (e) {
            log.error("Timer failed", e);
        }
    }
}

for (const name of ["messageCreate", "typingStart", "messageAck", "channelUnreadUpdate"]) {
    const sig = phoenix.gateway[name];
    if (sig) phoenix.on(sig, runDueTimers);
}

// ---------- State ----------

let cache: FavoritesState | null = null;

function getState(): FavoritesState {
    cache ??= normalize(storage.get("data")) ?? emptyState();
    return cache;
}

function getPlacementHistory(): PlacementHistory {
    return storage.get<PlacementHistory>("placementHistory") ?? {};
}

/** Saves favorites without telling Phoenix (it already shows them) or the sync server */
function saveState(next: FavoritesState) {
    cache = clone(next);
    storage.set("data", cache);
}

/** Favorites Discord has, as it last sent them; kept so they reach Discord unchanged */
function getOfficialBytes(): Uint8Array | null {
    const saved = storage.get<string>("official");
    return saved ? fromBase64(saved) : null;
}

function getOfficialState(): FavoritesState | null {
    const bytes = getOfficialBytes();
    return bytes ? normalize(decodeFavorites(bytes)) : null;
}

function rememberOfficial(favorites: Uint8Array) {
    storage.set("official", toBase64(favorites));
}

/** The last full settings proto Phoenix received, the base for pushing favorites to it */
let lastSettings: Uint8Array | null = null;

async function getSettingsBase(): Promise<Uint8Array | null> {
    if (lastSettings) return lastSettings;
    const [row] = await phoenix.stores.sql<{ v: string; }>("SELECT hex(v) AS v FROM user_settings_proto WHERE k = ?", "settings.preloaded");
    return row ? fromHex(row.v) : null;
}

/** Settings proto with the local favorites in it */
function withLocalFavorites(settings: Uint8Array) {
    return setFavoritesBytes(settings, encodeFavorites(getState(), getOfficialBytes() ?? undefined));
}

/** Makes Phoenix show `favorites` (the local ones by default) by feeding it a settings update */
async function pushToPhoenix(favorites?: Uint8Array) {
    if (!settingsUpdate) {
        log.warn("No userSettingsProtoUpdate event in this build, can't refresh favorites");
        return;
    }
    const base = await getSettingsBase();
    if (!base) {
        log.warn("No settings proto seen yet, favorites refresh when Discord sends one");
        return;
    }
    const proto = favorites ? setFavoritesBytes(base, favorites) : withLocalFavorites(base);
    phoenix.enqueue(settingsUpdate, { settings: { type: 1, proto: toBase64(proto) }, partial: false });
}

/** Favorites changed on this device outside Phoenix's own UI (import, sync): save, show and upload them */
function setState(next: FavoritesState) {
    saveState(next);
    void pushToPhoenix();
    sync.notifyLocalChange();
}

// ---------- Changes made in Phoenix ----------

/**
 * "Move to" puts a channel last in its new category. When it returns to the category it last left,
 * put it back where it was instead. `history` is from before this change.
 */
function restorePlacement(before: FavoritesState, after: FavoritesState, history: PlacementHistory) {
    const moved = Object.keys(after.favoriteChannels).filter(id => {
        const prev = before.favoriteChannels[id], next = after.favoriteChannels[id];
        return prev != null && next.type !== ENTRY_TYPE_CATEGORY && next.parentId !== prev.parentId;
    });
    if (moved.length !== 1) return;

    const movedId = moved[0];
    const target = after.favoriteChannels[movedId].parentId;
    const placement = history[movedId];
    if (placement?.parentId !== target) return;

    const others = orderedChildren(after.favoriteChannels, target, ENTRY_TYPE_CATEGORY).filter(id => id !== movedId);
    const index = findRestoreIndex(others, placement);
    if (index === -1) return;

    // Reuse the positions the category ends up with, in the restored order
    const positions = others.concat(movedId).map(id => after.favoriteChannels[id].position).sort((a, b) => a - b);
    const order = others.slice();
    order.splice(index, 0, movedId);
    order.forEach((id, i) => { after.favoriteChannels[id].position = positions[i]; });
}

function applyPhoenixChange(edited: FavoritesState) {
    const before = getState();
    const history = getPlacementHistory();
    // Phoenix doesn't know about fields only the other clients set, like guildVisible
    const next: FavoritesState = { ...before, favoriteChannels: edited.favoriteChannels, muted: edited.muted };

    try {
        restorePlacement(before, next, history);
        const updated = updatePlacementHistory(clone(history), before.favoriteChannels, next.favoriteChannels, ENTRY_TYPE_CATEGORY, NO_PARENT);
        if (updated) storage.set("placementHistory", updated);
    } catch (e) {
        log.error("Failed to update placement history", e);
    }

    saveState(normalize(next) ?? next);
    sync.notifyLocalChange();
}

// Phoenix sends all favorites on every change: keep them, and send Discord its own copy instead
phoenix.discord.onRequest({ method: "PATCH", pathSuffix: SETTINGS_PATH }, req => {
    runDueTimers();
    try {
        const body = req.json<{ settings?: string; }>();
        if (!body?.settings) return;
        const settings = fromBase64(body.settings);
        const favorites = getFavoritesBytes(settings);
        if (!favorites) return;

        const edited = normalize(decodeFavorites(favorites));
        if (edited) applyPhoenixChange(edited);

        return { body: { ...body, settings: toBase64(setFavoritesBytes(settings, getOfficialBytes())) } };
    } catch (e) {
        log.error("Failed to keep a favorites change local", e);
    }
});

// ---------- "Add to Favorites" past Phoenix's limit ----------

// Phoenix checks the favorites limit when "Add to Favorites" in a channel's long-press menu is
// pressed, and shows a Nitro upsell. The press is caught and the channel added here instead. The
// menu doesn't say which channel it is for: the long-press that opened it gives a row index in the
// channel list, and each row holds a `navigation.channel:<id>` node.
//
// The press intercept exists only while such a menu is open. While any plugin intercepts "press",
// Sunbird hands every press to JS first, and one passed back goes straight to Phoenix, skipping
// Sunbird's own handlers: buttons that plugins draw (ui.choose dialogs, pages) stop working.

const ADD_ROW_ID = "Add to Favorites";
const CHANNEL_NODE_PREFIX = "navigation.channel:";
/** A press this long after the long-press belongs to some other menu */
const MENU_WINDOW_MS = 60_000;

let menuChannel: { id: string; at: number; } | null = null;
let removePressIntercept: (() => void) | null = null;

function stopIntercepting() {
    removePressIntercept?.();
    removePressIntercept = null;
    menuChannel = null;
}

function onMenuPress(ev: Phoenix.ViewEvent) {
    const channel = menuChannel;
    // Any press closes the menu: the next one may be on a plugin's own button
    stopIntercepting();
    if (ev.accessibilityId !== ADD_ROW_ID) return false;
    // Unknown channel: leave the press to Phoenix
    if (!channel || Date.now() - channel.at > MENU_WINDOW_MS || !/^\d+$/.test(channel.id)) return false;
    addFavorite(channel.id).catch(e => {
        log.error("Failed to add favorite", e);
        phoenix.ui.toast("Couldn't add to Favorites");
    });
    return true;
}

phoenix.ui.onEvent("rowLongPress", ev => {
    stopIntercepting();
    const index = (ev.payload as { index?: number; } | null)?.index;
    if (typeof index !== "number") return;
    const row = phoenix.ui.node(ev.node)?.children[index];
    const found = row == null ? null : phoenix.ui.findDown(row, { prefix: CHANNEL_NODE_PREFIX }, 4);
    const id = found == null ? null : phoenix.ui.node(found)?.accessibilityId;
    if (!id) return;
    menuChannel = { id: id.slice(CHANNEL_NODE_PREFIX.length), at: Date.now() };
    removePressIntercept = phoenix.ui.onEvent("press", onMenuPress, { intercept: true });
});

// Closing the menu without pressing anything
phoenix.ui.onEvent("dismiss", () => stopIntercepting());

// ---------- Phoenix's cache ----------

// Rows are JSON. Ids in keys are padded to 20 digits; channels are keyed `<guild id>:<channel id>`
// (guild 0 for DMs), guilds by their id.

const pad = (id: string) => id.padStart(20, "0");
const unpad = (id: string) => id.replace(/^0+(?=\d)/, "");

interface CachedChannel { guildId: string | null; data: Record<string, unknown> | null; }

const channelCache = new Map<string, CachedChannel | null>();

async function getCachedChannel(channelId: string): Promise<CachedChannel | null> {
    if (channelCache.has(channelId)) return channelCache.get(channelId)!;
    const [row] = await phoenix.stores.sql<{ k: string; v: string; }>("SELECT k, hex(v) AS v FROM channels WHERE k LIKE ? LIMIT 1", `%:${pad(channelId)}`);
    let result: CachedChannel | null = null;
    if (row) {
        const guild = unpad(row.k.split(":")[0]);
        let data: Record<string, unknown> | null = null;
        try {
            data = JSON.parse(decodeUtf8(fromHex(row.v)));
        } catch { }
        result = { guildId: guild === "0" ? null : guild, data };
    }
    channelCache.set(channelId, result);
    return result;
}

async function getChannelType(channelId: string): Promise<number | null> {
    try {
        const type = (await getCachedChannel(channelId))?.data?.type;
        return typeof type === "number" ? type : null;
    } catch (e) {
        log.warn("Couldn't read the channel type", e);
        return null;
    }
}

const guildIconCache = new Map<string, string | null>();

/** The guild's icon hash, from `properties.icon` of its cached row */
async function getGuildIcon(guildId: string): Promise<string | null> {
    if (guildIconCache.has(guildId)) return guildIconCache.get(guildId)!;
    const [row] = await phoenix.stores.sql<{ v: string; }>("SELECT hex(v) AS v FROM guilds WHERE k = ?", pad(guildId));
    let icon: string | null = null;
    try {
        const data = row ? JSON.parse(decodeUtf8(fromHex(row.v))) : null;
        const value = data?.properties?.icon ?? data?.icon;
        icon = typeof value === "string" ? value : null;
    } catch { }
    guildIconCache.set(guildId, icon);
    return icon;
}

async function addFavorite(channelId: string) {
    if (getState().favoriteChannels[channelId]) {
        phoenix.ui.toast("Already in Favorites");
        return;
    }
    const channelType = await getChannelType(channelId);
    const next = clone(getState());
    const position = Math.max(-1, ...Object.values(next.favoriteChannels).map(e => e.position)) + 1;
    next.favoriteChannels[channelId] = {
        nickname: "",
        type: 1,
        position,
        parentId: NO_PARENT,
        ...(channelType == null ? {} : { channelType: { value: channelType } }),
    };
    setState(next);
    phoenix.ui.toast("Added to Favorites");
}

// ---------- Server icons in the Favorites list ----------

// Each channel row holds a `navigation.channel:<id>` node. Its container stacks children on top of each
// other, so the icon goes into the row's side-by-side layout instead: the first node under the channel
// node with several children (type icon, name, ...). Rows are recreated as the list scrolls, so icons
// are mounted from onNode. `channel-list-panel` holds a header and the pages (one channel list each,
// two levels down). While Favorites is open the header has a `favorites-add` node; a server's page has
// its own `guild.menu` node, which rules out server pages Phoenix keeps around.

const ICON_SIZE = 20;
const CHANNEL_LIST_PANEL = "channel-list-panel";
const FAVORITES_MARKER = "favorites-add";
const GUILD_PAGE_MARKER = "guild.menu";

/** Channel node id -> unmount */
const iconMounts = new Map<number, () => void>();

/**
 * The row's side-by-side layout: down single children from the channel node to one with several.
 * Its first child is the type icon, which has no children. When the first child has some, the node
 * is a column (a voice channel's line with its users under it), so look inside that first child.
 */
function iconTarget(rowNode: number): number | null {
    let current = rowNode;
    for (let i = 0; i < 8; i++) {
        const children = phoenix.ui.node(current)?.children ?? [];
        if (children.length === 1) {
            current = children[0];
            continue;
        }
        if (children.length < 2) return null;
        if (!phoenix.ui.node(children[0])?.children.length) return current;
        current = children[0];
    }
    return null;
}

/** The channel list panel and the page in it that a node belongs to */
function pageOf(id: number): { panel: number; page: number; } | null {
    let current: number | null = id;
    for (let i = 0; current != null && i < 20; i++) {
        const parent: number | null = phoenix.ui.node(current)?.parent ?? null;
        const grandparent = parent == null ? null : phoenix.ui.node(parent)?.parent ?? null;
        if (grandparent != null && phoenix.ui.node(grandparent)?.accessibilityId === CHANNEL_LIST_PANEL) return { panel: grandparent, page: current };
        current = parent;
    }
    return null;
}

function inFavoritesList(rowNode: number) {
    const where = pageOf(rowNode);
    return where != null
        && phoenix.ui.findDown(where.panel, { exact: FAVORITES_MARKER }, 6) != null
        && phoenix.ui.findDown(where.page, { exact: GUILD_PAGE_MARKER }, 8) == null;
}

async function mountGuildIcon(rowNode: number, channelId: string) {
    if (iconMounts.has(rowNode) || !settings.showGuildIcons) return;
    if (!getState().favoriteChannels[channelId]) return;
    if (!inFavoritesList(rowNode)) return;

    const guildId = (await getCachedChannel(channelId))?.guildId;
    const icon = guildId ? await getGuildIcon(guildId) : null;
    // Looked up after the awaits: the row's children may not exist yet when its node is created
    const target = iconTarget(rowNode);
    if (!guildId || !icon || target == null || iconMounts.has(rowNode)) return;

    // A full-height column centers the icon on the row
    iconMounts.set(rowNode, phoenix.ui.mount(target, {
        kind: "view",
        props: { direction: "column", height: "fill", justify: "center", margin: [0, 0, 8, 0] },
        children: [{
            kind: "image",
            props: {
                uri: `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=64`,
                width: ICON_SIZE,
                height: ICON_SIZE,
                radius: ICON_SIZE / 2,
            },
        }],
    }, { before: "start" }));

    // Forget rows the list has thrown away
    for (const id of [...iconMounts.keys()]) {
        if (phoenix.ui.node(id) == null) iconMounts.delete(id);
    }
}

function mountIconsOnScreen() {
    for (const id of phoenix.ui.find({ prefix: CHANNEL_NODE_PREFIX })) {
        const channelId = phoenix.ui.node(id)?.accessibilityId?.slice(CHANNEL_NODE_PREFIX.length);
        if (channelId) void mountGuildIcon(id, channelId).catch(e => log.error("Failed to show a server icon", e));
    }
}

function removeIcons() {
    iconMounts.forEach(remove => remove());
    iconMounts.clear();
}

phoenix.ui.onNode({ prefix: CHANNEL_NODE_PREFIX }, n => {
    const channelId = n.accessibilityId?.slice(CHANNEL_NODE_PREFIX.length);
    if (channelId) void mountGuildIcon(n.id, channelId).catch(e => log.error("Failed to show a server icon", e));
});

// In case the Favorites page's marker shows up after its first rows
phoenix.ui.onNode({ exact: FAVORITES_MARKER }, () => mountIconsOnScreen());

// ---------- Settings Phoenix receives ----------

/** Remembers Discord's favorites and the settings base, and returns the proto with local favorites */
function rewriteIncoming(proto: string, partial: boolean): string | null {
    const settings = fromBase64(proto);
    const favorites = getFavoritesBytes(settings);
    if (favorites) rememberOfficial(favorites);
    else if (partial) return null;
    if (!partial) lastSettings = settings;
    return toBase64(withLocalFavorites(settings));
}

phoenix.discord.onResponse({ pathSuffix: SETTINGS_PATH }, res => {
    runDueTimers();
    if (res.status !== 200) return;
    try {
        const body = res.json<{ settings?: string; }>();
        if (!body?.settings) return;
        const settings = rewriteIncoming(body.settings, false);
        if (settings) return { body: { ...body, settings } };
    } catch (e) {
        log.error("Failed to put local favorites into Discord's reply", e);
    }
});

if (settingsUpdate) {
    phoenix.hook(settingsUpdate, {
        before(payload) {
            runDueTimers();
            if (payload?.settings?.type !== 1 || !payload.settings.proto) return;
            try {
                const proto = rewriteIncoming(payload.settings.proto, !!payload.partial);
                if (proto) payload.settings.proto = proto;
            } catch (e) {
                log.error("Failed to put local favorites into a settings update", e);
            }
        },
    });
}

// ---------- Sync ----------

let syncStatus: SyncStatus = { state: "off" };

/**
 * Starts the message of errors where the server couldn't be reached. Android cuts the network of
 * apps in the background, so these come and go on their own: no toast, the sync retries.
 */
const UNREACHABLE = "Can't reach the sync server";

const sync = createSync({
    getConfig: () => ({ url: settings.syncUrl.trim(), token: settings.syncToken.trim() }),
    getLocal: (): SyncData => clone({ state: getState() as SyncData["state"], placementHistory: getPlacementHistory() as SyncData["placementHistory"] }),
    applyRemote(data) {
        saveState(normalize(data.state) ?? emptyState());
        storage.set("placementHistory", clone(data.placementHistory ?? {}));
        void pushToPhoenix();
    },
    loadMeta: () => storage.get<SyncMeta>("syncMeta") ?? null,
    saveMeta(meta) {
        if (meta) storage.set("syncMeta", meta);
        else storage.delete("syncMeta");
    },
    async request(method, url, token, body) {
        try {
            let res: Phoenix.FetchResponse;
            try {
                res = await phoenix.fetch(url, {
                    method,
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
            } catch (e) {
                // phoenix.fetch rejects only when no answer came back (HTTP errors resolve)
                throw new Error(`${UNREACHABLE} (${(e as Error)?.message ?? e})`);
            }
            return { status: res.status, json: async () => res.json() };
        } finally {
            runDueTimers();
        }
    },
    async chooseFirstSync(local, remote) {
        const here = countEntries(local.state as FavoritesState), there = countEntries(remote.state as FavoritesState);
        const choice = await phoenix.ui.choose({
            title: "Sync favorites",
            message: `The sync server already has favorites (${there.channels} channels, ${there.categories} categories), and so does this device (${here.channels} channels, ${here.categories} categories). Which should be kept? The other copy is replaced.`,
            options: ["Use server's", "Upload this device's"],
        });
        if (choice === 0) return "server";
        if (choice === 1) return "device";
        // Dismissed without choosing: pause until the user resumes from the settings
        sync.stop();
        throw new Error("Paused: choose which favorites to keep (Sync now in the plugin settings)");
    },
    onStatus(status) {
        const isProblem = (s: SyncStatus) => s.state === "error" && !s.message?.startsWith(UNREACHABLE);
        // Toast a problem once, not again on each retry
        const failed = isProblem(status) && !isProblem(syncStatus);
        syncStatus = status.state === "ok" ? status : { ...status, lastSync: syncStatus.lastSync };
        if (failed) phoenix.ui.toast(`Favorites sync: ${status.message ?? "error"}`);
    },
    log: (...args) => log.info(...args),
    timers,
    longPollMs: LONG_POLL_MS,
});

function startSync() {
    const url = settings.syncUrl.trim();
    if (url && !/^https?:\/\//.test(url)) {
        sync.stop();
        syncStatus = { state: "error", message: "The URL must start with https://" };
        phoenix.ui.toast("Favorites sync: the URL must start with https://");
        return;
    }
    sync.start();
}

function describeSyncStatus(status: SyncStatus) {
    switch (status.state) {
        case "off": return "Off. Enter a server URL and token to sync.";
        case "syncing": return "Connecting...";
        case "ok": return `Synced${status.lastSync ? ` at ${new Date(status.lastSync).toLocaleTimeString()}` : ""}`;
        case "error": return `Error: ${status.message ?? "unknown"}`;
    }
}

// ---------- Import and export ----------

function importOfficial(mode: "replace" | "merge") {
    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) {
        phoenix.ui.toast("Discord's Favorites are empty, nothing to import");
        return;
    }

    if (mode === "replace") {
        setState(official);
        storage.set("placementHistory", {});
    } else {
        const next = clone(getState());
        const offset = Math.max(-1, ...Object.values(next.favoriteChannels).map(e => e.position)) + 1;
        for (const [id, entry] of Object.entries(official.favoriteChannels)) {
            if (id in next.favoriteChannels) continue;
            next.favoriteChannels[id] = { ...entry, position: entry.position + offset };
        }
        setState(normalize(next) ?? next);
    }

    const { channels, categories } = countEntries(getState());
    phoenix.ui.toast(`Imported favorites: ${channels} channels, ${categories} categories`);
}

async function confirmReplaceImport() {
    if (countEntries(getState()).channels > 0) {
        const choice = await phoenix.ui.choose({
            title: "Replace your favorites?",
            message: "This replaces everything in your custom Favorites with a copy of Discord's Favorites.",
            options: ["Replace", "Cancel"],
        });
        if (choice !== 0) return;
    }
    importOfficial("replace");
}

async function maybeOfferImport() {
    if (storage.get("offeredImport")) return;
    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) return;

    storage.set("offeredImport", true);
    if (Object.keys(getState().favoriteChannels).length > 0) return;

    const { channels, categories } = countEntries(official);
    const choice = await phoenix.ui.choose({
        title: "Import your Favorites?",
        message: `CustomFavorites can copy your Discord Favorites (${channels} channels, ${categories} categories). You can also do this later from the plugin settings.`,
        options: ["Import", "Not now"],
    });
    if (choice === 0) importOfficial("replace");
}

// ---------- Settings page ----------

const settings = phoenix.settings.define({
    showGuildIcons: {
        type: "switch",
        title: "Show server icons",
        description: "Show the server icon to the left of favorited server channels",
        default: true,
        onChange(value) {
            if (value) mountIconsOnScreen();
            else removeIcons();
        },
    },
    syncUrl: {
        type: "text",
        title: "Sync server URL",
        description: "Self-hosted, see the sync-server folder. Leave empty to not sync.",
        default: "",
        onChange: startSync,
    },
    syncToken: {
        type: "secret",
        title: "Sync server token",
        description: "The server's SYNC_TOKEN",
        default: "",
        onChange: startSync,
    },
    syncNow: { type: "button", title: "Sync now", onPress: startSync },
    syncStatus: { type: "button", title: "Show sync status", onPress: () => phoenix.ui.toast(describeSyncStatus(syncStatus)) },
    summary: {
        type: "button",
        title: "Show counts",
        description: "Custom Favorites and Discord's Favorites",
        onPress() {
            const local = countEntries(getState()), official = countEntries(getOfficialState());
            phoenix.ui.toast(`Custom: ${local.channels} channels in ${local.categories} categories. Discord's: ${official.channels} channels in ${official.categories} categories.`);
        },
    },
    importReplace: { type: "button", title: "Import from Discord (replace)", description: "Replace your custom Favorites with Discord's", onPress: () => void confirmReplaceImport() },
    importMerge: { type: "button", title: "Import from Discord (merge)", description: "Add Discord's Favorites you don't have yet", onPress: () => importOfficial("merge") },
    exportCopy: {
        type: "button",
        title: "Export to clipboard",
        description: "Copy your custom Favorites as JSON",
        onPress() {
            phoenix.ui.copy(JSON.stringify(getState()));
            phoenix.ui.toast("Favorites copied as JSON");
        },
    },
});

// ---------- Lifecycle ----------

async function start() {
    // First run: Phoenix's cache still holds Discord's own favorites
    if (!storage.get("official")) {
        const base = await getSettingsBase();
        const favorites = base && getFavoritesBytes(base);
        if (favorites) rememberOfficial(favorites);
    }
    await pushToPhoenix();
    await maybeOfferImport();
}

phoenix.onUnload(() => {
    stopIntercepting();
    removeIcons();
    sync.stop();
    pendingTimers.clear();
    // Hand Phoenix Discord's favorites back
    const official = getOfficialBytes();
    if (official) void pushToPhoenix(official);
});

start().catch(e => log.error("Failed to start", e));
startSync();

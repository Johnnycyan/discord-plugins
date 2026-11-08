/*
 * CustomFavorites for Valenced
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findRestoreIndex, orderedChildren, PlacementHistory, updatePlacementHistory } from "../../../equicord-plugins/CustomFavorites/placement";
import { createSync, SyncData, SyncMeta, SyncStatus } from "../../../equicord-plugins/CustomFavorites/sync";

import Page from "@valenced/components/Page";
import { AlertActionCreators } from "@valenced/discord/actions";
import { Design } from "@valenced/discord/design";
import { Dispatcher } from "@valenced/discord/common/flux";
import { Stores } from "@valenced/discord/flux";
import { Clipboard } from "@valenced/externals/react-native-clipboard";
import { getModules, lookupModules as findModules } from "@valenced/modules/finders";
import { createFilterGenerator, FilterScopes, withName, withProps } from "@valenced/modules/finders/filters";
import { after, before, instead } from "@valenced/patcher";
import { findInReactFiber } from "@valenced/utils/react";
import { createContext, useContext, useEffect, useReducer, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";

import type { JsonStorage } from "@valenced/json-storage";
import type { PluginCleanupApi } from "@valenced/plugins/types";
import type { ReactElement } from "react";

const { AlertActionButton, AlertModal, Stack, TableRow, TableRowGroup, TableSwitchRow, TextInput } = Design;

/** Prefix for alert keys */
const ID = "johnnycyan.custom-favorites";
/** Id of Discord's Favorites pseudo-guild */
const FAVORITES_GUILD_ID = "373";
/** Favorite entry type for categories in Discord's favorites proto (channels and DMs are 1) */
const ENTRY_TYPE_CATEGORY = 2;
/** parentId used by Discord for "no category" */
const NO_PARENT = "0";
/** "Move to..." is followed by its reorder call within this window */
const MOVE_SHEET_WINDOW_MS = 120_000;

interface FavoriteEntry {
    nickname: string;
    type: number;
    position: number;
    parentId: string;
    collapsed?: boolean;
    channelType?: { value: number; };
}

interface FavoritesState {
    favoriteChannels: Record<string, FavoriteEntry>;
    muted?: boolean;
    guildVisible?: { value: boolean; };
    autoAddJoinedThreads?: boolean;
}

/** One entry as FavoriteStore hands it to the UI */
interface StoreFavorite {
    id: string;
    nickname: string | null;
    type: number;
    order: number;
    parentId: string | null;
}

interface Settings {
    data?: FavoritesState | null;
    placementHistory?: PlacementHistory;
    offeredImport?: boolean;
    showGuildIcons?: boolean;
    syncUrl?: string;
    syncToken?: string;
    syncMeta?: SyncMeta | null;
}

const DefaultSettings: Settings = { showGuildIcons: true };

// ---------- Storage ----------

let jsonStorage: JsonStorage<Settings> | null = null;

const settings = (): Settings => ({ ...DefaultSettings, ...jsonStorage?.cache });

/**
 * Saves a partial change. Replaces the whole document: JsonStorage's merge is deep,
 * so removed favorites would otherwise stay on disk.
 */
function save(patch: Partial<Settings>) {
    if (!jsonStorage) return;
    jsonStorage.set({ ...settings(), ...patch }, true)
        .catch(e => logger.error("Failed to save settings", e));
}

// ---------- Diagnostics ----------

/** What happened at start, for the "Copy diagnostics" report */
const diagnostics = {
    version: "",
    missingStores: [] as string[],
    /** Lazily patched modules: waiting, patched or failed */
    modules: {} as Record<string, string>,
    /** What Discord's own FavoriteStore returned before it was patched */
    originalStore: null as unknown,
    patches: {} as Record<string, string>,
    storeMethods: { patched: [] as string[], absent: [] as string[] },
    /** Last category collapse actions seen */
    collapseActions: [] as { type: string; keys: string[]; }[],
    /** Recent calls into Discord's favorites actions, settings writes, and errors */
    events: [] as string[],
};

/** Short, JSON-safe summary of a value for the event log */
function summarize(value: unknown, depth = 0): unknown {
    if (value == null || typeof value !== "object") return typeof value === "function" ? "fn" : value;
    if (depth >= 2) return Array.isArray(value) ? `[${value.length}]` : "{...}";
    if (Array.isArray(value)) return value.slice(0, 4).map(v => summarize(v, depth + 1));
    const out: Record<string, unknown> = {};
    Object.keys(value).slice(0, 8).forEach(key => {
        try {
            out[key] = summarize((value as any)[key], depth + 1);
        } catch { }
    });
    return out;
}

function recordEvent(label: string, detail?: unknown) {
    let text = label;
    try {
        if (detail !== undefined) text += ` ${JSON.stringify(summarize(detail))}`;
    } catch { }
    diagnostics.events = [`${new Date().toLocaleTimeString()} ${text.slice(0, 400)}`, ...diagnostics.events].slice(0, 25);
}

/** Every function name on an object and its prototypes, Object.prototype excluded */
function functionNames(obj: any) {
    const names = new Set<string>();
    let current = obj;
    while (current && current !== Object.prototype) {
        Object.getOwnPropertyNames(current).forEach(name => {
            try {
                if (name !== "constructor" && typeof current[name] === "function") names.add(name);
            } catch { }
        });
        current = Object.getPrototypeOf(current);
    }
    return [...names].sort();
}

/** Loaded modules with an export named like "favorite", to spot renamed Discord APIs */
const withFavoriteExport = createFilterGenerator<[]>(
    (_, __, exports) => {
        if (exports == null || (typeof exports !== "object" && typeof exports !== "function")) return false;
        return [exports, exports.default].some(target => target != null && (typeof target === "object" || typeof target === "function")
            && Object.keys(target).some(key => /favorit/i.test(key)));
    },
    () => "johnnycyan.custom-favorites.favoriteExport",
    FilterScopes.Initialized,
);

function findFavoriteModules() {
    const found: { id: number; keys: string[]; }[] = [];
    for (const [exports, id] of findModules(withFavoriteExport(), { returnNamespace: true } as any) as any) {
        const keys = new Set<string>();
        try {
            [exports, exports?.default].forEach((target: any) => {
                if (target == null || (typeof target !== "object" && typeof target !== "function")) return;
                Object.keys(target).forEach(key => keys.add(key));
            });
        } catch { }
        found.push({ id, keys: [...keys].slice(0, 25) });
        if (found.length >= 40) break;
    }
    return found;
}

function buildDiagnostics() {
    const tryRun = (fn: () => unknown) => {
        try {
            return fn();
        } catch (e) {
            return `threw: ${e instanceof Error ? e.message : String(e)}`;
        }
    };
    const stored = settings().data?.favoriteChannels;
    const meta = settings().syncMeta;
    return {
        plugin: diagnostics.version,
        storage: { loaded: jsonStorage?.loaded ?? null, storedEntries: stored ? Object.keys(stored).length : null },
        state: countEntries(getState()),
        official: tryRun(() => countEntries(getOfficialState())),
        // What Discord's UI sees: matches `state` when the store patches work
        storeView: tryRun(() => ({
            getFavoriteChannels: Object.keys(FavoriteStore.getFavoriteChannels() ?? {}).length,
            getFavoritesCount: FavoriteStore.getFavoritesCount?.(),
            hasStoredFavorites: FavoriteStore.hasStoredFavorites?.(),
        })),
        sync: {
            configured: !!(settings().syncUrl && settings().syncToken),
            status: syncStatus,
            metaServerMatches: meta ? meta.server === (settings().syncUrl ?? "").trim() : null,
            revision: meta?.revision ?? null,
            baseEntries: meta ? Object.keys(meta.base?.state?.favoriteChannels ?? {}).length : null,
        },
        missingStores: diagnostics.missingStores,
        modules: diagnostics.modules,
        originalStore: diagnostics.originalStore,
        sampleEntries: tryRun(() => Object.values(FavoriteStore.getFavoriteChannels() ?? {}).slice(0, 2)),
        categoryRecord: tryRun(() => {
            const id = Object.keys(getState().favoriteChannels).find(key => getState().favoriteChannels[key].type === ENTRY_TYPE_CATEGORY);
            const record = id ? FavoriteStore.getCategoryRecord(id) : undefined;
            return {
                templateSource: categoryTemplateSource,
                record: record == null ? null : { constructor: record.constructor?.name, id: record.id, name: record.name, type: record.type, guild_id: record.guild_id, keys: Object.keys(record).slice(0, 30) },
            };
        }),
        // Discord's own store as it is now, through the unpatched prototype methods
        originalStoreNow: tryRun(() => {
            const proto = Object.getPrototypeOf(FavoriteStore);
            const entries: any[] = Object.values(proto.getFavoriteChannels.call(FavoriteStore) ?? {});
            const category = entries.find(e => e?.type === ENTRY_TYPE_CATEGORY);
            const record = category ? proto.getCategoryRecord.call(FavoriteStore, category.id) : undefined;
            return {
                count: entries.length,
                sample: entries.slice(0, 2),
                categoryRecord: record == null ? null : { constructor: record.constructor?.name, id: record.id, name: record.name, type: record.type, guild_id: record.guild_id, parent_id: record.parent_id, keys: Object.keys(record).slice(0, 30) },
            };
        }),
        sampleChannel: tryRun(() => {
            const id = Object.keys(getState().favoriteChannels).find(key => getState().favoriteChannels[key].type !== ENTRY_TYPE_CATEGORY);
            const channel = id ? ChannelStore.getChannel(id) : undefined;
            return channel == null ? null : { constructor: channel.constructor?.name, type: channel.type, guild_id: channel.guild_id, hasMerge: typeof channel.merge === "function" };
        }),
        favoriteStores: tryRun(() => Object.keys(Stores).filter(name => /favorit/i.test(name))),
        favoriteModules: tryRun(findFavoriteModules),
        patches: diagnostics.patches,
        storeMethods: diagnostics.storeMethods,
        // The category list Discord's "Move to..." sheet offers
        favoritesCategories: tryRun(() => {
            const fn = FavoriteHelpers?.getFavoritesCategories;
            if (typeof fn !== "function") return "not loaded";
            const result = fn();
            return { arity: fn.length, count: result == null ? null : Object.keys(result).length, sample: summarize(Array.isArray(result) ? result.slice(0, 2) : result) };
        }),
        collapseActions: diagnostics.collapseActions,
        events: diagnostics.events,
        favoriteStoreFunctions: tryRun(() => functionNames(FavoriteStore)),
    };
}

function copyDiagnostics() {
    Clipboard.setString(JSON.stringify(buildDiagnostics(), null, 2));
    notify("Diagnostics copied", "A report of what the plugin found was copied to the clipboard.");
}

// ---------- Discord modules (looked up in start) ----------

let logger: { log(...args: any[]): void; error(...args: any[]): void; } = console;

let FavoriteStore: any;
let CategoryCollapseStore: any;
let UserSettingsProtoStore: any;
let GuildStore: any;
let ChannelStore: any;

let IconUtils: any;
/** Discord's favorites helpers module (getFavoritesLimits, getFavoritesCategories, ...) */
let FavoriteHelpers: any;

function lookupStores() {
    FavoriteStore = Stores.FavoriteStore;
    CategoryCollapseStore = Stores.CategoryCollapseStore;
    UserSettingsProtoStore = Stores.UserSettingsProtoStore;
    GuildStore = Stores.GuildStore;
    ChannelStore = Stores.ChannelStore;

    const missing = Object.entries({ FavoriteStore, CategoryCollapseStore, UserSettingsProtoStore, GuildStore, ChannelStore })
        .filter(([, store]) => store == null).map(([name]) => name);
    diagnostics.missingStores = missing;
    if (missing.length) logger.error(`Stores not found: ${missing.join(", ")}`);
}

/**
 * Runs `apply` on a module now if Discord already loaded it, or as soon as it does.
 * Valenced only searches loaded modules, and Discord loads most of these lazily.
 */
function whenLoaded(cleanup: PluginCleanupApi, name: string, filter: any, apply: (mod: any) => void, options: object = {}) {
    diagnostics.modules[name] = "waiting";
    cleanup(getModules(filter, (mod: any) => {
        try {
            apply(mod);
            diagnostics.modules[name] = "patched";
        } catch (e) {
            diagnostics.modules[name] = `failed: ${e instanceof Error ? e.message : String(e)}`;
            logger.error(`Failed to patch ${name}`, e);
        }
    }, { max: 1, ...options } as any));
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const emptyState = (): FavoritesState => ({
    favoriteChannels: {},
    muted: false,
    autoAddJoinedThreads: false,
});

/** Validates and cleans a favorites object (from Discord, a paste, or storage). Returns null if unusable. */
function normalize(raw: any): FavoritesState | null {
    if (raw == null || typeof raw !== "object") return null;
    if (raw.favoriteChannels == null || typeof raw.favoriteChannels !== "object") return null;

    let state: FavoritesState;
    try {
        state = clone(raw);
    } catch (e) {
        logger.error("Failed to copy favorites", e);
        return null;
    }

    Object.keys(state.favoriteChannels).forEach(id => {
        const entry: any = state.favoriteChannels[id];
        if (!/^\d+$/.test(id) || entry == null || typeof entry !== "object" || typeof entry.type !== "number") {
            delete state.favoriteChannels[id];
            return;
        }
        entry.nickname = typeof entry.nickname === "string" ? entry.nickname : "";
        entry.position = Number(entry.position) || 0;
        entry.parentId = entry.parentId ? String(entry.parentId) : NO_PARENT;
    });

    // Channels pointing at a category that no longer exists become uncategorized
    Object.values(state.favoriteChannels).forEach(entry => {
        if (entry.parentId === NO_PARENT) return;
        if (state.favoriteChannels[entry.parentId]?.type !== ENTRY_TYPE_CATEGORY) entry.parentId = NO_PARENT;
    });

    return state;
}

let cache: FavoritesState | null = null;
/** Bumped on every change so derived data can be memoized */
let version = 0;

function getState(): FavoritesState {
    if (cache == null) {
        cache = normalize(settings().data) ?? emptyState();
    }
    return cache;
}

function emitChange() {
    FavoriteStore?.emitChange();
    CategoryCollapseStore?.emitChange();
}

function writeState(next: FavoritesState) {
    cache = clone(next);
    save({ data: clone(next) });
    version++;
    emitChange();
}

/** A change made on this device: save it and upload it to the sync server */
function setState(next: FavoritesState) {
    writeState(next);
    sync.notifyLocalChange();
}

// ---------- Alerts ----------

interface ConfirmOptions {
    title: string;
    content: string;
    confirmText: string;
    onConfirm?: () => void;
    cancelText?: string;
    onCancel?: () => void;
    /** False keeps the alert open until a button is pressed */
    dismissable?: boolean;
}

let alertCount = 0;

function showConfirmationAlert({ title, content, confirmText, onConfirm, cancelText, onCancel, dismissable = true }: ConfirmOptions) {
    AlertActionCreators.openAlert(
        `${ID}.alert.${++alertCount}`,
        <AlertModal
            title={title}
            content={content}
            actions={
                <>
                    <AlertActionButton variant="primary" text={confirmText} onPress={() => onConfirm?.()} />
                    {cancelText != null && <AlertActionButton variant="secondary" text={cancelText} onPress={() => onCancel?.()} />}
                </>
            }
        />,
        undefined,
        { dismissable },
    );
}

function notify(title: string, content: string) {
    showConfirmationAlert({ title, content, confirmText: "OK" });
}

// ---------- Sync ----------

let syncStatus: SyncStatus = { state: "off" };
const syncStatusListeners = new Set<() => void>();

const sync = createSync({
    getConfig: () => ({ url: (settings().syncUrl ?? "").trim(), token: (settings().syncToken ?? "").trim() }),
    getLocal: (): SyncData => clone({ state: getState() as any, placementHistory: settings().placementHistory ?? {} }),
    applyRemote(data) {
        writeState(normalize(data.state) ?? emptyState());
        save({ placementHistory: clone(data.placementHistory ?? {}) as PlacementHistory });
    },
    loadMeta: () => settings().syncMeta ? clone(settings().syncMeta!) : null,
    saveMeta(meta) {
        save({ syncMeta: meta ? clone(meta) : null });
    },
    async request(method, url, token, body, timeoutMs = 15_000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                method,
                signal: controller.signal,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } finally {
            clearTimeout(timer);
        }
    },
    chooseFirstSync: (local, remote) => new Promise(resolve => {
        const count = (data: SyncData) => countEntries(data.state as any);
        const here = count(local), there = count(remote);
        showConfirmationAlert({
            title: "Sync favorites",
            content: `The sync server already has favorites (${there.channels} channels, ${there.categories} categories), and so does this device (${here.channels} channels, ${here.categories} categories). Which should be kept? The other copy is replaced.`,
            confirmText: "Use server's",
            onConfirm: () => resolve("server"),
            cancelText: "Upload this device's",
            onCancel: () => resolve("device"),
            dismissable: false,
        });
    }),
    onStatus(status) {
        syncStatus = status.state === "ok" ? status : { ...status, lastSync: syncStatus.lastSync };
        syncStatusListeners.forEach(listener => listener());
    },
    log: (...args) => logger.log(...args),
});

function describeSyncStatus(status: SyncStatus) {
    switch (status.state) {
        case "off": return "Off. Enter a server URL and token to sync.";
        case "syncing": return "Connecting...";
        case "ok": return `Synced${status.lastSync ? ` at ${new Date(status.lastSync).toLocaleTimeString()}` : ""}`;
        case "error": return `Error: ${status.message ?? "unknown"}`;
    }
}

function getOfficialState(): FavoritesState | null {
    return normalize(UserSettingsProtoStore?.settings?.favorites);
}

function countEntries(state: FavoritesState | null) {
    const entries = Object.values(state?.favoriteChannels ?? {});
    return {
        channels: entries.filter(e => e.type !== ENTRY_TYPE_CATEGORY).length,
        categories: entries.filter(e => e.type === ENTRY_TYPE_CATEGORY).length,
    };
}

function importOfficial(mode: "replace" | "merge") {
    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) {
        notify("Nothing to import", "Discord's official Favorites are empty.");
        return;
    }

    if (mode === "replace") {
        setState(official);
        save({ placementHistory: {} });
    } else {
        const next = clone(getState());
        const offset = Math.max(-1, ...Object.values(next.favoriteChannels).map(e => e.position)) + 1;
        Object.entries(official.favoriteChannels).forEach(([id, entry]) => {
            if (id in next.favoriteChannels) return;
            next.favoriteChannels[id] = { ...entry, position: entry.position + offset };
        });
        setState(normalize(next) ?? next);
    }

    const { channels, categories } = countEntries(getState());
    notify("Favorites imported", `Custom Favorites now has ${channels} channels in ${categories} categories.`);
}

function confirmReplaceImport(onDone?: () => void) {
    const { channels } = countEntries(getState());
    if (channels === 0) {
        importOfficial("replace");
        onDone?.();
        return;
    }

    showConfirmationAlert({
        title: "Replace your favorites?",
        content: "This replaces everything in your custom Favorites with a copy of Discord's official Favorites.",
        confirmText: "Replace",
        cancelText: "Cancel",
        onConfirm: () => {
            importOfficial("replace");
            onDone?.();
        },
    });
}

function exportToClipboard() {
    Clipboard.setString(JSON.stringify(getState()));
    notify("Favorites exported", "Your custom Favorites were copied to the clipboard as JSON.");
}

async function importFromClipboard() {
    try {
        const state = normalize(JSON.parse(await Clipboard.getString()));
        if (!state) throw new Error("Clipboard does not contain favorites");
        setState(state);
        save({ placementHistory: {} });
        notify("Favorites imported", "Your custom Favorites were replaced with the clipboard contents.");
    } catch (e) {
        logger.error("Failed to import favorites from clipboard", e);
        notify("Import failed", "The clipboard doesn't contain a valid favorites export.");
    }
}

function maybeOfferImport() {
    if (settings().offeredImport) return true;

    if (!UserSettingsProtoStore?.settings?.favorites) return false;

    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) return true;

    save({ offeredImport: true });
    if (Object.keys(getState().favoriteChannels).length > 0) return true;

    const { channels, categories } = countEntries(official);
    showConfirmationAlert({
        title: "Import your Favorites?",
        content: `CustomFavorites can copy your existing Discord Favorites (${channels} channels, ${categories} categories). You can also do this later from the plugin settings.`,
        confirmText: "Import",
        cancelText: "Not now",
        onConfirm: () => importOfficial("replace"),
    });
    return true;
}

// ---------- FavoriteStore replacement ----------

let favoritesMemo: { version: number; map: Record<string, StoreFavorite>; } | null = null;

function getFavoritesMap() {
    if (favoritesMemo?.version !== version) {
        const map: Record<string, StoreFavorite> = {};
        Object.entries(getState().favoriteChannels).forEach(([id, entry]) => {
            map[id] = {
                id,
                // Discord uses null for "no nickname"; an empty string would blank the row's name
                nickname: entry.nickname || null,
                type: entry.type,
                order: entry.position,
                parentId: entry.parentId === NO_PARENT ? null : entry.parentId,
            };
        });
        favoritesMemo = { version, map };
    }
    return favoritesMemo.map;
}

/** Any Favorites category record, used as a template for categories Discord doesn't know about */
let categoryTemplate: any = null;
let categoryRecords: { version: number; records: Record<string, any>; } = { version: -1, records: {} };

function getCategoryRecord(id: string, original: (id: string) => any) {
    if (categoryRecords.version !== version) categoryRecords = { version, records: {} };
    if (id in categoryRecords.records) return categoryRecords.records[id];

    const entry = getState().favoriteChannels[id];
    let record: any;
    if (entry?.type === ENTRY_TYPE_CATEGORY) {
        const base = original(id) ?? categoryTemplate ?? findCategoryTemplate(original) ?? buildCategoryTemplate();
        if (base) {
            categoryTemplate ??= base;
            record = base.merge({ id, name: entry.nickname, position: entry.position });
        }
    }
    // Not cached when missing: the channels it is built from may load later
    if (record) categoryRecords.records[id] = record;
    return record;
}

/** Where the category template came from, for diagnostics */
let categoryTemplateSource = "none";

function findCategoryTemplate(original: (id: string) => any) {
    const official = UserSettingsProtoStore.settings?.favorites?.favoriteChannels ?? {};
    const id = Object.keys(official).find(key => official[key]?.type === ENTRY_TYPE_CATEGORY);
    const record = id ? original(id) : null;
    if (record) categoryTemplateSource = "official category";
    return record;
}

/** Discord's channel type for categories */
const GUILD_CATEGORY = 4;

/**
 * Discord only has category records for the official Favorites, and on newer versions not until its store
 * loads them. Build one from any favorited channel instead: same record class, turned into a category.
 */
function buildCategoryTemplate() {
    const ids = Object.keys(getState().favoriteChannels);
    const channel = ids.map(channelId => getState().favoriteChannels[channelId].type === ENTRY_TYPE_CATEGORY ? null : ChannelStore.getChannel(channelId))
        .find(record => typeof record?.merge === "function");
    if (!channel) return null;
    categoryTemplateSource = "built from a channel";
    return channel.merge({ type: GUILD_CATEGORY, guild_id: FAVORITES_GUILD_ID, parent_id: null, nsfw: false, topic: null });
}

function isFavorite(id: string | null | undefined) {
    return id != null && id in getState().favoriteChannels;
}

// ---------- Placement restore for "Move to..." ----------

let moveSheetOpenedAt = 0;

const normalizeParent = (parentId: unknown) => parentId == null || parentId === NO_PARENT ? NO_PARENT : String(parentId);

/**
 * "Move to..." sends the whole new order with the moved channel last in its new category.
 * When the channel is returning to the category it last left, move it back to its old spot instead.
 */
function restorePlacement(updates: { id: string; position: number; parent_id?: string | null; }[]) {
    if (!Array.isArray(updates)) return;
    const { favoriteChannels } = getState();

    const moved = updates.filter(u => "parent_id" in u
        && favoriteChannels[u.id] != null
        && favoriteChannels[u.id].type !== ENTRY_TYPE_CATEGORY
        && normalizeParent(u.parent_id) !== favoriteChannels[u.id].parentId);
    if (moved.length !== 1) return;

    const movedId = moved[0].id;
    const target = normalizeParent(moved[0].parent_id);
    const placement = settings().placementHistory?.[movedId];
    if (placement?.parentId !== target) return;

    // The favorites as they will be after Discord's update
    const effective = clone(favoriteChannels);
    updates.forEach(u => {
        const entry = effective[u.id];
        if (!entry) return;
        entry.position = u.position;
        if ("parent_id" in u) entry.parentId = normalizeParent(u.parent_id);
    });

    const others = orderedChildren(effective, target, ENTRY_TYPE_CATEGORY).filter(id => id !== movedId);
    const index = findRestoreIndex(others, placement);
    if (index === -1) return;

    // Reuse the positions the category ends up with, in the restored order
    const positions = others.concat(movedId).map(id => effective[id].position).sort((a, b) => a - b);
    const order = others.slice();
    order.splice(index, 0, movedId);

    order.forEach((id, i) => {
        const existing = updates.find(u => u.id === id);
        if (existing) existing.position = positions[i];
        else updates.push({ id, position: positions[i] });
    });
}

// ---------- Server icons ----------

/** True inside rows of the Favorites channel list */
const FavoritesRowContext = createContext(false);

/** Size of DM avatars in the channel list, so server icons match them */
const ICON_SIZE = 20;
/** Discord's channel type icons have marginRight 8 */
const ICON_GAP = 8;

function GuildIcon({ guildId, size }: { guildId: string; size: number; }) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return null;

    // Same gap the channel type icons leave before the next item
    const style = { width: size, height: size, borderRadius: size / 2, marginRight: ICON_GAP };
    if (guild.icon) {
        const uri = IconUtils?.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: false, size: 64 });
        if (uri) return <Image source={{ uri }} style={style} accessibilityLabel={guild.name} />;
    }

    const acronym = guild.acronym ?? guild.name.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3);
    return (
        <View style={[style, { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(128,128,128,0.35)" }]}>
            <Text style={{ fontSize: size * 0.4, fontWeight: "600", color: "white" }} numberOfLines={1}>{acronym}</Text>
        </View>
    );
}

// ---------- Settings ----------

/** URL and token fields: plain text, no auto capitalization or correction */
const plainTextProps = { autoCapitalize: "none", autoCorrect: false } as object;

function SyncSection() {
    const [url, setUrl] = useState(settings().syncUrl ?? "");
    const [token, setToken] = useState(settings().syncToken ?? "");
    const [status, setStatus] = useState(syncStatus);

    useEffect(() => {
        const listener = () => setStatus(syncStatus);
        syncStatusListeners.add(listener);
        return () => { syncStatusListeners.delete(listener); };
    }, []);

    const connect = () => {
        const nextUrl = url.trim();
        if (nextUrl && !/^https?:\/\//.test(nextUrl)) {
            notify("Invalid URL", "The sync server URL must start with https:// (or http:// on a local network).");
            return;
        }
        save({ syncUrl: nextUrl, syncToken: token.trim() });
        sync.start();
    };

    return (
        <Stack spacing={12}>
            <TextInput
                label="Sync server URL"
                placeholder="https://favorites.example.com"
                value={url}
                onChange={setUrl}
                size="md"
                {...plainTextProps}
            />
            <TextInput
                label="Sync token"
                placeholder="SYNC_TOKEN from the server"
                value={token}
                onChange={setToken}
                secureTextEntry
                size="md"
                {...plainTextProps}
            />
            <TableRowGroup>
                <TableRow label="Save and sync now" subLabel={describeSyncStatus(status)} onPress={connect} arrow />
            </TableRowGroup>
        </Stack>
    );
}

function SettingsComponent() {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    const [showIcons, setShowIcons] = useState(settings().showGuildIcons !== false);
    const local = countEntries(getState());
    const official = countEntries(getOfficialState());

    return (
        <ScrollView>
            <Page>
                <Stack spacing={24}>
                    <TableRowGroup title="Status">
                        <TableRow label="Custom Favorites" subLabel={`${local.channels} channels in ${local.categories} categories`} />
                        <TableRow label="Discord's official Favorites" subLabel={`${official.channels} channels in ${official.categories} categories`} />
                    </TableRowGroup>
                    <TableRowGroup title="Display">
                        <TableSwitchRow
                            label="Show server icons"
                            subLabel="Show the server icon to the left of favorited server channels"
                            value={showIcons}
                            onValueChange={value => {
                                save({ showGuildIcons: value });
                                setShowIcons(value);
                                FavoriteStore?.emitChange();
                            }}
                        />
                    </TableRowGroup>
                    <SyncSection />
                    <TableRowGroup title="Import and export">
                        <TableRow label="Import from Discord (replace)" subLabel="Replace your custom Favorites with Discord's" onPress={() => confirmReplaceImport(forceUpdate)} arrow />
                        <TableRow label="Import from Discord (merge)" subLabel="Add Discord's Favorites you don't have yet" onPress={() => { importOfficial("merge"); forceUpdate(); }} arrow />
                        <TableRow label="Export to clipboard" subLabel="Copy your custom Favorites as JSON" onPress={exportToClipboard} arrow />
                        <TableRow label="Import from clipboard" subLabel="Replace your custom Favorites with copied JSON" onPress={() => importFromClipboard().then(forceUpdate)} arrow />
                    </TableRowGroup>
                    <TableRowGroup title="Troubleshooting">
                        <TableRow label="Copy diagnostics" subLabel="Copy a report of what the plugin found, for bug reports" onPress={copyDiagnostics} arrow />
                    </TableRowGroup>
                </Stack>
            </Page>
        </ScrollView>
    );
}

// ---------- Patches ----------


function patchFavoriteStore(cleanup: PluginCleanupApi) {
    const fixed: Record<string, (args: any[], orig: (...args: any[]) => any) => any> = {
        getFavoriteChannels: () => getFavoritesMap(),
        isFavorite: ([id]) => isFavorite(id),
        isChannelOrParentFavorited: ([id]) => isFavorite(id) || isFavorite(ChannelStore.getChannel(id)?.parent_id),
        getFavorite: ([id]) => getFavoritesMap()[id],
        getCategoryRecord: ([id], orig) => getCategoryRecord(id, orig),
        getNickname: ([id]) => getState().favoriteChannels[id]?.nickname ?? "",
        getFavoritesCount: () => Object.keys(getState().favoriteChannels).length,
        getFavoritesCountAgainstLimit: () => 0,
        hasStoredFavorites: () => Object.keys(getState().favoriteChannels).length > 0,
        favoriteGuildMuted: () => !!getState().muted,
        favoriteGuildEnabled: (args, orig) => getState().guildVisible?.value ?? orig(...args),
        autoAddJoinedThreads: () => !!getState().autoAddJoinedThreads,
    };

    diagnostics.storeMethods = { patched: [], absent: [] };
    Object.keys(fixed).forEach(name => {
        if (typeof FavoriteStore[name] !== "function") {
            diagnostics.storeMethods.absent.push(name);
            return;
        }
        diagnostics.storeMethods.patched.push(name);
        // The original comes unbound: keep the store as its `this`
        cleanup(instead(FavoriteStore, name, function (this: any, args: any[], orig: any) {
            return fixed[name](args, (...rest: any[]) => orig.apply(this, rest));
        }));
    });
}

function patchCategoryCollapseStore(cleanup: PluginCleanupApi) {
    cleanup(instead(CategoryCollapseStore, "isCollapsed", function (this: any, args: any[], orig: any) {
        const entry = getState().favoriteChannels[args[0]];
        return entry?.type === ENTRY_TYPE_CATEGORY ? !!entry.collapsed : orig.apply(this, args);
    }));

    // Newer Discord collapses Favorites categories like server categories, through these actions,
    // instead of through the favorites settings. Keep the state in the custom favorites so it syncs.
    cleanup(before(Dispatcher, "dispatch", (args: any[]) => {
        const action = args[0];
        const type: unknown = action?.type;
        if (typeof type === "string" && /FAVORITE/.test(type)) recordEvent(`dispatch ${type}`, action);
        if (typeof type !== "string" || !type.startsWith("CATEGORY_")) return args;
        try {
            handleCollapseAction(action);
        } catch (e) {
            logger.error("Failed to handle category collapse", e);
        }
        return args;
    }));

    cleanup(after(CategoryCollapseStore, "getCollapsedCategories", (ret: Record<string, boolean>) => {
        const result = { ...ret };
        Object.entries(getState().favoriteChannels).forEach(([id, entry]) => {
            if (entry.type !== ENTRY_TYPE_CATEGORY) return;
            if (entry.collapsed) result[id] = true;
            else delete result[id];
        });
        return result;
    }));
}

/** Applies a CATEGORY_COLLAPSE, CATEGORY_EXPAND or *_ALL action to the custom favorites */
function handleCollapseAction(action: any) {
    const { type } = action;
    diagnostics.collapseActions = [{ type, keys: Object.keys(action) }, ...diagnostics.collapseActions].slice(0, 5);

    const state = getState();
    let ids: string[];
    let collapsed: boolean;
    switch (type) {
        case "CATEGORY_COLLAPSE":
        case "CATEGORY_EXPAND":
            if (state.favoriteChannels[action.id]?.type !== ENTRY_TYPE_CATEGORY) return;
            ids = [action.id];
            collapsed = type === "CATEGORY_COLLAPSE";
            break;
        case "CATEGORY_COLLAPSE_ALL":
        case "CATEGORY_EXPAND_ALL":
            if (action.guildId !== FAVORITES_GUILD_ID) return;
            ids = Object.keys(state.favoriteChannels).filter(id => state.favoriteChannels[id].type === ENTRY_TYPE_CATEGORY);
            collapsed = type === "CATEGORY_COLLAPSE_ALL";
            break;
        default:
            return;
    }

    if (ids.every(id => !!state.favoriteChannels[id].collapsed === collapsed)) return;
    const next = clone(state);
    ids.forEach(id => { next.favoriteChannels[id].collapsed = collapsed; });
    setState(next);
}

function patchWrites(cleanup: PluginCleanupApi) {
    // Every favorites action writes through updateAsync("favorites", updater): keep it local instead
    whenLoaded(cleanup, "SettingsActions", withProps("PreloadedUserSettingsActionCreators"), mod => {
        cleanup(instead(mod.PreloadedUserSettingsActionCreators, "updateAsync", function (this: any, args: any[], orig: any) {
            recordEvent(`updateAsync(${String(args[0])})`);
            if (args[0] !== "favorites") return orig.apply(this, args);
            try {
                updateFavorites(args[1]);
            } catch (e) {
                logger.error("Failed to update favorites", e);
            }
            return Promise.resolve();
        }));
    });

    // The module, not the function, so its default export can be patched
    whenLoaded(cleanup, "MoveToSheet", withName("openFavoritesGuildMoveToCategoryActionSheet"), mod => {
        cleanup(before(mod, "default", (args: any[]) => {
            moveSheetOpenedAt = Date.now();
            return args;
        }));
    }, { returnNamespace: true });

    whenLoaded(cleanup, "FavoriteActions", withProps("updateFavoriteChannels", "addFavoriteChannels"), mod => {
        Object.keys(mod).forEach(name => {
            if (typeof mod[name] !== "function") return;
            cleanup(before(mod, name, (args: any[]) => {
                recordEvent(`FavoriteActions.${name}`, args);
                return args;
            }));
        });
        cleanup(before(mod, "updateFavoriteChannels", (args: any[]) => {
            const fromMoveSheet = Date.now() - moveSheetOpenedAt < MOVE_SHEET_WINDOW_MS;
            moveSheetOpenedAt = 0;
            if (!fromMoveSheet) return args;
            try {
                restorePlacement(args[0]);
            } catch (e) {
                logger.error("Failed to restore channel placement", e);
            }
            return args;
        }));
    });
}

function patchLimits(cleanup: PluginCleanupApi) {
    whenLoaded(cleanup, "FavoriteLimits", withProps("getFavoritesLimits", "useFavoritesLimitUpsell"), mod => {
        FavoriteHelpers = mod;
        cleanup(instead(mod, "getFavoritesLimits", () => ({
            favoriteLimit: Number.MAX_SAFE_INTEGER,
            canUpsellFavoriteLimit: false,
        })));
    });

    whenLoaded(cleanup, "FavoriteConstants", withProps("MAX_FAVORITE_CHANNELS", "FAVORITES_RAW_GUILD_ID"), mod => {
        const original = mod.MAX_FAVORITE_CHANNELS;
        mod.MAX_FAVORITE_CHANNELS = Number.MAX_SAFE_INTEGER;
        cleanup(() => { mod.MAX_FAVORITE_CHANNELS = original; });
    });
}

const shouldShowGuildIcon = (inFavorites: boolean, channel: any) =>
    inFavorites && !!channel?.guild_id && settings().showGuildIcons !== false;

/** Row components (memos) already patched to show server icons */
const patchedRowTypes = new Set<any>();

/**
 * Text-like rows (TextChannel and friends) render their own icon row: View > [TypeIcon, Text, ChannelInfo].
 * Patch each such row component the first time the Favorites list renders it.
 */
function patchRowType(cleanup: PluginCleanupApi, type: any) {
    if (patchedRowTypes.has(type) || typeof type?.type !== "function") return;
    patchedRowTypes.add(type);

    cleanup(instead(type, "type", function (this: any, args: any[], orig: any) {
        const ret = orig.apply(this, args);
        // Hook called on every render, before any early return, to keep hook order stable
        const inFavorites = useContext(FavoritesRowContext);
        const channel = args[0]?.channel;
        if (!shouldShowGuildIcon(inFavorites, channel) || ret == null) return ret;

        const row = findInReactFiber(ret as ReactElement, (node: any) =>
            Array.isArray(node?.props?.children)
            && node.props.children.some((child: any) => child?.props != null && "isChannelSelected" in child.props)) as any;
        if (!row) return ret;

        row.props.children = [<GuildIcon key="cf-guild-icon" guildId={channel.guild_id} size={ICON_SIZE} />, ...row.props.children];
        return ret;
    }));
}

function patchGuildIcons(cleanup: PluginCleanupApi) {
    whenLoaded(cleanup, "IconUtils", withProps("getGuildIconURL"), mod => { IconUtils = mod; });

    whenLoaded(cleanup, "ChannelListItems", withProps("renderChannelListItem"), mod => {
        cleanup(instead(mod, "renderChannelListItem", function (this: any, args: any[], orig: any) {
            const ret = orig.apply(this, args);
            if (args[0]?.guild?.id !== FAVORITES_GUILD_ID || ret == null) return ret;

            // Text channels with threads come as a fragment of [channel row, thread rows...]
            const rows = Array.isArray(ret.props?.children) ? ret.props.children : [ret];
            rows.forEach((row: any) => {
                if (row?.props?.channel?.guild_id) patchRowType(cleanup, row.type);
            });

            return <FavoritesRowContext.Provider key={ret.key} value={true}>{ret}</FavoritesRowContext.Provider>;
        }));
    });

    // Voice rows render through BaseChannelItem, which takes the type icon as a prop
    whenLoaded(cleanup, "BaseChannelItem", withProps("BaseChannelIcon", "default"), mod => {
        cleanup(before(mod, "default", (args: any[]) => {
            // Hook called on every render, before any early return, to keep hook order stable
            const inFavorites = useContext(FavoritesRowContext);
            const props = args[0];
            const channel = props?.icon?.props?.channel;
            if (!shouldShowGuildIcon(inFavorites, channel) || props.hideIcon) return args;

            args[0] = {
                ...props,
                icon: (
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <GuildIcon guildId={channel.guild_id} size={ICON_SIZE} />
                        {props.icon}
                    </View>
                ),
            };
            return args;
        }));
    });
    cleanup(() => patchedRowTypes.clear());
}

function updateFavorites(updater: (draft: FavoritesState) => boolean | void) {
    const before = getState();
    const draft = clone(before);
    draft.favoriteChannels ??= {};
    try {
        if (updater(draft) === false) {
            recordEvent("updater returned false");
            return;
        }
    } catch (e) {
        recordEvent(`updater threw: ${e instanceof Error ? `${e.message} ${String(e.stack ?? "").split("\n").slice(0, 3).join(" | ")}` : String(e)}`);
        throw e;
    }
    const changed = Object.keys({ ...before.favoriteChannels, ...draft.favoriteChannels })
        .filter(id => JSON.stringify(before.favoriteChannels[id]) !== JSON.stringify(draft.favoriteChannels[id]));
    recordEvent(`updater changed ${changed.length}`, changed.slice(0, 3).map(id => ({ id, before: before.favoriteChannels[id], after: draft.favoriteChannels[id] })));

    try {
        const history = updatePlacementHistory(
            clone(settings().placementHistory ?? {}),
            before.favoriteChannels,
            draft.favoriteChannels,
            ENTRY_TYPE_CATEGORY,
            NO_PARENT
        );
        if (history) save({ placementHistory: history });
    } catch (e) {
        logger.error("Failed to update placement history", e);
    }

    setState(draft);
}

// ---------- Lifecycle ----------

export default plugin<{ jsonStorage: Settings; }>({
    jsonStorage: {
        load: true,
        default: DefaultSettings,
    },

    async start({ cleanup, jsonStorage: storage, logger: pluginLogger, plugin: self }) {
        const baseLogger = pluginLogger ?? console;
        logger = {
            log: (...args: any[]) => baseLogger.log(...args),
            error: (...args: any[]) => {
                recordEvent(`error: ${args.map(a => a instanceof Error ? a.message : String(a)).join(" ")}`);
                baseLogger.error(...args);
            },
        };
        const manifestVersion: any = self?.manifest?.version;
        diagnostics.version = typeof manifestVersion === "string" ? manifestVersion
            : Array.isArray(manifestVersion?.nums) ? manifestVersion.nums.join(".") + (manifestVersion.label ? `-${manifestVersion.label}` : "") : "unknown";
        diagnostics.patches = {};
        jsonStorage = storage;
        // load: true starts reading without waiting; the favorites must be in memory before Discord asks for them
        if (!storage.loaded) await storage.get();

        diagnostics.modules = {};
        lookupStores();
        // Newer Discord fills its favorites store lazily; its category records serve as templates
        try {
            FavoriteStore.initializeIfNeeded?.();
        } catch (e) {
            logger.error("Failed to initialize FavoriteStore", e);
        }
        diagnostics.originalStore = (() => {
            try {
                const entries = Object.values(FavoriteStore.getFavoriteChannels() ?? {});
                return { count: entries.length, sample: entries.slice(0, 2) };
            } catch (e) {
                return `threw: ${e instanceof Error ? e.message : String(e)}`;
            }
        })();

        const steps: [string, (cleanup: PluginCleanupApi) => void][] = [
            ["store", patchFavoriteStore],
            ["collapse", patchCategoryCollapseStore],
            ["writes", patchWrites],
            ["limits", patchLimits],
            ["icons", patchGuildIcons],
        ];
        steps.forEach(([name, apply]) => {
            try {
                apply(cleanup);
                diagnostics.patches[name] = "ok";
            } catch (e) {
                diagnostics.patches[name] = e instanceof Error ? e.message : String(e);
                logger.error(`Failed to apply ${name} patches`, e);
            }
        });

        cache = null;
        version++;
        emitChange();
        sync.start();

        // Discord's settings may not be loaded yet when plugins start
        if (!maybeOfferImport()) {
            const listener = () => {
                if (maybeOfferImport()) UserSettingsProtoStore.removeChangeListener(listener);
            };
            UserSettingsProtoStore.addChangeListener(listener);
            cleanup(() => UserSettingsProtoStore.removeChangeListener(listener));
        }
    },

    stop() {
        sync.stop();
        cache = null;
        version++;
        // Patches are undone by the cleanups after this; refresh once they are gone
        setTimeout(emitChange, 0);
    },

    SettingsComponent,
});

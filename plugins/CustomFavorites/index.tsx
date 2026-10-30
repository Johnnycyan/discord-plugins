/*
 * CustomFavorites for Kettu (Vendetta-compatible plugin)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findRestoreIndex, orderedChildren, PlacementHistory, updatePlacementHistory } from "./placement";

declare const vendetta: any;

// Kettu evals plugins with Hermes, where let/const in loops are function scoped:
// never close over a loop variable, use array methods instead.

const { metro, patcher, plugin, ui, logger } = vendetta;
const { React, ReactNative: RN, clipboard } = metro.common;
const { Forms } = ui.components;
const { showConfirmationAlert } = ui.alerts;

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

interface PluginStorage {
    data?: FavoritesState | null;
    placementHistory?: PlacementHistory;
    offeredImport?: boolean;
    showGuildIcons?: boolean;
}

const storage: PluginStorage = plugin.storage;
storage.showGuildIcons ??= true;

const FavoriteStore = metro.findByStoreName("FavoriteStore");
const CategoryCollapseStore = metro.findByStoreName("CategoryCollapseStore");
const UserSettingsProtoStore = metro.findByStoreName("UserSettingsProtoStore");
const GuildStore = metro.findByStoreName("GuildStore");
const ChannelStore = metro.findByStoreName("ChannelStore");

const SettingsActions = metro.findByProps("PreloadedUserSettingsActionCreators").PreloadedUserSettingsActionCreators;
const FavoriteActions = metro.findByProps("updateFavoriteChannels", "addFavoriteChannels");
const FavoriteLimits = metro.findByProps("getFavoritesLimits", "useFavoritesLimitUpsell");
const FavoriteConstants = metro.findByProps("MAX_FAVORITE_CHANNELS", "FAVORITES_RAW_GUILD_ID");
const MoveToSheet = metro.findByName("openFavoritesGuildMoveToCategoryActionSheet", false);
const ChannelListItems = metro.findByProps("renderChannelListItem");
const BaseChannelItem = metro.findByProps("BaseChannelIcon", "default");
const IconUtils = metro.findByProps("getGuildIconURL");

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
        cache = normalize(storage.data) ?? emptyState();
    }
    return cache;
}

function setState(next: FavoritesState) {
    cache = clone(next);
    storage.data = clone(next);
    version++;
    FavoriteStore.emitChange();
    CategoryCollapseStore.emitChange();
}

function getOfficialState(): FavoritesState | null {
    return normalize(UserSettingsProtoStore.settings?.favorites);
}

function countEntries(state: FavoritesState | null) {
    const entries = Object.values(state?.favoriteChannels ?? {});
    return {
        channels: entries.filter(e => e.type !== ENTRY_TYPE_CATEGORY).length,
        categories: entries.filter(e => e.type === ENTRY_TYPE_CATEGORY).length,
    };
}

/** Plain message box; Kettu's toasts crash Discord 351 */
function notify(title: string, content: string) {
    showConfirmationAlert({ title, content, confirmText: "OK", onConfirm: () => { } });
}

function importOfficial(mode: "replace" | "merge") {
    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) {
        notify("Nothing to import", "Discord's official Favorites are empty.");
        return;
    }

    if (mode === "replace") {
        setState(official);
        storage.placementHistory = {};
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
    clipboard.setString(JSON.stringify(getState()));
    notify("Favorites exported", "Your custom Favorites were copied to the clipboard as JSON.");
}

async function importFromClipboard() {
    try {
        const state = normalize(JSON.parse(await clipboard.getString()));
        if (!state) throw new Error("Clipboard does not contain favorites");
        setState(state);
        storage.placementHistory = {};
        notify("Favorites imported", "Your custom Favorites were replaced with the clipboard contents.");
    } catch (e) {
        logger.error("Failed to import favorites from clipboard", e);
        notify("Import failed", "The clipboard doesn't contain a valid favorites export.");
    }
}

function maybeOfferImport() {
    if (storage.offeredImport) return true;

    const settings = UserSettingsProtoStore.settings;
    if (!settings?.favorites) return false;

    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) return true;

    storage.offeredImport = true;
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
        const base = original(id) ?? categoryTemplate ?? findCategoryTemplate(original);
        if (base) {
            categoryTemplate ??= base;
            record = base.merge({ id, name: entry.nickname, position: entry.position });
        }
    }
    categoryRecords.records[id] = record;
    return record;
}

function findCategoryTemplate(original: (id: string) => any) {
    const official = UserSettingsProtoStore.settings?.favorites?.favoriteChannels ?? {};
    const id = Object.keys(official).find(key => official[key]?.type === ENTRY_TYPE_CATEGORY);
    return id ? original(id) : null;
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
    const placement = storage.placementHistory?.[movedId];
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
const FavoritesRowContext = React.createContext(false);

function GuildIcon({ guildId, size }: { guildId: string; size: number; }) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return null;

    // Same gap the channel type icons leave before the next item
    const style = { width: size, height: size, borderRadius: size / 2, marginRight: ICON_GAP };
    if (guild.icon) {
        const uri = IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: false, size: 64 });
        if (uri) return <RN.Image source={{ uri }} style={style} accessibilityLabel={guild.name} />;
    }

    const acronym = guild.acronym ?? guild.name.split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3);
    return (
        <RN.View style={[style, { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(128,128,128,0.35)" }]}>
            <RN.Text style={{ fontSize: size * 0.4, fontWeight: "600", color: "white" }} numberOfLines={1}>{acronym}</RN.Text>
        </RN.View>
    );
}

/** Size of DM avatars in the channel list, so server icons match them */
const ICON_SIZE = 20;
/** Discord's channel type icons have marginRight 8 */
const ICON_GAP = 8;

// ---------- Settings ----------

function SettingsPage() {
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
    const [showIcons, setShowIcons] = React.useState(storage.showGuildIcons !== false);
    const local = countEntries(getState());
    const official = countEntries(getOfficialState());

    return (
        <RN.ScrollView style={{ flex: 1 }}>
            <Forms.FormSection title="Status">
                <Forms.FormText style={{ padding: 16 }}>
                    {`Custom Favorites: ${local.channels} channels in ${local.categories} categories.\nDiscord's official Favorites: ${official.channels} channels in ${official.categories} categories.`}
                </Forms.FormText>
            </Forms.FormSection>
            <Forms.FormSection title="Display">
                <Forms.FormSwitchRow
                    label="Show server icons"
                    subLabel="Show the server icon to the left of favorited server channels"
                    value={showIcons}
                    onValueChange={(value: boolean) => {
                        storage.showGuildIcons = value;
                        setShowIcons(value);
                        FavoriteStore.emitChange();
                    }}
                />
            </Forms.FormSection>
            <Forms.FormSection title="Import and export">
                <Forms.FormRow label="Import from Discord (replace)" subLabel="Replace your custom Favorites with Discord's" onPress={() => confirmReplaceImport(forceUpdate)} />
                <Forms.FormRow label="Import from Discord (merge)" subLabel="Add Discord's Favorites you don't have yet" onPress={() => { importOfficial("merge"); forceUpdate(); }} />
                <Forms.FormRow label="Export to clipboard" subLabel="Copy your custom Favorites as JSON" onPress={exportToClipboard} />
                <Forms.FormRow label="Import from clipboard" subLabel="Replace your custom Favorites with copied JSON" onPress={() => importFromClipboard().then(forceUpdate)} />
            </Forms.FormSection>
        </RN.ScrollView>
    );
}

// ---------- Lifecycle ----------

let unpatches: (() => void)[] = [];
let originalMaxFavorites: number | undefined;

function patchFavoriteStore() {
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

    Object.keys(fixed).forEach(name => {
        if (typeof FavoriteStore[name] !== "function") return;
        unpatches.push(patcher.instead(name, FavoriteStore, (args: any[], orig: any) => fixed[name](args, orig)));
    });
}

function patchCategoryCollapseStore() {
    unpatches.push(patcher.instead("isCollapsed", CategoryCollapseStore, (args: any[], orig: any) => {
        const entry = getState().favoriteChannels[args[0]];
        return entry?.type === ENTRY_TYPE_CATEGORY ? !!entry.collapsed : orig(...args);
    }));

    unpatches.push(patcher.after("getCollapsedCategories", CategoryCollapseStore, (_: any[], ret: Record<string, boolean>) => {
        const result = { ...ret };
        Object.entries(getState().favoriteChannels).forEach(([id, entry]) => {
            if (entry.type !== ENTRY_TYPE_CATEGORY) return;
            if (entry.collapsed) result[id] = true;
            else delete result[id];
        });
        return result;
    }));
}

function patchWrites() {
    // Every favorites action writes through updateAsync("favorites", updater): keep it local instead
    unpatches.push(patcher.instead("updateAsync", SettingsActions, (args: any[], orig: any) => {
        if (args[0] !== "favorites") return orig(...args);
        try {
            updateFavorites(args[1]);
        } catch (e) {
            logger.error("Failed to update favorites", e);
        }
        return Promise.resolve();
    }));

    unpatches.push(patcher.before("default", MoveToSheet, () => {
        moveSheetOpenedAt = Date.now();
    }));

    unpatches.push(patcher.before("updateFavoriteChannels", FavoriteActions, (args: any[]) => {
        const fromMoveSheet = Date.now() - moveSheetOpenedAt < MOVE_SHEET_WINDOW_MS;
        moveSheetOpenedAt = 0;
        if (!fromMoveSheet) return;
        try {
            restorePlacement(args[0]);
        } catch (e) {
            logger.error("Failed to restore channel placement", e);
        }
    }));
}

function patchLimits() {
    unpatches.push(patcher.instead("getFavoritesLimits", FavoriteLimits, () => ({
        favoriteLimit: Number.MAX_SAFE_INTEGER,
        canUpsellFavoriteLimit: false,
    })));

    originalMaxFavorites = FavoriteConstants.MAX_FAVORITE_CHANNELS;
    FavoriteConstants.MAX_FAVORITE_CHANNELS = Number.MAX_SAFE_INTEGER;
}

const shouldShowGuildIcon = (inFavorites: boolean, channel: any) =>
    inFavorites && !!channel?.guild_id && storage.showGuildIcons !== false;

/** Row components (memos) already patched to show server icons */
const patchedRowTypes = new Set<any>();

/**
 * Text-like rows (TextChannel and friends) render their own icon row: View > [TypeIcon, Text, ChannelInfo].
 * Patch each such row component the first time the Favorites list renders it.
 */
function patchRowType(type: any) {
    if (patchedRowTypes.has(type) || typeof type?.type !== "function") return;
    patchedRowTypes.add(type);

    unpatches.push(patcher.after("type", type, (args: any[], ret: any) => {
        // Hook called on every render, before any early return, to keep hook order stable
        const inFavorites = React.useContext(FavoritesRowContext);
        const channel = args[0]?.channel;
        if (!shouldShowGuildIcon(inFavorites, channel)) return ret;

        const row = vendetta.utils.findInReactTree(ret, (node: any) =>
            Array.isArray(node?.props?.children)
            && node.props.children.some((child: any) => child?.props != null && "isChannelSelected" in child.props));
        if (!row) return ret;

        row.props.children = [<GuildIcon key="cf-guild-icon" guildId={channel.guild_id} size={ICON_SIZE} />, ...row.props.children];
        return ret;
    }));
}

function patchGuildIcons() {
    unpatches.push(patcher.after("renderChannelListItem", ChannelListItems, (args: any[], ret: any) => {
        if (args[0]?.guild?.id !== FAVORITES_GUILD_ID || ret == null) return ret;

        // Text channels with threads come as a fragment of [channel row, thread rows...]
        const rows = Array.isArray(ret.props?.children) ? ret.props.children : [ret];
        rows.forEach((row: any) => {
            if (row?.props?.channel?.guild_id) patchRowType(row.type);
        });

        return <FavoritesRowContext.Provider key={ret.key} value={true}>{ret}</FavoritesRowContext.Provider>;
    }));

    // Voice rows render through BaseChannelItem, which takes the type icon as a prop
    unpatches.push(patcher.before("default", BaseChannelItem, (args: any[]) => {
        // Hook called on every render, before any early return, to keep hook order stable
        const inFavorites = React.useContext(FavoritesRowContext);
        const props = args[0];
        const channel = props?.icon?.props?.channel;
        if (!shouldShowGuildIcon(inFavorites, channel) || props.hideIcon) return;

        args[0] = {
            ...props,
            icon: (
                <RN.View style={{ flexDirection: "row", alignItems: "center" }}>
                    <GuildIcon guildId={channel.guild_id} size={ICON_SIZE} />
                    {props.icon}
                </RN.View>
            ),
        };
    }));
}

function updateFavorites(updater: (draft: FavoritesState) => boolean | void) {
    const before = getState();
    const draft = clone(before);
    draft.favoriteChannels ??= {};
    if (updater(draft) === false) return;

    try {
        const history = updatePlacementHistory(
            clone(storage.placementHistory ?? {}),
            before.favoriteChannels,
            draft.favoriteChannels,
            ENTRY_TYPE_CATEGORY,
            NO_PARENT
        );
        if (history) storage.placementHistory = history;
    } catch (e) {
        logger.error("Failed to update placement history", e);
    }

    setState(draft);
}

let stopWaitingForSettings: (() => void) | null = null;

export default {
    onLoad() {
        const steps: [string, () => void][] = [
            ["store", patchFavoriteStore],
            ["collapse", patchCategoryCollapseStore],
            ["writes", patchWrites],
            ["limits", patchLimits],
            ["icons", patchGuildIcons],
        ];
        steps.forEach(([name, apply]) => {
            try {
                apply();
            } catch (e) {
                logger.error(`Failed to apply ${name} patches`, e);
            }
        });

        version++;
        FavoriteStore.emitChange();
        CategoryCollapseStore.emitChange();

        // Discord's settings may not be loaded yet when plugins start
        if (!maybeOfferImport()) {
            const listener = () => {
                if (maybeOfferImport()) stopWaitingForSettings?.();
            };
            UserSettingsProtoStore.addChangeListener(listener);
            stopWaitingForSettings = () => {
                UserSettingsProtoStore.removeChangeListener(listener);
                stopWaitingForSettings = null;
            };
        }
    },

    onUnload() {
        stopWaitingForSettings?.();
        unpatches.forEach(unpatch => unpatch());
        unpatches = [];
        patchedRowTypes.clear();
        if (originalMaxFavorites != null) FavoriteConstants.MAX_FAVORITE_CHANNELS = originalMaxFavorites;
        cache = null;
        version++;
        FavoriteStore.emitChange();
        CategoryCollapseStore.emitChange();
    },

    settings: SettingsPage,
};

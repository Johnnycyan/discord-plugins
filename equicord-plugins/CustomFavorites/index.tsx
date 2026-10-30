/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { getGuildAcronym } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { chooseFile, saveFile } from "@utils/web";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Guild } from "@vencord/discord-types";
import { findCssClassesLazy, findStoreLazy } from "@webpack";
import { Alerts, GuildStore, IconUtils, React, SelectedGuildStore, showToast, Tooltip, UserStore, useStateFromStores } from "@webpack/common";

import { findRestoreIndex, PlacementHistory, updatePlacementHistory } from "../../shared/CustomFavorites/placement";
import { createSync, SyncData, SyncMeta, SyncStatus } from "../../shared/CustomFavorites/sync";
import managedStyle from "./style.css?managed";

const logger = new Logger("CustomFavorites");

/** Id of Discord's Favorites pseudo-guild */
const FAVORITES_GUILD_ID = "373";
/** What SelectedGuildStore reports while the Favorites page is open */
const FAVORITES_ROUTE_ID = "@favorites";
/** Favorite entry type for categories in Discord's favorites proto (channels and DMs are 1) */
const ENTRY_TYPE_CATEGORY = 2;
/** parentId used by Discord for "no category" */
const NO_PARENT = "0";
/** Id Discord's channel list uses for the uncategorized section */
const UNCATEGORIZED_LIST_ID = "null";

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

const UserSettingsProtoStore = findStoreLazy("UserSettingsProtoStore");
/** Discord's channel row icon classes, the same ones DM avatars use for their size */
const ChannelIconClasses = findCssClassesLazy("iconContainer", "icon", "linkTop");

const settings = definePluginSettings({
    showGuildIcons: {
        type: OptionType.BOOLEAN,
        description: "Show the server icon to the left of favorited server channels",
        default: true,
    },
    manage: {
        type: OptionType.COMPONENT,
        component: () => <ManageSection />,
    },
    syncUrl: {
        type: OptionType.STRING,
        description: "Sync server URL (self-hosted, see the sync-server folder). Leave empty to not sync.",
        default: "",
        placeholder: "https://favorites.example.com",
        onChange: () => restartSyncSoon(),
    },
    syncToken: {
        type: OptionType.STRING,
        description: "Sync server token (the server's SYNC_TOKEN)",
        default: "",
        onChange: () => restartSyncSoon(),
    },
    syncStatus: {
        type: OptionType.COMPONENT,
        component: () => <SyncStatusSection />,
    },
    data: {
        type: OptionType.CUSTOM,
        description: "Stored favorites",
        default: null as FavoritesState | null,
        hidden: true,
    },
    placementHistory: {
        type: OptionType.CUSTOM,
        description: "The spot each channel had in the category it last left",
        default: {} as PlacementHistory,
        hidden: true,
    },
    offeredImport: {
        type: OptionType.CUSTOM,
        description: "Whether the one-time import prompt has been shown",
        default: false,
        hidden: true,
    },
    syncMeta: {
        type: OptionType.CUSTOM,
        description: "Last state synced with the sync server",
        default: null as SyncMeta | null,
        hidden: true,
    },
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const emptyState = (): FavoritesState => ({
    favoriteChannels: {},
    muted: false,
    autoAddJoinedThreads: false,
});

/** Validates and cleans a favorites object (from Discord, a file, or storage). Returns null if unusable. */
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
        const parent = state.favoriteChannels[entry.parentId];
        if (parent?.type !== ENTRY_TYPE_CATEGORY) entry.parentId = NO_PARENT;
    }

    return state;
}

let cache: FavoritesState | null = null;

/** Read by Discord's FavoriteStore and CategoryCollapseStore in place of the synced settings proto */
function getState(): FavoritesState {
    if (cache == null) {
        cache = normalize(settings.plain?.data) ?? emptyState();
    }
    return cache;
}

function writeState(next: FavoritesState) {
    cache = clone(next);
    settings.store.data = clone(next);
    // Both stores sync with UserSettingsProtoStore, so poking it makes them re-read getState()
    UserSettingsProtoStore.emitChange();
}

/** A change made on this device: save it and upload it to the sync server */
function setState(next: FavoritesState) {
    writeState(next);
    sync.notifyLocalChange();
}

// ---------- Sync ----------

let syncStatus: SyncStatus = { state: "off" };
const syncStatusListeners = new Set<() => void>();
let restartTimer: ReturnType<typeof setTimeout> | undefined;

const getSyncConfig = () => ({ url: settings.store.syncUrl.trim(), token: settings.store.syncToken.trim() });

function setSyncStatus(status: SyncStatus) {
    syncStatus = status.state === "ok" ? status : { ...status, lastSync: syncStatus.lastSync };
    syncStatusListeners.forEach(listener => listener());
}

const sync = createSync({
    getConfig: getSyncConfig,
    getLocal: (): SyncData => clone({ state: getState() as any, placementHistory: settings.plain.placementHistory ?? {} }),
    applyRemote(data) {
        writeState(normalize(data.state) ?? emptyState());
        settings.store.placementHistory = clone(data.placementHistory ?? {}) as PlacementHistory;
    },
    loadMeta: () => settings.plain.syncMeta ? clone(settings.plain.syncMeta) : null,
    saveMeta(meta) {
        settings.store.syncMeta = meta ? clone(meta) : null;
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
    chooseFirstSync: (local, remote) => new Promise((resolve, reject) => {
        const here = countEntries(local.state as any), there = countEntries(remote.state as any);
        let answered = false;
        Alerts.show({
            title: "Sync favorites",
            body: `The sync server already has favorites (${there.channels} channels, ${there.categories} categories), and so does this device (${here.channels} channels, ${here.categories} categories). Which should be kept? The other copy is replaced.`,
            confirmText: "Use server's",
            cancelText: "Upload this device's",
            onConfirm: () => { answered = true; resolve("server"); },
            onCancel: () => { answered = true; resolve("device"); },
            onCloseCallback: () => {
                if (answered) return;
                // Closed without choosing: pause until the user resumes from the settings
                sync.stop();
                reject(new Error("Paused: choose which favorites to keep (Sync now in the plugin settings)"));
            },
        });
    }),
    onStatus: setSyncStatus,
    log: (...args) => logger.info(...args),
});

/** Discord desktop's CSP blocks unknown servers; Equicord can allow one after the user approves it */
async function isServerAllowed(url: string) {
    if (IS_WEB) return true;
    if (await VencordNative.csp.isDomainAllowed(url, ["connect-src"])) return true;

    const result = await VencordNative.csp.requestAddOverride(url, ["connect-src"], "CustomFavorites");
    setSyncStatus({
        state: "error",
        message: result === "ok"
            ? "Restart Discord so it can connect to the sync server"
            : "Discord isn't allowed to connect to the sync server",
    });
    return false;
}

async function startSync() {
    sync.stop();
    const { url, token } = getSyncConfig();
    if (!url || !token) {
        setSyncStatus({ state: "off" });
        return;
    }
    if (!/^https?:\/\//.test(url)) {
        setSyncStatus({ state: "error", message: "The URL must start with https://" });
        return;
    }
    try {
        if (!await isServerAllowed(url)) return;
    } catch (e) {
        logger.error("Failed to check the sync server's CSP rule", e);
    }
    sync.start();
}

function restartSyncSoon() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startSync, 1500);
}

function describeSyncStatus(status: SyncStatus) {
    switch (status.state) {
        case "off": return "Off. Enter a server URL and token to sync.";
        case "syncing": return "Connecting...";
        case "ok": return `Synced${status.lastSync ? ` at ${new Date(status.lastSync).toLocaleTimeString()}` : ""}`;
        case "error": return `Error: ${status.message ?? "unknown"}`;
    }
}

function SyncStatusSection() {
    const [status, setStatus] = React.useState(syncStatus);
    React.useEffect(() => {
        const listener = () => setStatus(syncStatus);
        syncStatusListeners.add(listener);
        return () => void syncStatusListeners.delete(listener);
    }, []);

    return (
        <div className="vc-cf-manage">
            <Paragraph>Sync: {describeSyncStatus(status)}</Paragraph>
            <div className="vc-cf-buttons">
                <Button variant="secondary" onClick={startSync}>Sync now</Button>
            </div>
        </div>
    );
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

function importOfficial(mode: "replace" | "merge") {
    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) {
        showToast({ text: "Discord's official Favorites are empty, nothing to import", variant: "default" });
        return;
    }

    if (mode === "replace") {
        setState(official);
        settings.store.placementHistory = {};
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
    showToast({ text: `Imported favorites: ${channels} channels, ${categories} categories`, variant: "success" });
}

function confirmReplaceImport(onDone?: () => void) {
    const { channels } = countEntries(getState());
    if (channels === 0) {
        importOfficial("replace");
        onDone?.();
        return;
    }

    Alerts.show({
        title: "Replace your favorites?",
        body: "This replaces everything in your custom Favorites with a copy of Discord's official Favorites.",
        confirmText: "Replace",
        cancelText: "Cancel",
        onConfirm: () => {
            importOfficial("replace");
            onDone?.();
        },
    });
}

function exportFile() {
    const json = JSON.stringify(getState(), null, 2);
    saveFile(new File([json], "custom-favorites.json", { type: "application/json" }));
}

async function importFile() {
    const file = await chooseFile("application/json");
    if (!file) return;

    try {
        const state = normalize(JSON.parse(await file.text()));
        if (!state) throw new Error("File does not contain favorites");
        setState(state);
        settings.store.placementHistory = {};
        showToast({ text: "Favorites imported from file", variant: "success" });
    } catch (e) {
        logger.error("Failed to import favorites file", e);
        showToast({ text: "That file isn't a valid favorites export", variant: "critical" });
    }
}

function maybeOfferImport() {
    if (settings.store.offeredImport) return;

    const official = getOfficialState();
    if (!official || Object.keys(official.favoriteChannels).length === 0) return;

    settings.store.offeredImport = true;
    if (Object.keys(getState().favoriteChannels).length > 0) return;

    const { channels, categories } = countEntries(official);
    Alerts.show({
        title: "Import your Favorites?",
        body: `CustomFavorites can copy your existing Discord Favorites (${channels} channels, ${categories} categories). You can also do this later from the plugin settings.`,
        confirmText: "Import",
        cancelText: "Not now",
        onConfirm: () => importOfficial("replace"),
    });
}

function ManageSection() {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const local = countEntries(getState());
    const official = countEntries(getOfficialState());

    return (
        <div className="vc-cf-manage">
            <Paragraph>
                Custom Favorites: {local.channels} channels in {local.categories} categories.
                Discord's official Favorites: {official.channels} channels in {official.categories} categories.
            </Paragraph>
            <div className="vc-cf-buttons">
                <Button onClick={() => confirmReplaceImport(forceUpdate)}>
                    Import from Discord (replace)
                </Button>
                <Button variant="secondary" onClick={() => { importOfficial("merge"); forceUpdate(); }}>
                    Import from Discord (merge)
                </Button>
                <Button variant="secondary" onClick={exportFile}>
                    Export to file
                </Button>
                <Button variant="secondary" onClick={() => importFile().then(forceUpdate)}>
                    Import from file
                </Button>
            </div>
        </div>
    );
}

const GuildIcon = ErrorBoundary.wrap(({ guildId, inFavoritesList }: { guildId: string; inFavoritesList: boolean; }) => {
    const { showGuildIcons } = settings.use(["showGuildIcons"]);
    const guild = useStateFromStores([GuildStore], () => GuildStore.getGuild(guildId));
    const viewingFavorites = useStateFromStores([SelectedGuildStore], () => SelectedGuildStore.getGuildId() === FAVORITES_ROUTE_ID);
    if (!showGuildIcons || !guild || !(inFavoritesList || viewingFavorites)) return null;

    const src = guild.icon
        ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: false, size: 32 })
        : null;

    return (
        <Tooltip text={guild.name} delay={500}>
            {props => (
                <div {...props} className={ChannelIconClasses.iconContainer}>
                    {src
                        ? <img className={`${ChannelIconClasses.icon} vc-cf-guild-icon`} src={src} alt="" />
                        : <div className={`${ChannelIconClasses.icon} vc-cf-guild-icon vc-cf-guild-acronym`}>{getGuildAcronym(guild)}</div>
                    }
                </div>
            )}
        </Tooltip>
    );
}, { noop: true });

export default definePlugin({
    name: "CustomFavorites",
    description: "Replaces Discord's Favorites with a local, unlimited version, with server icons and import from the official Favorites",
    authors: [{ name: "Johnnycyan", id: 258020906805362688n }],
    settings,
    managedStyle,

    patches: [
        {
            // All favorites actions (add, remove, move, rename, collapse, reset...) write through one helper
            find: 'updateAsync("favorites"',
            replacement: [
                {
                    // Write to our local store instead of Discord's synced settings
                    match: /return \i\.\i\.updateAsync\("favorites",(\i),[^)]+\)/,
                    replace: "return $self.updateFavorites($1)"
                },
                {
                    // Remove the 3 (free) and 200 (Nitro) favorites limits, keeping Discord's cleanup of stale entries
                    match: /(function \i\((\i),\i\)\{)(if\((\i)\(\2\),)/,
                    replace: "$1return $4($2),null;$3"
                }
            ]
        },
        {
            find: 'displayName="FavoriteStore"',
            replacement: [
                {
                    match: /\i\.\i\.settings\.favorites/,
                    replace: "$self.getState()"
                },
                {
                    // Stops the "Need more Favorites?" upsell
                    match: /(?<=getFavoritesCountAgainstLimit\(\)\{return )\i/,
                    replace: "0"
                }
            ]
        },
        {
            // Collapsed state of favorites categories
            find: 'displayName="CategoryCollapseStore"',
            replacement: {
                match: /\i\.\i\.settings\.favorites/,
                replace: "$self.getState()"
            }
        },
        {
            // "Move to > Category" builds the destination category's order, then puts the channel last.
            // Put it back where it was instead when it is returning to the category it last left.
            find: 'return[];"first"===',
            replacement: {
                match: /(let (\i)=\i\[(\i)\];if\(null==\2\)return\[\];)("first"===(\i)\?\2\.unshift\((\i)\):\2\.push\(\6\))/,
                replace: "$1$self.restorePlacement($2,$6,$3,$5)||($4)"
            }
        },
        {
            // Sidebar channel row, insert the server icon before the channel type icon
            find: '"ChannelItemIcon"',
            replacement: {
                match: /(?=\(0,\i\.jsxs?\)\(\i,\{className:\i,tooltipText:\i,channel:(\i),guild:(\i),hasUsersInVoiceChannel:)/,
                replace: "$self.renderGuildIcon($1,$2),"
            }
        }
    ],

    flux: {
        POST_CONNECTION_OPEN: maybeOfferImport,
    },

    start() {
        if (UserStore.getCurrentUser()) maybeOfferImport();
        startSync();
    },

    stop() {
        clearTimeout(restartTimer);
        sync.stop();
    },

    getState,

    async updateFavorites(updater: (draft: FavoritesState) => boolean | void) {
        const before = getState();
        const draft = clone(before);
        draft.favoriteChannels ??= {};
        if (updater(draft) === false) return;

        try {
            const history = updatePlacementHistory(
                clone(settings.plain.placementHistory ?? {}),
                before.favoriteChannels,
                draft.favoriteChannels,
                ENTRY_TYPE_CATEGORY,
                NO_PARENT
            );
            if (history) settings.store.placementHistory = history;
        } catch (e) {
            logger.error("Failed to update placement history", e);
        }

        setState(draft);
    },

    /**
     * Called by Discord's "Move to > Category" before it places the channel last in the target.
     * Returns true when it put the channel back in its remembered spot instead.
     */
    restorePlacement(list: { channel?: Channel; }[], moved: { channel?: Channel; }, targetId: string, where: string) {
        try {
            if (where !== "last" || SelectedGuildStore.getGuildId() !== FAVORITES_ROUTE_ID) return false;

            const channelId = moved?.channel?.id;
            const { favoriteChannels } = getState();
            const entry = channelId != null ? favoriteChannels[channelId] : null;
            if (!entry || entry.type === ENTRY_TYPE_CATEGORY) return false;

            const target = targetId === UNCATEGORIZED_LIST_ID ? NO_PARENT : String(targetId);
            // Placement moves ("First/Last in Category") target the current category
            if (entry.parentId === target) return false;
            if (target !== NO_PARENT && favoriteChannels[target]?.type !== ENTRY_TYPE_CATEGORY) return false;

            const placement = settings.plain.placementHistory?.[channelId!];
            if (placement?.parentId !== target) return false;

            const index = findRestoreIndex(list.map(item => item?.channel?.id ?? ""), placement);
            if (index === -1) return false;

            list.splice(index, 0, moved);
            return true;
        } catch (e) {
            logger.error("Failed to restore channel placement", e);
            return false;
        }
    },

    renderGuildIcon(channel: Channel, guild: Guild | undefined) {
        if (!channel?.guild_id) return null;
        // Text rows are given the Favorites pseudo-guild, voice rows are given no guild at all,
        // so for those GuildIcon falls back to checking whether the Favorites page is open
        if (guild != null && guild.id !== FAVORITES_GUILD_ID) return null;
        return <GuildIcon guildId={channel.guild_id} inFavoritesList={guild != null} />;
    },
});

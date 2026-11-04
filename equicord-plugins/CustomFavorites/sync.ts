/*
 * CustomFavorites sync client, shared by the Equicord and Kettu plugins.
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Talks to sync-server/server.mjs. One document per server; every device pushes its changes and
 * long-polls for the others'. Concurrent edits are merged per favorite against the last synced copy.
 *
 * Kettu evals plugins with Hermes, where let/const in loops are function scoped and classes may not
 * be supported: no classes, and never close over a loop variable.
 */

export interface SyncData {
    state: { favoriteChannels: Record<string, unknown>; [key: string]: unknown; };
    placementHistory: Record<string, unknown>;
}

/** What a device remembers about the server it syncs with */
export interface SyncMeta {
    /** Server URL this meta belongs to; a different URL means starting over */
    server: string;
    revision: number;
    /** The document as of `revision`, the common ancestor for merges */
    base: SyncData;
}

interface RemoteDoc {
    revision: number;
    updatedAt: string | null;
    data: SyncData | null;
}

export interface HttpResponse {
    status: number;
    json(): Promise<any>;
}

export interface SyncHost {
    getConfig(): { url: string; token: string; };
    getLocal(): SyncData;
    /** Replace local favorites with synced data, without reporting it back as a local change */
    applyRemote(data: SyncData): void;
    loadMeta(): SyncMeta | null;
    saveMeta(meta: SyncMeta | null): void;
    request(method: "GET" | "PUT", url: string, token: string, body?: unknown, timeoutMs?: number): Promise<HttpResponse>;
    /** Both sides have favorites and have never synced: ask which to keep */
    chooseFirstSync(local: SyncData, remote: SyncData): Promise<"server" | "device">;
    onStatus(status: SyncStatus): void;
    log(...args: unknown[]): void;
}

export interface SyncStatus {
    state: "off" | "syncing" | "ok" | "error";
    message?: string;
    lastSync?: number;
}

const LONG_POLL_TIMEOUT_MS = 35_000;
const PUSH_DELAY_MS = 1000;
const MAX_RETRY_MS = 60_000;

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual((a as any)[key], (b as any)[key]));
}

/** Per key: whichever side changed it since `base` wins; if both did, `local` wins. Missing keys are deletions. */
export function merge3(base: Record<string, any>, local: Record<string, any>, remote: Record<string, any>) {
    const result: Record<string, any> = {};
    const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(local ?? {}), ...Object.keys(remote ?? {})]);
    keys.forEach(key => {
        const b = base?.[key], l = local?.[key], r = remote?.[key];
        const value = deepEqual(l, b) ? r : l;
        if (value !== undefined) result[key] = value;
    });
    return result;
}

export function mergeData(base: SyncData, local: SyncData, remote: SyncData): SyncData {
    const { favoriteChannels: baseChannels, ...baseRest } = base.state;
    const { favoriteChannels: localChannels, ...localRest } = local.state;
    const { favoriteChannels: remoteChannels, ...remoteRest } = remote.state;
    return {
        state: {
            ...merge3(baseRest, localRest, remoteRest),
            favoriteChannels: merge3(baseChannels, localChannels, remoteChannels),
        },
        placementHistory: merge3(base.placementHistory, local.placementHistory, remote.placementHistory),
    };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const isEmpty = (data: SyncData | null) => !data || Object.keys(data.state?.favoriteChannels ?? {}).length === 0;
const endpoint = (url: string) => url.replace(/\/+$/, "") + "/v1/favorites";

export function createSync(host: SyncHost) {
    let running = false;
    /** Bumped on stop/restart so a stale poll loop exits */
    let generation = 0;
    let pushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Serializes sync operations */
    let queue: Promise<unknown> = Promise.resolve();

    const enqueue = <T,>(task: () => Promise<T>) => {
        const next = queue.then(task, task);
        queue = next.catch(() => { });
        return next;
    };

    const status = (state: SyncStatus["state"], message?: string) =>
        host.onStatus({ state, message, lastSync: state === "ok" ? Date.now() : undefined });

    function currentMeta() {
        const meta = host.loadMeta();
        return meta && meta.server === host.getConfig().url ? meta : null;
    }

    /** Take the server's document as-is. The base is what the host stored, so its own normalization isn't a change. */
    function adopt(url: string, remote: RemoteDoc) {
        host.applyRemote(clone(remote.data!));
        host.saveMeta({ server: url, revision: remote.revision, base: clone(host.getLocal()) });
        status("ok");
    }

    async function push(data: SyncData, baseRevision: number, attempt = 0): Promise<void> {
        const { url, token } = host.getConfig();
        const res = await host.request("PUT", endpoint(url), token, { baseRevision, data });
        if (res.status === 200) {
            const { revision } = await res.json();
            host.saveMeta({ server: url, revision, base: clone(data) });
            status("ok");
            return;
        }
        if (res.status === 409 && attempt < 3) {
            // Another device wrote first: merge with what it wrote and try again
            await reconcile(await res.json(), attempt + 1);
            return;
        }
        throw new Error(res.status === 401 ? "Wrong sync token" : `Upload failed (HTTP ${res.status})`);
    }

    async function reconcile(remote: RemoteDoc, attempt = 0): Promise<void> {
        const { url } = host.getConfig();
        const meta = currentMeta();
        const local = host.getLocal();

        if (!meta) {
            // First sync with this server
            if (remote.revision === 0 || isEmpty(remote.data)) {
                await push(local, remote.revision, attempt);
                return;
            }
            const choice = isEmpty(local) || deepEqual(local, remote.data) ? "server" : await host.chooseFirstSync(local, remote.data!);
            if (choice === "device") {
                await push(local, remote.revision, attempt);
                return;
            }
            adopt(url, remote);
            return;
        }

        if (remote.revision === meta.revision) {
            // Nothing new on the server; upload anything changed here meanwhile
            if (!deepEqual(local, meta.base)) await push(local, meta.revision, attempt);
            else status("ok");
            return;
        }

        if (deepEqual(local, meta.base)) {
            adopt(url, remote);
            return;
        }

        // Both sides changed: merge, show the result here and upload it
        const merged = mergeData(meta.base, local, remote.data!);
        if (!deepEqual(merged, local)) host.applyRemote(clone(merged));
        await push(merged, remote.revision, attempt);
    }

    async function fetchRemote(since?: number): Promise<RemoteDoc | null> {
        const { url, token } = host.getConfig();
        const query = since == null ? "" : `?since=${since}&wait=1`;
        const res = await host.request("GET", endpoint(url) + query, token, undefined, LONG_POLL_TIMEOUT_MS);
        if (res.status === 204) return null;
        if (res.status === 200) return res.json();
        throw new Error(res.status === 401 ? "Wrong sync token" : `Download failed (HTTP ${res.status})`);
    }

    async function pollLoop(myGeneration: number) {
        let retryMs = 2000;
        let first = true;
        while (running && myGeneration === generation) {
            try {
                // First request returns at once so a fresh start catches up immediately
                const since = first ? undefined : currentMeta()?.revision;
                const remote = await fetchRemote(since);
                first = false;
                if (myGeneration !== generation) return;
                if (remote) await enqueue(() => reconcile(remote));
                retryMs = 2000;
            } catch (e) {
                if (myGeneration !== generation) return;
                host.log("Sync failed", e);
                status("error", e instanceof Error ? e.message : String(e));
                await new Promise(resolve => setTimeout(resolve, retryMs));
                retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
                first = true;
            }
        }
    }

    function stop() {
        running = false;
        generation++;
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = null;
    }

    return {
        start() {
            const { url, token } = host.getConfig();
            stop();
            if (!url || !token) {
                status("off");
                return;
            }
            running = true;
            status("syncing");
            pollLoop(++generation);
        },

        stop,

        /** Call after every local change; uploads shortly after the last one */
        notifyLocalChange() {
            if (!running) return;
            if (pushTimer) clearTimeout(pushTimer);
            pushTimer = setTimeout(() => {
                pushTimer = null;
                enqueue(async () => {
                    const meta = currentMeta();
                    // Before the first sync the poll loop decides what happens to local data
                    if (!meta) return;
                    const local = host.getLocal();
                    if (deepEqual(local, meta.base)) return;
                    try {
                        await push(local, meta.revision);
                    } catch (e) {
                        host.log("Sync upload failed", e);
                        status("error", e instanceof Error ? e.message : String(e));
                    }
                });
            }, PUSH_DELAY_MS);
        },

        /** Forget the server's state so the next sync starts over (asks again if both sides have data) */
        reset() {
            host.saveMeta(null);
        },
    };
}

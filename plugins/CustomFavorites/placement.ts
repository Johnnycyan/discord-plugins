/*
 * Equicord, a Discord client mod
 * Copyright (c) 2026 Equicord and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Where a channel sat in the category it last left, remembered as its neighbours
 * rather than an index. When it moves back it goes next to the nearest neighbour
 * that is still there, so channels added or removed in the meantime shift it the
 * same way they would have if it had never left.
 */
export interface Placement {
    /** Category the channel left, "0" for uncategorized */
    parentId: string;
    /** Channels that were above it, nearest first */
    before: string[];
    /** Channels that were below it, nearest first */
    after: string[];
}

export type PlacementHistory = Record<string, Placement>;

interface EntryLike {
    type: number;
    position: number;
    parentId: string;
}

/** Limits how many neighbours are kept per side, so one history entry stays small */
export const MAX_ANCHORS = 25;

function compareIds(a: string, b: string) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Channel ids in a category, in display order */
export function orderedChildren(entries: Record<string, EntryLike>, parentId: string, categoryType: number) {
    return Object.entries(entries)
        .filter(([, e]) => e.type !== categoryType && e.parentId === parentId)
        .sort(([idA, a], [idB, b]) => a.position - b.position || compareIds(idA, idB))
        .map(([id]) => id);
}

export function snapshotPlacement(entries: Record<string, EntryLike>, channelId: string, categoryType: number): Placement | null {
    const entry = entries[channelId];
    if (!entry) return null;

    const siblings = orderedChildren(entries, entry.parentId, categoryType);
    const index = siblings.indexOf(channelId);
    if (index === -1) return null;

    return {
        parentId: entry.parentId,
        before: siblings.slice(Math.max(0, index - MAX_ANCHORS), index).reverse(),
        after: siblings.slice(index + 1, index + 1 + MAX_ANCHORS),
    };
}

/**
 * Compares the favorites before and after an update and returns the new history,
 * or null when nothing changed.
 * Only the last category a channel left is kept; its current one is the live data.
 */
export function updatePlacementHistory(
    history: PlacementHistory,
    before: Record<string, EntryLike>,
    after: Record<string, EntryLike>,
    categoryType: number,
    noParent: string
): PlacementHistory | null {
    const next: PlacementHistory = { ...history };
    let changed = false;

    for (const [id, prev] of Object.entries(before)) {
        if (prev.type === categoryType) continue;

        const current = after[id];
        if (current == null || current.parentId === prev.parentId) continue;

        const placement = snapshotPlacement(before, id, categoryType);
        if (placement) {
            next[id] = placement;
            changed = true;
        }
    }

    // Forget channels that were unfavorited and categories that were deleted
    for (const [id, placement] of Object.entries(next)) {
        const gone = after[id] == null || after[id].type === categoryType;
        const categoryGone = placement.parentId !== noParent && after[placement.parentId]?.type !== categoryType;
        if (gone || categoryGone) {
            delete next[id];
            changed = true;
        }
    }

    return changed ? next : null;
}

/**
 * Index to insert the channel at in the destination list (which doesn't contain it),
 * or -1 if none of its old neighbours are there.
 */
export function findRestoreIndex(listIds: string[], placement: Placement) {
    for (const id of placement.after) {
        const index = listIds.indexOf(id);
        if (index !== -1) return index;
    }
    for (const id of placement.before) {
        const index = listIds.indexOf(id);
        if (index !== -1) return index + 1;
    }
    return -1;
}

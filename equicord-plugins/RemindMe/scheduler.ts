/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint-disable @stylistic/arrow-parens */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

import { openAlarmModal } from "./AlarmModal";
import { openMissedRemindersModal } from "./MissedRemindersModal";

const logger = new Logger("RemindMe Scheduler");
const DATASTORE_KEY = "RemindMe_Reminders";

export type ReminderMode = "notification" | "alarm";

export interface Reminder {
    id: string;
    targetTimeMs: number;
    reminderTimeMs: number;
    mode: ReminderMode;
    soundUrl?: string;
    messageUrl?: string;
    text?: string;
    includePreview?: boolean;
    channelId?: string;
    messageId?: string;
}

const activeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

export async function initScheduler() {
    const reminders = (await DataStore.get<Reminder[]>(DATASTORE_KEY)) ?? [];
    const now = Date.now();

    const missedReminders: Reminder[] = [];
    const validReminders: Reminder[] = [];

    for (const r of reminders) {
        if (r.reminderTimeMs <= now) {
            missedReminders.push(r);
        } else {
            validReminders.push(r);
            scheduleReminder(r);
        }
    }

    if (missedReminders.length > 0) {
        logger.info(`Found ${missedReminders.length} missed reminders.`);
        await DataStore.set(DATASTORE_KEY, validReminders);
        triggerMissedReminders(missedReminders);
    }
}

export function deinitScheduler() {
    for (const [, timeout] of activeTimeouts.entries()) {
        clearTimeout(timeout);
    }
    activeTimeouts.clear();
}

function scheduleReminder(r: Reminder) {
    const delay = r.reminderTimeMs - Date.now();
    if (delay < 0) return;

    const timeout = setTimeout(() => {
        executeReminder(r);
    }, delay);

    activeTimeouts.set(r.id, timeout);
}

export async function addReminder(r: Reminder) {
    const reminders = (await DataStore.get<Reminder[]>(DATASTORE_KEY)) ?? [];
    reminders.push(r);
    await DataStore.set(DATASTORE_KEY, reminders);

    if (r.reminderTimeMs <= Date.now()) {
        executeReminder(r);
    } else {
        scheduleReminder(r);
    }
}

export async function removeReminder(id: string) {
    const timeout = activeTimeouts.get(id);
    if (timeout) {
        clearTimeout(timeout);
        activeTimeouts.delete(id);
    }

    const reminders = (await DataStore.get<Reminder[]>(DATASTORE_KEY)) ?? [];
    const filtered = reminders.filter((r) => r.id !== id);
    await DataStore.set(DATASTORE_KEY, filtered);
}

export async function getReminders(): Promise<Reminder[]> {
    return (await DataStore.get<Reminder[]>(DATASTORE_KEY)) ?? [];
}

function executeReminder(r: Reminder) {
    activeTimeouts.delete(r.id);
    removeReminder(r.id);

    // Both modes now show a dialog — the AlarmModal handles loop vs play-once
    openAlarmModal(r);
}

function triggerMissedReminders(missed: Reminder[]) {
    openMissedRemindersModal(missed);
}

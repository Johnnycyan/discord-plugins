/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { settings } from "./index";

export function formatDateTime(ms: number): string {
    const date = new Date(ms);

    const dateFormat = settings.store.dateFormat ?? "MM/DD/YYYY";
    const timeFormat = settings.store.timeFormat ?? "12-hour";

    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();

    let datePart: string;
    switch (dateFormat) {
        case "DD/MM/YYYY":
            datePart = `${day}/${month}/${year}`;
            break;
        case "YYYY-MM-DD":
            datePart = `${year}-${month}-${day}`;
            break;
        default: // MM/DD/YYYY
            datePart = `${month}/${day}/${year}`;
            break;
    }

    let timePart: string;
    if (timeFormat === "24-hour") {
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        timePart = `${hours}:${minutes}`;
    } else {
        let hours = date.getHours();
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12 || 12;
        const minutes = String(date.getMinutes()).padStart(2, "0");
        timePart = `${hours}:${minutes} ${ampm}`;
    }

    return `${datePart} ${timePart}`;
}

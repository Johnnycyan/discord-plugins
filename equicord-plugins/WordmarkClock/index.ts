/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated, Johnnycyan, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    wordmarkSelector: {
        type: OptionType.STRING,
        description: "Selector for the wordmark element",
        default: "div.title_edbb22 > div > div.lineClamp1__4bd52"
    }
});

export default definePlugin({
    name: "WordmarkClock",
    description: "Updates the Discord wordmark with the current time, date, and day of the week every second.",
    authors: [{ name: "Johnnycyan", id: 258020906805362688n }],
    settings,

    start() {
        const intervalId = setInterval(() => {
            const wordmark = document.querySelector(settings.store.wordmarkSelector);
            if (wordmark) {
                const now = new Date();

                const hours = now.getHours().toString().padStart(2, "0");
                const minutes = now.getMinutes().toString().padStart(2, "0");

                const formattedTime = `${hours}:${minutes}`;

                const formattedDate = now.toLocaleDateString("en-CA"); // Using toLocaleDateString() with 'en-CA' locale
                const dayOfWeek = now.toLocaleDateString([], { weekday: "short" });

                wordmark.textContent = `${formattedTime} - ${formattedDate} - ${dayOfWeek}`;
            }
        }, 1000); // Update every second

        // Store the interval ID so it can be cleared when the plugin stops
        this._intervalId = intervalId;
    },

    stop() {
        // Clear the interval when the plugin is stopped
        if (this._intervalId != null) {
            clearInterval(this._intervalId);
            this._intervalId = null;
        }

        // Optionally, reset the wordmark text content back to its original state (if applicable)
        const wordmark = document.querySelector(settings.store.wordmarkSelector);
        if (wordmark) {
            wordmark.textContent = "Discord"; // Or whatever the original text should be
        }
    },
});

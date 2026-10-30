/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated, Johnnycyan, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

const settings = definePluginSettings({
    denylist: {
        type: OptionType.STRING,
        description: "Category names to NOT collapse (comma-separated)",
        default: ""
    },
    expandedSelector: {
        type: OptionType.STRING,
        description: "Selector for checking expanded state of categories",
        default: ".mainContent__29444"
    },
    nameSelector: {
        type: OptionType.STRING,
        description: "Selector for getting category names",
        default: "div.mainContent__29444 > h3 > div"
    },
    listSelector: {
        type: OptionType.STRING,
        description: "Selector for getting the category list items",
        default: "li.containerDefault__29444"
    }
});

function collapseCategories(exceptCategories: string[], attempts: number = 10): void {
    const { expandedSelector } = settings.store;
    const { nameSelector } = settings.store;
    const { listSelector } = settings.store;

    const categories = document.querySelectorAll(listSelector);
    let index = 0;

    function collapseNextCategory(): void {
        if (index >= categories.length) {
            // Check if there are still expanded categories and collapse them
            setTimeout(() => {
                const stillExpanded = Array.from(categories).some(category => {
                    const nameEl = category.querySelector(nameSelector);
                    const mainContent = category.querySelector(expandedSelector);
                    if (!nameEl || !mainContent) return false;
                    const categoryName = nameEl.textContent?.trim() ?? "";
                    return !exceptCategories.includes(categoryName) && mainContent.getAttribute("aria-expanded") === "true";
                });
                if (attempts > 1 || stillExpanded) {
                    collapseCategories(exceptCategories, attempts - 1);
                }
            }, 100);
            return;
        }

        const category = categories[index];
        const nameEl = category.querySelector(nameSelector);
        const mainContent = category.querySelector(expandedSelector) as HTMLElement | null;

        if (nameEl && mainContent) {
            const categoryName = nameEl.textContent?.trim() ?? "";
            const isExpanded = mainContent.getAttribute("aria-expanded") === "true";

            if (!exceptCategories.includes(categoryName) && isExpanded) {
                mainContent.click();
            }
        }

        index++;
        setTimeout(collapseNextCategory, 100);
    }

    collapseNextCategory();
}

function handleCollapseClick(): void {
    const denylistStr = settings.store.denylist;
    const exceptCategories = denylistStr.split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
    collapseCategories(exceptCategories);
}

export default definePlugin({
    name: "ChannelCollapser",
    description: "Adds a button above the channels list to collapse all channel categories except those in your denylist.",
    authors: [{ name: "Johnnycyan", id: 258020906805362688n }],
    settings,

    start() {
        console.log("[ChannelCollapser] Plugin starting...");

        // Try to inject button with retries (DOM might not be ready)
        this.tryInjectButton(10);

        // Re-inject button when navigating between servers
        this._handleServerChange = () => {
            setTimeout(() => this.tryInjectButton(5), 100);
        };
        FluxDispatcher.subscribe("CHANNEL_SELECT", this._handleServerChange);
    },

    tryInjectButton(retries: number) {
        if (retries <= 0) {
            console.log("[ChannelCollapser] Failed to inject button after all retries");
            return;
        }

        const channelList = document.querySelector("#channels > ul");
        if (channelList) {
            this.injectButton();
        } else {
            console.log(`[ChannelCollapser] #channels > ul not found, retrying... (${retries} left)`);
            setTimeout(() => this.tryInjectButton(retries - 1), 500);
        }
    },

    stop() {
        this.removeButton();
        if (this._handleServerChange) {
            FluxDispatcher.unsubscribe("CHANNEL_SELECT", this._handleServerChange);
        }
    },

    injectButton() {
        // Remove existing button if present
        this.removeButton();

        // Find the channels container and the ul inside it
        const channelList = document.querySelector("#channels > ul");

        if (!channelList) {
            console.log("[ChannelCollapser] Could not find #channels > ul");
            return;
        }

        if (!document.querySelector(".vc-channel-collapser-container")) {
            // Create button using plain DOM
            const buttonContainer = document.createElement("div");
            buttonContainer.className = "vc-channel-collapser-wrapper";

            const innerContainer = document.createElement("div");
            innerContainer.className = "vc-channel-collapser-container";

            const button = document.createElement("button");
            button.className = "vc-channel-collapser-button";
            button.textContent = "Collapse All";
            button.addEventListener("click", handleCollapseClick);

            innerContainer.appendChild(button);
            buttonContainer.appendChild(innerContainer);

            // Insert above the ul (channel list)
            channelList.parentElement?.insertBefore(buttonContainer, channelList);
            this._buttonContainer = buttonContainer;
            console.log("[ChannelCollapser] Button injected successfully");
        }
    },

    removeButton() {
        if (this._buttonContainer) {
            this._buttonContainer.remove();
            this._buttonContainer = null;
        }
        // Also remove any orphaned containers
        document.querySelectorAll(".vc-channel-collapser-wrapper").forEach(el => el.remove());
    }
});

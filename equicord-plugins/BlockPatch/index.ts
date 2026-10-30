/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated, Johnnycyan, and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

const BLOCKED_URL_SUBSTRING = "/users/@me/settings-proto/1";

let OriginalXHR: typeof XMLHttpRequest | null = null;

class PatchedXHR extends XMLHttpRequest {
    private _blockMethod?: string;
    private _blockUrl?: string;

    open(method: string, url: string | URL, ...rest: any[]) {
        this._blockMethod = method?.toUpperCase();
        this._blockUrl = url.toString();
        // @ts-ignore - variadic passthrough to native open
        return super.open(method, url, ...rest);
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
        if (
            this._blockMethod === "PATCH" &&
            this._blockUrl?.includes(BLOCKED_URL_SUBSTRING)
        ) {
            console.warn(
                "[BlockSettingsProtoSync] Blocked PATCH to",
                this._blockUrl,
            );

            Object.defineProperty(this, "readyState", {
                value: 4,
                configurable: true,
            });
            Object.defineProperty(this, "status", {
                value: 200,
                configurable: true,
            });
            Object.defineProperty(this, "responseText", {
                value: "{}",
                configurable: true,
            });
            Object.defineProperty(this, "response", {
                value: "{}",
                configurable: true,
            });

            this.dispatchEvent(new Event("readystatechange"));
            this.dispatchEvent(new Event("load"));
            this.dispatchEvent(new Event("loadend"));
            return;
        }

        return super.send(body);
    }
}

export default definePlugin({
    name: "BlockSettingsProtoSync",
    description:
        "Blocks PATCH requests to users/@me/settings-proto/1 (Discord's cloud settings sync)",
    authors: [{ name: "Johnnycyan", id: 258020906805362688n }],

    start() {
        OriginalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = PatchedXHR as any;
    },

    stop() {
        if (OriginalXHR) window.XMLHttpRequest = OriginalXHR;
    },
});

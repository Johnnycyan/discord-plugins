/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint-disable @stylistic/arrow-parens */

import {
    addContextMenuPatch,
    findGroupChildrenByChildId,
    NavContextMenuPatchCallback,
    removeContextMenuPatch,
} from "@api/ContextMenu";
import {
    addHeaderBarButton,
    HeaderBarButton,
    removeHeaderBarButton,
} from "@api/HeaderBar";
import { definePluginSettings } from "@api/Settings";
import { Flex } from "@components/Flex";
import { DeleteIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { Button, Forms, Menu, TextInput } from "@webpack/common";

import { ClockIcon } from "./Icon";
import { openManageRemindersModal } from "./ManageRemindersModal";
import { openReminderModal } from "./ReminderModal";
import { deinitScheduler, initScheduler } from "./scheduler";

const logger = new Logger("RemindMe");

export interface CustomSound {
    name: string;
    url: string;
}

function CustomSoundsSettings() {
    const { customSounds } = settings.use(["customSounds"]);
    const sounds: CustomSound[] = customSounds ?? [];

    const toPlain = (arr: CustomSound[]) =>
        arr.map((s) => ({ name: s.name, url: s.url }));

    function addSound() {
        settings.store.customSounds = [
            ...toPlain(sounds),
            { name: "", url: "" },
        ];
    }

    function removeSound(index: number) {
        settings.store.customSounds = toPlain(
            sounds.filter((_, i) => i !== index),
        );
    }

    function updateSound(
        index: number,
        field: keyof CustomSound,
        value: string,
    ) {
        settings.store.customSounds = toPlain(
            sounds.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
        );
    }

    return (
        <Flex flexDirection="column" style={{ gap: "0.75em" }}>
            <Forms.FormTitle>Custom Sounds</Forms.FormTitle>
            {sounds.map((sound, i) => (
                <Flex
                    key={i}
                    flexDirection="row"
                    style={{ gap: "0.5em", alignItems: "center" }}
                >
                    <div style={{ flex: 1 }}>
                        <TextInput
                            placeholder="Name"
                            value={sound.name}
                            onChange={(v) => updateSound(i, "name", v)}
                        />
                    </div>
                    <div style={{ flex: 2 }}>
                        <TextInput
                            placeholder="URL"
                            value={sound.url}
                            onChange={(v) => updateSound(i, "url", v)}
                        />
                    </div>
                    <Button
                        size={Button.Sizes.MIN}
                        color={Button.Colors.RED}
                        onClick={() => removeSound(i)}
                        style={{
                            padding: "6px 8px",
                            backgroundColor: "transparent",
                            border: "1px solid var(--button-danger-background)",
                        }}
                    >
                        <DeleteIcon style={{ verticalAlign: "middle" }} />
                    </Button>
                </Flex>
            ))}
            <Button
                size={Button.Sizes.SMALL}
                color={Button.Colors.GREEN}
                onClick={addSound}
                style={{ alignSelf: "flex-start" }}
            >
                + Add Sound
            </Button>
        </Flex>
    );
}

export const settings = definePluginSettings({
    defaultTimes: {
        type: OptionType.STRING,
        description:
            "Comma-separated default times (in minutes) to be reminded before an event",
        default: "15, 60, 1440",
    },
    dateFormat: {
        type: OptionType.SELECT,
        description: "Date format used throughout the plugin",
        options: [
            { label: "MM/DD/YYYY", value: "MM/DD/YYYY", default: true },
            { label: "DD/MM/YYYY", value: "DD/MM/YYYY" },
            { label: "YYYY-MM-DD", value: "YYYY-MM-DD" },
        ],
    },
    timeFormat: {
        type: OptionType.SELECT,
        description: "Time format used throughout the plugin",
        options: [
            { label: "12-hour", value: "12-hour", default: true },
            { label: "24-hour", value: "24-hour" },
        ],
    },
    customSounds: {
        type: OptionType.CUSTOM,
        default: [] as CustomSound[],
        description: "Custom alarm sounds",
    },
    customSoundsComponent: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => <CustomSoundsSettings />,
    },
});

const timestampRegex = /<t:(\d+)(?::[a-zA-Z])?>/g;

export default definePlugin({
    name: "RemindMe",
    description:
        "Allows right-clicking unix timestamps to set a reminder/alarm.",
    authors: [{ name: "Johnnycyan", id: 258020906805362688n }],
    settings,

    start() {
        initScheduler();
        addContextMenuPatch("message", this.handleContextMenu);
        addHeaderBarButton("RemindMeManage", this.renderHeaderButton);
    },

    stop() {
        deinitScheduler();
        removeContextMenuPatch("message", this.handleContextMenu);
        removeHeaderBarButton("RemindMeManage");
    },

    renderHeaderButton() {
        return (
            <HeaderBarButton
                tooltip="Manage Reminders"
                icon={ClockIcon}
                onClick={() => openManageRemindersModal()}
            />
        );
    },

    handleContextMenu: ((
        children,
        { message, channel }: { message: Message; channel: Channel },
    ) => {
        if (!message || !message.content) return;

        // Reset lastIndex since regex is global
        timestampRegex.lastIndex = 0;

        const allMatches: string[] = [];
        let m: RegExpExecArray | null;
        const now = Date.now() / 1000;

        while ((m = timestampRegex.exec(message.content)) !== null) {
            const unixTime = parseInt(m[1]);
            // Only include future timestamps
            if (unixTime > now) {
                allMatches.push(m[0]);
            }
        }

        if (allMatches.length === 0) return;

        const menuGroup = findGroupChildrenByChildId("copy-text", children);
        if (!menuGroup) return;

        const messageUrl = `https://discord.com/channels/${channel.guild_id ?? "@me"}/${channel.id}/${message.id}`;

        menuGroup.push(
            // @ts-ignore
            <Menu.MenuItem
                id="remind-me-timestamp"
                key="remind-me-timestamp"
                label="Remind Me"
                icon={ClockIcon}
                action={() => {
                    openReminderModal(
                        allMatches,
                        messageUrl,
                        channel.id,
                        message.id,
                    );
                }}
            />,
        );
    }) as NavContextMenuPatchCallback,
});

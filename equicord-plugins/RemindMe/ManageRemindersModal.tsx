/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint-disable @stylistic/arrow-parens */

import {
    ModalCloseButton,
    ModalContent,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal,
} from "@utils/modal";
import { Button, Forms, NavigationRouter, React, Text } from "@webpack/common";

import { formatDateTime } from "./formatDate";
import { getReminders, Reminder, removeReminder } from "./scheduler";

export function openManageRemindersModal() {
    openModal((props) => <ManageRemindersModal modalProps={props} />);
}

function ManageRemindersModal({ modalProps }: { modalProps: ModalProps }) {
    const [reminders, setReminders] = React.useState<Reminder[]>([]);

    React.useEffect(() => {
        getReminders().then(setReminders);
    }, []);

    const handleDelete = async (id: string) => {
        await removeReminder(id);
        setReminders(reminders.filter((r) => r.id !== id));
    };

    const handleGoToMessage = (messageUrl: string) => {
        // Extract path from full Discord URL for in-client navigation
        // URL format: https://discord.com/channels/guildId/channelId/messageId
        const match = messageUrl.match(
            /https?:\/\/(?:\w+\.)?discord(?:app)?\.com(\/channels\/[^\s]+)/,
        );
        if (match) {
            NavigationRouter.transitionTo(match[1]);
            modalProps.onClose();
        }
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <Forms.FormTitle tag="h2" style={{ margin: 0, flex: 1 }}>
                    Manage Reminders
                </Forms.FormTitle>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent style={{ padding: "16px" }}>
                {reminders.length === 0 ? (
                    <Text variant="text-md/normal" color="text-muted">
                        No active reminders.
                    </Text>
                ) : (
                    <div
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                        }}
                    >
                        {reminders.map((r) => (
                            <div
                                key={r.id}
                                style={{
                                    padding: "12px",
                                    backgroundColor:
                                        "var(--background-secondary)",
                                    borderRadius: "8px",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                }}
                            >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    {r.text && (
                                        <Forms.FormTitle
                                            style={{ margin: "0 0 4px 0" }}
                                        >
                                            {r.text}
                                        </Forms.FormTitle>
                                    )}
                                    <Text
                                        variant="text-sm/normal"
                                        color="text-muted"
                                    >
                                        Event: {formatDateTime(r.targetTimeMs)}
                                    </Text>
                                    <Text
                                        variant="text-sm/normal"
                                        color="text-muted"
                                    >
                                        Fires at:{" "}
                                        {formatDateTime(r.reminderTimeMs)} |
                                        Mode: {r.mode}
                                    </Text>
                                </div>
                                <div
                                    style={{
                                        display: "flex",
                                        gap: "8px",
                                        flexShrink: 0,
                                        marginLeft: "12px",
                                    }}
                                >
                                    {r.messageUrl && (
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            color={Button.Colors.PRIMARY}
                                            onClick={() =>
                                                handleGoToMessage(r.messageUrl!)
                                            }
                                        >
                                            Go to Message
                                        </Button>
                                    )}
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        color={Button.Colors.RED}
                                        onClick={() => handleDelete(r.id)}
                                    >
                                        Delete
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </ModalContent>
        </ModalRoot>
    );
}

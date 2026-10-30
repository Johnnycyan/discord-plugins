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
import { Reminder } from "./scheduler";

export function openMissedRemindersModal(missed: Reminder[]) {
    openModal((props) => (
        <MissedRemindersModal modalProps={props} missed={missed} />
    ));
}

function MissedRemindersModal({
    modalProps,
    missed,
}: {
    modalProps: ModalProps;
    missed: Reminder[];
}) {
    const handleGoToMessage = (messageUrl: string) => {
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
                    Missed Reminders
                </Forms.FormTitle>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent style={{ padding: "16px" }}>
                <Text variant="text-md/normal" style={{ marginBottom: "16px" }}>
                    The following reminders triggered while Discord was closed:
                </Text>
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                    }}
                >
                    {missed.map((r) => (
                        <div
                            key={r.id}
                            style={{
                                padding: "12px",
                                backgroundColor: "var(--background-secondary)",
                                borderRadius: "8px",
                            }}
                        >
                            {r.text && (
                                <Forms.FormTitle
                                    style={{ margin: "0 0 4px 0" }}
                                >
                                    {r.text}
                                </Forms.FormTitle>
                            )}
                            <Text variant="text-sm/normal" color="text-muted">
                                Event: {formatDateTime(r.targetTimeMs)}
                            </Text>
                            <Text variant="text-sm/normal" color="text-muted">
                                Missed at: {formatDateTime(r.reminderTimeMs)}
                            </Text>
                            {r.messageUrl && (
                                <div style={{ marginTop: "8px" }}>
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        color={Button.Colors.PRIMARY}
                                        onClick={() =>
                                            handleGoToMessage(r.messageUrl!)
                                        }
                                    >
                                        Go to Message
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

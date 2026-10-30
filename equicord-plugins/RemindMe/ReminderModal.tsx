/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* eslint-disable @stylistic/arrow-parens */

import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal,
} from "@utils/modal";
import { Button, Forms, React, Select, TextInput } from "@webpack/common";

import { CustomSound, settings } from "./index";
import { addReminder, ReminderMode } from "./scheduler";

export function openReminderModal(
    timestamps: string[],
    messageUrl: string,
    channelId: string,
    messageId: string,
) {
    openModal((props) => (
        <ReminderModal
            modalProps={props}
            timestamps={timestamps}
            messageUrl={messageUrl}
            channelId={channelId}
            messageId={messageId}
        />
    ));
}

function ReminderModal({
    modalProps,
    timestamps,
    messageUrl,
    channelId,
    messageId,
}: {
    modalProps: ModalProps;
    timestamps: string[];
    messageUrl: string;
    channelId: string;
    messageId: string;
}) {
    const [selectedTimestampRaw, setSelectedTimestampRaw] = React.useState(
        timestamps[0],
    );
    const [reminderName, setReminderName] = React.useState("");
    const [selectedOffsets, setSelectedOffsets] = React.useState<Set<number>>(
        () => new Set([0]),
    );
    const [mode, setMode] = React.useState<ReminderMode>("notification");
    const [soundUrl, setSoundUrl] = React.useState<string | undefined>();
    const [includePreview, setIncludePreview] = React.useState(false);

    const customSounds: CustomSound[] = settings.store.customSounds ?? [];
    const soundOptions = customSounds
        .filter((s) => s.url)
        .map((s) => ({ label: s.name || s.url, value: s.url }));

    const canSave =
        reminderName.trim().length > 0 &&
        !!soundUrl &&
        selectedOffsets.size > 0;

    function toggleOffset(min: number) {
        setSelectedOffsets((prev) => {
            const next = new Set(prev);
            if (next.has(min)) {
                next.delete(min);
            } else {
                next.add(min);
            }
            return next;
        });
    }

    const handleSave = async () => {
        if (!canSave) return;

        const match = selectedTimestampRaw.match(/<t:(\d+)(?::[a-zA-Z])?>/);
        if (!match) return modalProps.onClose();

        const targetTimeMs = parseInt(match[1]) * 1000;

        // Create one reminder per selected offset
        for (const offsetMinutes of selectedOffsets) {
            const reminderTimeMs = targetTimeMs - offsetMinutes * 60 * 1000;

            await addReminder({
                id: crypto.randomUUID(),
                targetTimeMs,
                reminderTimeMs,
                mode,
                soundUrl,
                messageUrl,
                text: reminderName.trim(),
                includePreview,
                channelId,
                messageId,
            });
        }

        modalProps.onClose();
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader separator={false}>
                <Forms.FormTitle tag="h2" style={{ margin: 0, flex: 1 }}>
                    Set Reminder
                </Forms.FormTitle>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent style={{ padding: "16px" }}>
                {/* Reminder Name (required) */}
                <div style={{ marginBottom: "16px" }}>
                    <Forms.FormTitle>
                        Reminder Name{" "}
                        <span style={{ color: "var(--text-danger)" }}>*</span>
                    </Forms.FormTitle>
                    <TextInput
                        placeholder="Enter a name for this reminder"
                        value={reminderName}
                        onChange={setReminderName}
                    />
                </div>

                {/* Timestamp selection */}
                {timestamps.length > 1 && (
                    <div style={{ marginBottom: "16px" }}>
                        <Forms.FormTitle>Select Timestamp</Forms.FormTitle>
                        <Select
                            options={timestamps.map((t) => ({
                                label: t,
                                value: t,
                            }))}
                            isSelected={(v) => v === selectedTimestampRaw}
                            select={(v) => setSelectedTimestampRaw(v)}
                            serialize={(v) => v}
                        />
                    </div>
                )}

                {/* Multi-offset selection */}
                <div style={{ marginBottom: "16px" }}>
                    <Forms.FormTitle>
                        Remind me before event{" "}
                        <span
                            style={{
                                color: "var(--text-muted)",
                                fontWeight: "normal",
                                fontSize: "12px",
                            }}
                        >
                            (select multiple)
                        </span>
                    </Forms.FormTitle>
                    <div
                        style={{
                            display: "flex",
                            gap: "8px",
                            flexWrap: "wrap",
                        }}
                    >
                        {[0, 5, 15, 60, 1440].map((min) => (
                            <Button
                                key={min}
                                size={Button.Sizes.SMALL}
                                color={
                                    selectedOffsets.has(min)
                                        ? Button.Colors.BRAND
                                        : Button.Colors.PRIMARY
                                }
                                onClick={() => toggleOffset(min)}
                            >
                                {min === 0
                                    ? "At time of event"
                                    : min >= 60
                                      ? `${min / 60} hour(s)`
                                      : `${min} min`}
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Mode */}
                <div style={{ marginBottom: "16px" }}>
                    <Forms.FormTitle>Mode</Forms.FormTitle>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={
                                mode === "notification"
                                    ? Button.Colors.BRAND
                                    : Button.Colors.PRIMARY
                            }
                            onClick={() => setMode("notification")}
                        >
                            Notification
                        </Button>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={
                                mode === "alarm"
                                    ? Button.Colors.BRAND
                                    : Button.Colors.PRIMARY
                            }
                            onClick={() => setMode("alarm")}
                        >
                            Alarm
                        </Button>
                    </div>
                    <Forms.FormText
                        style={{ marginTop: "4px", fontSize: "12px" }}
                    >
                        {mode === "alarm"
                            ? "Sound will loop until dismissed"
                            : "Sound will play once"}
                    </Forms.FormText>
                </div>

                {/* Sound selection (required for both modes) */}
                <div style={{ marginBottom: "16px" }}>
                    <Forms.FormTitle>
                        Sound{" "}
                        <span style={{ color: "var(--text-danger)" }}>*</span>
                    </Forms.FormTitle>
                    {soundOptions.length === 0 ? (
                        <Forms.FormText style={{ color: "var(--text-danger)" }}>
                            No custom sounds configured. Add sounds in the
                            plugin settings first.
                        </Forms.FormText>
                    ) : (
                        <Select
                            options={soundOptions}
                            isSelected={(v) => v === (soundUrl ?? "")}
                            select={(v) => setSoundUrl(v || undefined)}
                            serialize={(v) => v}
                            placeholder="Select a sound..."
                        />
                    )}
                </div>

                {/* Include message preview */}
                <div
                    style={{
                        marginBottom: "8px",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        cursor: "pointer",
                    }}
                    onClick={() => setIncludePreview(!includePreview)}
                >
                    <div
                        style={{
                            width: "20px",
                            height: "20px",
                            borderRadius: "4px",
                            border: includePreview
                                ? "2px solid var(--brand-500)"
                                : "2px solid var(--text-muted)",
                            backgroundColor: includePreview
                                ? "var(--brand-500)"
                                : "var(--background-secondary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            transition: "background-color 0.15s ease",
                        }}
                    >
                        {includePreview && (
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="white"
                            >
                                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                            </svg>
                        )}
                    </div>
                    <Forms.FormText>
                        Include message preview in alarm dialog
                    </Forms.FormText>
                </div>
            </ModalContent>
            <ModalFooter>
                <Button
                    onClick={handleSave}
                    color={Button.Colors.BRAND}
                    disabled={!canSave}
                >
                    Save Reminder
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

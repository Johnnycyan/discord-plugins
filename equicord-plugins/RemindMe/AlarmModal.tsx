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
import { Message } from "@vencord/discord-types";
import { findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import {
    Button,
    ChannelStore,
    Constants,
    Forms,
    MessageStore,
    React,
    RestAPI,
    Text,
} from "@webpack/common";

import { formatDateTime } from "./formatDate";
import { Reminder } from "./scheduler";

const ChannelMessage = findComponentByCodeLazy(
    "childrenExecutedCommand:",
    ".hideAccessories",
);
const SearchResultClasses = findCssClassesLazy("message", "searchResult");

export function openAlarmModal(reminder: Reminder) {
    openModal((props) => <AlarmModal modalProps={props} reminder={reminder} />);
}

function AlarmModal({
    modalProps,
    reminder,
}: {
    modalProps: ModalProps;
    reminder: Reminder;
}) {
    const [isMuted, setIsMuted] = React.useState(false);
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const [previewMessage, setPreviewMessage] = React.useState<Message | null>(
        null,
    );
    const [previewChannel, setPreviewChannel] = React.useState<any>(null);

    const isAlarm = reminder.mode === "alarm";

    // Audio playback
    React.useEffect(() => {
        const soundUrl =
            reminder.soundUrl ||
            "https://discord.com/assets/26f8d0774a383d46cb66.mp3";

        const audio = new Audio(soundUrl);
        audio.loop = isAlarm;
        audioRef.current = audio;

        audio.play().catch(console.error);

        return () => {
            audio.pause();
            audio.src = "";
            audioRef.current = null;
        };
    }, [reminder.soundUrl, isAlarm]);

    // Mute toggle
    React.useEffect(() => {
        if (audioRef.current) {
            audioRef.current.muted = isMuted;
        }
    }, [isMuted]);

    // Fetch message preview
    React.useEffect(() => {
        if (
            !reminder.includePreview ||
            !reminder.channelId ||
            !reminder.messageId
        )
            return;

        const channel = ChannelStore.getChannel(reminder.channelId);
        if (channel) setPreviewChannel(channel);

        // Try cache first
        const msg = MessageStore.getMessage(
            reminder.channelId,
            reminder.messageId,
        );
        if (msg) {
            setPreviewMessage(msg);
            return;
        }

        // Fetch from API
        RestAPI.get({
            url: Constants.Endpoints.MESSAGES(reminder.channelId),
            query: {
                limit: 1,
                around: reminder.messageId,
            },
            retries: 2,
        })
            .then((res) => {
                const data = res?.body?.[0];
                if (data) {
                    const fetched = MessageStore.getMessages(data.channel_id)
                        .receiveMessage(data)
                        .get(data.id);
                    if (fetched) setPreviewMessage(fetched);
                }
            })
            .catch(() => {});
    }, [reminder.includePreview, reminder.channelId, reminder.messageId]);

    return (
        <ModalRoot {...modalProps} size={ModalSize.MEDIUM}>
            <ModalHeader separator={false}>
                <Forms.FormTitle
                    tag="h2"
                    style={{
                        margin: 0,
                        flex: 1,
                    }}
                >
                    <span
                        style={{
                            color: isAlarm
                                ? "var(--text-danger)"
                                : "var(--header-primary)",
                        }}
                    >
                        {isAlarm ? "ALARM" : "REMINDER"}
                    </span>
                </Forms.FormTitle>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent style={{ padding: "16px", textAlign: "center" }}>
                <Text variant="text-lg/bold" style={{ marginBottom: "8px" }}>
                    {reminder.text}
                </Text>
                <Text
                    variant="text-md/normal"
                    color="text-muted"
                    style={{ marginBottom: "16px" }}
                >
                    Your reminder for {formatDateTime(reminder.targetTimeMs)} is
                    happening.
                </Text>

                {/* Message Preview */}
                {reminder.includePreview &&
                    previewMessage &&
                    previewChannel && (
                        <div
                            style={{
                                marginTop: "12px",
                                borderRadius: "8px",
                                overflow: "hidden",
                                textAlign: "left",
                            }}
                        >
                            <Forms.FormTitle
                                style={{
                                    marginBottom: "8px",
                                    textAlign: "left",
                                }}
                            >
                                Original Message
                            </Forms.FormTitle>
                            <div
                                className={SearchResultClasses.message}
                                style={{
                                    backgroundColor:
                                        "var(--background-secondary)",
                                    borderRadius: "8px",
                                    padding: "4px 0",
                                }}
                            >
                                <ChannelMessage
                                    id={`remind-me-preview-${reminder.messageId}`}
                                    message={previewMessage}
                                    channel={previewChannel}
                                    subscribeToComponentDispatch={false}
                                    compact={false}
                                />
                            </div>
                        </div>
                    )}
            </ModalContent>
            <ModalFooter>
                {isAlarm && (
                    <Button
                        onClick={() => setIsMuted(!isMuted)}
                        color={Button.Colors.PRIMARY}
                    >
                        {isMuted ? "Unmute" : "Mute"}
                    </Button>
                )}
                <Button onClick={modalProps.onClose} color={Button.Colors.RED}>
                    {isAlarm ? "Dismiss Alarm" : "Dismiss"}
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

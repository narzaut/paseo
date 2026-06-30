import { useIsFocused } from "@react-navigation/native";
import { memo, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentStreamView } from "@/agent-stream/view";
import { Composer } from "@/composer";
import { ToastViewport, useToastHost } from "@/components/toast-host";
import type { UserComposerAttachment } from "@/attachments/types";
import type { MessagePayload } from "@/composer/types";
import type { HermesRoomMessage } from "@/hooks/use-hermes-room";
import { useHermesRoom } from "@/hooks/use-hermes-room";
import {
  buildHermesRoomAgent,
  buildHermesRoomStreamItems,
  HERMES_ROOM_AGENT_ID,
} from "@/screens/hermes-room-screen-model";
import type { PendingPermission } from "@/types/shared";
import type { Theme } from "@/styles/theme";

const EMPTY_PENDING_PERMISSIONS = new Map<string, PendingPermission>();
const HERMES_ATTACHMENT_MENU_ITEMS: [] = [];

function updateAttachments(
  previous: UserComposerAttachment[],
  next: UserComposerAttachment[] | ((value: UserComposerAttachment[]) => UserComposerAttachment[]),
): UserComposerAttachment[] {
  return typeof next === "function" ? next(previous) : next;
}

function HermesRoomReadyState({
  serverId,
  messages,
  sendMessage,
}: {
  serverId: string;
  messages: HermesRoomMessage[];
  sendMessage: (text: string) => Promise<void>;
}) {
  const isFocused = useIsFocused();
  const { api: toastApi, toast, dismiss } = useToastHost();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<UserComposerAttachment[]>([]);
  const agent = useMemo(() => buildHermesRoomAgent(serverId), [serverId]);
  const streamItems = useMemo(() => buildHermesRoomStreamItems(messages), [messages]);

  const clearDraft = useCallback((_lifecycle: "sent" | "abandoned") => {
    setDraft("");
    setAttachments([]);
  }, []);

  const handleChangeAttachments = useCallback(
    (
      next:
        | UserComposerAttachment[]
        | ((value: UserComposerAttachment[]) => UserComposerAttachment[]),
    ) => {
      setAttachments((current) => updateAttachments(current, next));
    },
    [],
  );

  const handleSubmitMessage = useCallback(
    async ({ text, attachments: outgoingAttachments }: MessagePayload) => {
      if (outgoingAttachments.length > 0) {
        throw new Error("Attachments are not supported in the Hermes room yet");
      }
      await sendMessage(text);
    },
    [sendMessage],
  );

  return (
    <View style={styles.root} testID="hermes-room-screen">
      <View style={styles.contentContainer}>
        <AgentStreamView
          agentId={HERMES_ROOM_AGENT_ID}
          serverId={serverId}
          agent={agent}
          streamItems={streamItems}
          pendingPermissions={EMPTY_PENDING_PERMISSIONS}
          isAuthoritativeHistoryReady
          toast={toastApi}
        />
      </View>
      <Composer
        agentId={HERMES_ROOM_AGENT_ID}
        serverId={serverId}
        isPaneFocused={isFocused}
        onSubmitMessage={handleSubmitMessage}
        value={draft}
        onChangeText={setDraft}
        attachments={attachments}
        onChangeAttachments={handleChangeAttachments}
        cwd="."
        clearDraft={clearDraft}
        autoFocus={isFocused}
        attachmentMenuItemsOverride={HERMES_ATTACHMENT_MENU_ITEMS}
      />
      <ToastViewport toast={toast} onDismiss={dismiss} placement="panel" />
    </View>
  );
}

const MemoizedHermesRoomReadyState = memo(HermesRoomReadyState);

export function HermesRoomScreen({ serverId }: { serverId: string }) {
  const { messages, status, error, sendMessage } = useHermesRoom(serverId);

  if (status === "loading") {
    return (
      <View style={styles.centerState} testID="hermes-room-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (status === "error") {
    return (
      <View style={styles.centerState} testID="hermes-room-error">
        <Text style={styles.errorText}>{error ?? "Unable to load the Hermes room"}</Text>
      </View>
    );
  }

  return (
    <MemoizedHermesRoomReadyState
      serverId={serverId}
      messages={messages}
      sendMessage={sendMessage}
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flex: 1,
    overflow: "hidden",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));

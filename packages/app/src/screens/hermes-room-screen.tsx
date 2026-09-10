import { useIsFocused } from "@react-navigation/native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RotateCw } from "lucide-react-native";
import { AgentStreamView } from "@/agent-stream/view";
import { Composer } from "@/composer";
import { ToastViewport, useToastHost } from "@/components/toast-host";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
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
const HERMES_TURN_PRESENTATION = {
  isActive: false,
  isCancelling: false,
  startedAt: null,
  turnId: null,
} as const;
const HERMES_TEXT_REPLACEMENT = { key: "hermes-room-initial", text: "" };

function updateAttachments(
  previous: UserComposerAttachment[],
  next: UserComposerAttachment[] | ((value: UserComposerAttachment[]) => UserComposerAttachment[]),
): UserComposerAttachment[] {
  return typeof next === "function" ? next(previous) : next;
}

function getDotStyle(pendingRestart: boolean, gatewayStatus: "connected" | "disconnected") {
  if (pendingRestart) return styles.gatewayStatusDotPending;
  if (gatewayStatus === "connected") return styles.gatewayStatusDotConnected;
  return styles.gatewayStatusDotDisconnected;
}

function getStatusText(pendingRestart: boolean, gatewayStatus: "connected" | "disconnected") {
  if (pendingRestart) return "Restart requested";
  if (gatewayStatus === "connected") return "Connected";
  return "Disconnected";
}

function HermesRoomStatusFooter({
  gatewayStatus,
  pendingRestart,
  onPressRestart,
}: {
  gatewayStatus: "connected" | "disconnected";
  pendingRestart: boolean;
  onPressRestart: () => void;
}) {
  return (
    <View style={styles.gatewayFooterRow}>
      <View style={styles.gatewayStatusRow}>
        <View style={[styles.gatewayStatusDot, getDotStyle(pendingRestart, gatewayStatus)]} />
        <Text style={styles.gatewayStatusText}>{getStatusText(pendingRestart, gatewayStatus)}</Text>
      </View>
      <Button
        variant="ghost"
        size="xs"
        loading={pendingRestart}
        disabled={pendingRestart}
        leftIcon={RotateCw}
        onPress={onPressRestart}
        testID="hermes-room-restart-button"
      >
        {pendingRestart ? "Requested" : "Restart"}
      </Button>
    </View>
  );
}

function HermesRoomReadyState({
  serverId,
  messages,
  gatewayStatus,
  sendMessage,
}: {
  serverId: string;
  messages: HermesRoomMessage[];
  gatewayStatus: "connected" | "disconnected";
  sendMessage: (text: string) => Promise<void>;
}) {
  const isFocused = useIsFocused();
  const { api: toastApi, toast, dismiss } = useToastHost();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<UserComposerAttachment[]>([]);
  const [pendingRestart, setPendingRestart] = useState(false);
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agent = useMemo(() => buildHermesRoomAgent(serverId), [serverId]);
  const streamItems = useMemo(() => buildHermesRoomStreamItems(messages), [messages]);

  useEffect(() => {
    if (gatewayStatus === "connected" && pendingRestart) {
      setPendingRestart(false);
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = null;
      }
    }
  }, [gatewayStatus, pendingRestart]);

  useEffect(() => {
    return () => {
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
    };
  }, []);

  const handlePressRestart = useCallback(async () => {
    if (pendingRestart) {
      return;
    }
    setPendingRestart(true);
    restartTimeoutRef.current = setTimeout(() => {
      setPendingRestart(false);
      restartTimeoutRef.current = null;
    }, 15_000);
    try {
      await sendMessage("/restart");
    } catch {
      setPendingRestart(false);
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = null;
      }
      toastApi.error("Restart request failed");
    }
  }, [pendingRestart, sendMessage, toastApi]);

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

  const footer = useMemo(
    () => (
      <HermesRoomStatusFooter
        gatewayStatus={gatewayStatus}
        pendingRestart={pendingRestart}
        onPressRestart={handlePressRestart}
      />
    ),
    [gatewayStatus, pendingRestart, handlePressRestart],
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
      <ScreenHeader
        left={
          <>
            <SidebarMenuToggle />
            <ScreenTitle>Hermes</ScreenTitle>
          </>
        }
      />
      <View style={styles.contentContainer}>
        <AgentStreamView
          agentId={HERMES_ROOM_AGENT_ID}
          serverId={serverId}
          context={agent}
          streamItems={streamItems}
          pendingPermissions={EMPTY_PENDING_PERMISSIONS}
          turnPresentation={HERMES_TURN_PRESENTATION}
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
        textReplacement={HERMES_TEXT_REPLACEMENT}
        attachments={attachments}
        onChangeAttachments={handleChangeAttachments}
        cwd="."
        clearDraft={clearDraft}
        autoFocus={isFocused}
        attachmentMenuItemsOverride={HERMES_ATTACHMENT_MENU_ITEMS}
        footer={footer}
      />
      <ToastViewport toast={toast} onDismiss={dismiss} placement="panel" />
    </View>
  );
}

const MemoizedHermesRoomReadyState = memo(HermesRoomReadyState);

export function HermesRoomScreen({ serverId }: { serverId: string }) {
  const { messages, status, error, gatewayStatus, sendMessage } = useHermesRoom(serverId);

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
      gatewayStatus={gatewayStatus}
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
  gatewayStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  gatewayStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  gatewayStatusDotConnected: {
    backgroundColor: theme.colors.statusSuccess,
  },
  gatewayStatusDotDisconnected: {
    backgroundColor: theme.colors.statusDanger,
  },
  gatewayStatusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  gatewayFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
  },
  gatewayStatusDotPending: {
    backgroundColor: theme.colors.statusWarning,
  },
}));

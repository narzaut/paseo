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
import type { MessagePayload, TextReplacement } from "@/composer/types";
import type { HermesRoomMessage } from "@/hooks/use-hermes-room";
import { useHermesRoom } from "@/hooks/use-hermes-room";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
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
// Reserved draft-store identity for the single Hermes room per host. The draft
// lives in the shared composer draft store, so it survives unmounts, pane
// switches, and reloads exactly like workspace chat drafts do.
export const HERMES_ROOM_DRAFT_AGENT_ID = "hermes-room";

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

function useHermesRoomDraft(serverId: string) {
  const draftStoreKey = useMemo(
    () => buildDraftStoreKey({ serverId, agentId: HERMES_ROOM_DRAFT_AGENT_ID }),
    [serverId],
  );
  const [text, setText] = useState("");
  const revisionRef = useRef(0);
  const [textReplacement, setTextReplacement] = useState<TextReplacement>(() => ({
    key: `${draftStoreKey}:0`,
    text: "",
  }));

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await useDraftStore.getState().hydrateDraftInput({ draftKey: draftStoreKey });
      if (cancelled) {
        return;
      }
      const storedText = useDraftStore.getState().getDraftInput(draftStoreKey)?.text ?? "";
      if (storedText.length > 0) {
        revisionRef.current += 1;
        setTextReplacement({ key: `${draftStoreKey}:${revisionRef.current}`, text: storedText });
      }
      setText(storedText);
    })();
    return () => {
      cancelled = true;
    };
  }, [draftStoreKey]);

  const editText = useCallback(
    (nextText: string) => {
      setText(nextText);
      const store = useDraftStore.getState();
      if (nextText.length === 0) {
        store.clearDraftInput({ draftKey: draftStoreKey, lifecycle: "abandoned" });
        return;
      }
      store.saveDraftInput({ draftKey: draftStoreKey, draft: { text: nextText, attachments: [] } });
    },
    [draftStoreKey],
  );

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      useDraftStore.getState().clearDraftInput({ draftKey: draftStoreKey, lifecycle });
      setText("");
    },
    [draftStoreKey],
  );

  return { text, editText, textReplacement, clear };
}

function HermesRoomReadyState({
  serverId,
  messages,
  gatewayStatus,
  sendMessage,
  isFocused,
}: {
  serverId: string;
  messages: HermesRoomMessage[];
  gatewayStatus: "connected" | "disconnected";
  sendMessage: (text: string) => Promise<void>;
  isFocused: boolean;
}) {
  const { api: toastApi, toast, dismiss } = useToastHost();
  const draftInput = useHermesRoomDraft(serverId);
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

  const handleClearDraft = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      draftInput.clear(lifecycle);
      setAttachments([]);
    },
    [draftInput],
  );

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
    <View style={styles.root}>
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
        value={draftInput.text}
        onChangeText={draftInput.editText}
        textReplacement={draftInput.textReplacement}
        attachments={attachments}
        onChangeAttachments={handleChangeAttachments}
        cwd="."
        clearDraft={handleClearDraft}
        autoFocus={isFocused}
        attachmentMenuItemsOverride={HERMES_ATTACHMENT_MENU_ITEMS}
        footer={footer}
      />
      <ToastViewport toast={toast} onDismiss={dismiss} placement="panel" />
    </View>
  );
}

const MemoizedHermesRoomReadyState = memo(HermesRoomReadyState);

/**
 * The Hermes room's chat body — shared by the standalone route and the
 * workspace-shell panel so both render the identical room machinery.
 */
export function HermesRoomContent({
  serverId,
  isFocused,
}: {
  serverId: string;
  isFocused: boolean;
}) {
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
      isFocused={isFocused}
    />
  );
}

export function HermesRoomScreen({ serverId }: { serverId: string }) {
  const isFocused = useIsFocused();

  return (
    <View style={styles.screenRoot} testID="hermes-room-screen">
      <ScreenHeader
        left={
          <>
            <SidebarMenuToggle />
            <ScreenTitle>Hermes</ScreenTitle>
          </>
        }
      />
      <HermesRoomContent serverId={serverId} isFocused={isFocused} />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screenRoot: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
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

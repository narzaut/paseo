import { useEffect } from "react";
import { DEFAULT_PANE_ID, type WorkspaceTabPlacement } from "@/stores/workspace-layout-store";
import type { WorkspaceSetupStatusClient } from "@/stores/workspace-setup-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * Keeps exactly one Hermes room tab in the container workspace. The container
 * owns its content, so if the room tab was closed it gets re-seeded in the
 * background — the sidebar icon always lands on a room, the same way a normal
 * workspace always has a usable tab.
 */
export function useHermesRoomTabSeed(input: {
  isHermesRoomContainer: boolean;
  isRouteFocused: boolean;
  persistenceKey: string | null;
  hasHermesRoomTab: boolean;
  openWorkspaceTabInBackground: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => void;
}): void {
  const {
    isHermesRoomContainer,
    isRouteFocused,
    persistenceKey,
    hasHermesRoomTab,
    openWorkspaceTabInBackground,
  } = input;

  useEffect(() => {
    if (!isRouteFocused || !persistenceKey || !isHermesRoomContainer || hasHermesRoomTab) {
      return;
    }
    openWorkspaceTabInBackground(
      persistenceKey,
      { kind: "hermes_room" },
      {
        mode: "prefer",
        paneId: DEFAULT_PANE_ID,
      },
    );
  }, [
    hasHermesRoomTab,
    isHermesRoomContainer,
    isRouteFocused,
    openWorkspaceTabInBackground,
    persistenceKey,
  ]);
}

/**
 * Fetches workspace setup status while the route is focused. `enabled` is
 * false for the container workspace, which has no setup flow — leaving its
 * snapshot empty keeps it out of the setup UI and out of setup-tab seeding.
 */
export function useWorkspaceSetupStatusSync(input: {
  enabled: boolean;
  isRouteFocused: boolean;
  serverId: string;
  workspaceId: string;
  client: WorkspaceSetupStatusClient | null;
  ensureWorkspaceSetupStatus: (input: {
    serverId: string;
    workspaceId: string;
    client: WorkspaceSetupStatusClient;
  }) => void;
}): void {
  const { enabled, isRouteFocused, serverId, workspaceId, client, ensureWorkspaceSetupStatus } =
    input;

  useEffect(() => {
    if (!enabled || !isRouteFocused || !client || !serverId || !workspaceId) {
      return;
    }
    ensureWorkspaceSetupStatus({ serverId, workspaceId, client });
  }, [client, enabled, ensureWorkspaceSetupStatus, isRouteFocused, serverId, workspaceId]);
}

import { useEffect } from "react";
import { DEFAULT_PANE_ID, type WorkspaceTabPlacement } from "@/stores/workspace-layout-store";
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

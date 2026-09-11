import { useMemo } from "react";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { type HostProjectListItem } from "@/projects/host-project-model";
import { isHermesRoomContainerRootPath } from "@/utils/hermes-room-container";

export {
  canCreateWorkspaceForHostProject,
  canCreateWorktreeForProjectKind,
  filterWorkspaceProjectsForHost,
  getHostProjectSourceDirectory,
  getHostProjectId,
  getWorktreeSupportForHostProject,
  hostProjectFromRoute,
  hostProjectFromWorkspace,
  resolveHostProjectCandidate,
  resolveExactHostProjectCandidate,
  resolveEquivalentHostProjectCandidate,
  resolveInitialWorkspaceProject,
  resolveInitialWorktreeProject,
  resolveSelectedHostProject,
  type HostProjectListItem,
  type HostProjectRouteContext,
} from "@/projects/host-project-model";

export function useHostProjects(serverIds: string[]): HostProjectListItem[] {
  const workspaceStructure = useWorkspaceStructure(serverIds);
  const projects = workspaceStructure.projects;
  // The Hermes room container project hosts the room tab and never appears in
  // project/workspace listings, pickers, or the sidebar.
  return useMemo(() => {
    if (!projects.some((project) => isHermesRoomContainerRootPath(project.iconWorkingDir))) {
      return projects;
    }
    return projects.filter((project) => !isHermesRoomContainerRootPath(project.iconWorkingDir));
  }, [projects]);
}

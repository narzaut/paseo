import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";

// The Hermes room lives in a dedicated, hidden container workspace that hosts
// the room tab. It never appears in workspace listings; it exists so the room
// rides the normal workspace machinery (deck retention, tabs, terminals).
// ponytail: single-host constant — the fork daemon serves this VPS. Move to
// per-host config if the fork is ever deployed against other machines.
export const HERMES_ROOM_CONTAINER_DIR = "/home/ubuntu/paseo-hermes-room";
export const HERMES_ROOM_CONTAINER_WORKSPACE_TITLE = "Hermes";

type HermesRoomContainerClient = Pick<DaemonClient, "addProject" | "createWorkspace">;

export function isHermesRoomContainerRootPath(rootPath: string): boolean {
  return rootPath === HERMES_ROOM_CONTAINER_DIR;
}

export function isHermesRoomContainerProject(project: { projectRootPath: string }): boolean {
  return isHermesRoomContainerRootPath(project.projectRootPath);
}

export function isHermesRoomContainerWorkspace(workspace: { workspaceDirectory: string }): boolean {
  return isHermesRoomContainerRootPath(workspace.workspaceDirectory);
}

/**
 * Nullable-descriptor form for call sites that hold a maybe-workspace: keeps
 * the optional chain out of the component body (oxlint counts it as a branch).
 */
export function isHermesRoomContainerWorkspaceDescriptor(
  workspace: { workspaceDirectory?: string } | null | undefined,
): boolean {
  return workspace?.workspaceDirectory === HERMES_ROOM_CONTAINER_DIR;
}

export function findHermesRoomContainer(input: {
  projects: Iterable<ProjectDescriptor>;
  workspaces: Iterable<WorkspaceDescriptor>;
}): { project: ProjectDescriptor | null; workspace: WorkspaceDescriptor | null } {
  let project: ProjectDescriptor | null = null;
  for (const candidate of input.projects) {
    if (isHermesRoomContainerProject(candidate)) {
      project = candidate;
      break;
    }
  }
  let workspace: WorkspaceDescriptor | null = null;
  if (project) {
    for (const candidate of input.workspaces) {
      if (
        candidate.projectId === project.projectId &&
        isHermesRoomContainerWorkspace(candidate) &&
        !candidate.archivingAt
      ) {
        workspace = candidate;
        break;
      }
    }
  }
  return { project, workspace };
}

/**
 * Finds or lazily creates the Hermes room container workspace on the host.
 * Returns the workspace id, or null when the host cannot be reached / the
 * container directory is missing on the host.
 */
export async function ensureHermesRoomContainer(input: {
  serverId: string;
  client: HermesRoomContainerClient;
}): Promise<string | null> {
  const { serverId, client } = input;
  const session = useSessionStore.getState().sessions[serverId];
  if (!session) {
    return null;
  }

  let { project, workspace } = findHermesRoomContainer({
    projects: session.projects.values(),
    workspaces: session.workspaces.values(),
  });

  if (!project) {
    const payload = await client.addProject(HERMES_ROOM_CONTAINER_DIR);
    if (payload.error || !payload.project) {
      return null;
    }
    project = normalizeProjectDescriptor(payload.project);
    const store = useSessionStore.getState();
    store.upsertProject(serverId, project);
    store.setHasHydratedWorkspaces(serverId, true);
  }

  if (!workspace) {
    const payload = await client.createWorkspace({
      source: {
        kind: "directory",
        path: HERMES_ROOM_CONTAINER_DIR,
        projectId: project.projectId,
      },
      title: HERMES_ROOM_CONTAINER_WORKSPACE_TITLE,
    });
    if (payload.error || !payload.workspace) {
      return null;
    }
    workspace = normalizeWorkspaceDescriptor(payload.workspace);
    useSessionStore.getState().mergeWorkspaces(serverId, [workspace]);
  }

  return workspace.id;
}

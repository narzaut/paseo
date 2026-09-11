import { describe, expect, it } from "vitest";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import {
  findHermesRoomContainer,
  HERMES_ROOM_CONTAINER_DIR,
  isHermesRoomContainerProject,
  isHermesRoomContainerRootPath,
  isHermesRoomContainerWorkspace,
  isHermesRoomContainerWorkspaceDescriptor,
} from "./hermes-room-container";

function project(
  input: Partial<ProjectDescriptor> & { projectRootPath: string },
): ProjectDescriptor {
  return {
    projectId: "prj_container",
    projectDisplayName: "paseo-hermes-room",
    projectCustomName: null,
    projectKind: "non_git",
    ...input,
  } as ProjectDescriptor;
}

function workspace(
  input: Partial<WorkspaceDescriptor> & { workspaceDirectory: string },
): WorkspaceDescriptor {
  return {
    id: "wks_container",
    projectId: "prj_container",
    projectDisplayName: "paseo-hermes-room",
    projectRootPath: HERMES_ROOM_CONTAINER_DIR,
    workspaceKind: "local_checkout",
    projectKind: "non_git",
    name: "Hermes",
    status: "idle",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...input,
  } as WorkspaceDescriptor;
}

describe("hermes room container markers", () => {
  it("matches only the container root path", () => {
    expect(isHermesRoomContainerRootPath(HERMES_ROOM_CONTAINER_DIR)).toBe(true);
    expect(isHermesRoomContainerRootPath("/home/ubuntu/other")).toBe(false);
    expect(isHermesRoomContainerProject({ projectRootPath: HERMES_ROOM_CONTAINER_DIR })).toBe(true);
    expect(isHermesRoomContainerWorkspace({ workspaceDirectory: HERMES_ROOM_CONTAINER_DIR })).toBe(
      true,
    );
  });

  it("treats a missing workspace descriptor as not-container", () => {
    expect(
      isHermesRoomContainerWorkspaceDescriptor({ workspaceDirectory: HERMES_ROOM_CONTAINER_DIR }),
    ).toBe(true);
    expect(isHermesRoomContainerWorkspaceDescriptor(null)).toBe(false);
    expect(isHermesRoomContainerWorkspaceDescriptor(undefined)).toBe(false);
    expect(isHermesRoomContainerWorkspaceDescriptor({})).toBe(false);
    expect(isHermesRoomContainerWorkspaceDescriptor({ workspaceDirectory: "/tmp" })).toBe(false);
  });
});

describe("findHermesRoomContainer", () => {
  it("finds the container project and its live workspace", () => {
    const found = findHermesRoomContainer({
      projects: [
        project({ projectRootPath: "/home/ubuntu/workspace/app" }),
        project({ projectRootPath: HERMES_ROOM_CONTAINER_DIR }),
      ],
      workspaces: [
        workspace({ workspaceDirectory: "/home/ubuntu/workspace/app", projectId: "prj_other" }),
        workspace({ workspaceDirectory: HERMES_ROOM_CONTAINER_DIR }),
      ],
    });
    expect(found.project?.projectId).toBe("prj_container");
    expect(found.workspace?.id).toBe("wks_container");
  });

  it("ignores archiving container workspaces", () => {
    const found = findHermesRoomContainer({
      projects: [project({ projectRootPath: HERMES_ROOM_CONTAINER_DIR })],
      workspaces: [
        workspace({
          workspaceDirectory: HERMES_ROOM_CONTAINER_DIR,
          archivingAt: "2026-09-11T00:00:00.000Z",
        }),
      ],
    });
    expect(found.project?.projectId).toBe("prj_container");
    expect(found.workspace).toBeNull();
  });

  it("returns nulls when nothing matches", () => {
    const found = findHermesRoomContainer({
      projects: [project({ projectRootPath: "/home/ubuntu/workspace/app" })],
      workspaces: [],
    });
    expect(found.project).toBeNull();
    expect(found.workspace).toBeNull();
  });
});

/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: vi.fn(() => null),
}));

describe("useHermesRoom", () => {
  it("creates or reuses the Hermes room, loads recent messages, and sends text", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const { useHermesRoom } = await import("./use-hermes-room");
    const room = { id: "room-hermes", name: "Hermes" };
    const client = {
      listChatRooms: vi.fn().mockResolvedValue({ rooms: [] }),
      createChatRoom: vi.fn().mockResolvedValue({ room, error: null }),
      readChatMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "m1",
            roomId: "room-hermes",
            authorAgentId: "manual",
            body: "hello",
            replyToMessageId: null,
            mentionAgentIds: [],
            createdAt: "2026-06-30T00:00:00.000Z",
          },
        ],
        error: null,
      }),
      waitForChatMessages: vi.fn().mockImplementation(() => new Promise(() => {})),
      postChatMessage: vi.fn().mockResolvedValue({
        message: {
          id: "m2",
          roomId: "room-hermes",
          authorAgentId: "manual",
          body: "hi from browser",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-06-30T00:00:01.000Z",
        },
        error: null,
      }),
    };

    const { result } = renderHook(() => useHermesRoom("srv-test", client as never));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.messages.map((message) => message.body)).toEqual(["hello"]);
    expect(client.createChatRoom).toHaveBeenCalledWith({ name: "Hermes" });

    await act(async () => {
      await result.current.sendMessage("hi from browser");
    });

    expect(client.postChatMessage).toHaveBeenCalledWith({
      room: "room-hermes",
      body: "hi from browser",
      authorAgentId: "manual",
    });
  }, 15_000);

  it("waits on the seq cursor and applies an edited message in place", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    const { useHermesRoom } = await import("./use-hermes-room");
    const room = { id: "room-hermes", name: "Hermes" };
    let waitCalls = 0;
    const client = {
      listChatRooms: vi.fn().mockResolvedValue({ rooms: [room] }),
      createChatRoom: vi.fn(),
      readChatMessages: vi.fn().mockResolvedValue({
        messages: [
          {
            id: "h1",
            roomId: "room-hermes",
            authorAgentId: "hermes",
            body: "partial",
            replyToMessageId: null,
            mentionAgentIds: [],
            createdAt: "2026-06-30T00:00:00.000Z",
            seq: 5,
          },
        ],
        error: null,
      }),
      waitForChatMessages: vi.fn().mockImplementation(() => {
        waitCalls += 1;
        if (waitCalls === 1) {
          // The streamed message is edited in place: same id, bumped seq.
          return Promise.resolve({
            messages: [
              {
                id: "h1",
                roomId: "room-hermes",
                authorAgentId: "hermes",
                body: "partial then full",
                replyToMessageId: null,
                mentionAgentIds: [],
                createdAt: "2026-06-30T00:00:00.000Z",
                seq: 9,
              },
            ],
          });
        }
        return new Promise(() => {});
      }),
      postChatMessage: vi.fn(),
    };

    const { result } = renderHook(() => useHermesRoom("srv-test", client as never));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    // History seeds the cursor at seq 5; the wait uses afterSeq, not afterMessageId.
    expect(client.waitForChatMessages).toHaveBeenCalledWith({
      room: "room-hermes",
      afterSeq: 5,
      timeoutMs: 30000,
    });
    // Edit replaces in place — one message, grown body (no duplicate).
    const bodies = () => result.current.messages.map((message) => message.body);
    await waitFor(() => expect(bodies()).toEqual(["partial then full"]));
    // Cursor advanced to the edit's seq for the next wait.
    await waitFor(() =>
      expect(client.waitForChatMessages).toHaveBeenLastCalledWith({
        room: "room-hermes",
        afterSeq: 9,
        timeoutMs: 30000,
      }),
    );
  });
});

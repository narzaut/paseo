import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import {
  type HermesRoomServiceError,
  FileBackedHermesRoomService,
  parseMentionAgentIds,
  type PostChatMessageInput,
} from "./hermes-room-service.js";

describe("FileBackedHermesRoomService", () => {
  let paseoHome: string;
  let service: FileBackedHermesRoomService;

  async function sendChatMessage(input: PostChatMessageInput) {
    return await service.dispatchMessage(input);
  }

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-chat-service-"));
    service = new FileBackedHermesRoomService({
      paseoHome,
      logger: pino({ level: "silent" }),
    });
    await service.initialize();
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates rooms, enforces unique names, and persists to disk", async () => {
    const created = await service.createRoom({
      name: "cli-features-epic",
      purpose: "Coordination room",
    });

    await expect(
      service.createRoom({
        name: "CLI-FEATURES-EPIC",
      }),
    ).rejects.toMatchObject<Partial<HermesRoomServiceError>>({
      code: "chat_room_name_taken",
    });

    const raw = await readFile(path.join(paseoHome, "chat", "rooms.json"), "utf8");
    expect(raw).toContain("cli-features-epic");
    expect(created.name).toBe("cli-features-epic");
    expect(created.purpose).toBe("Coordination room");
    expect(created.messageCount).toBe(0);
  });

  test("resolves rooms by name or ID, validates replies, and reads filtered messages", async () => {
    const room = await service.createRoom({ name: "auth-refactor" });
    const first = await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "first message for @agent-b and @agent-c and again @agent-b",
    });
    await sendChatMessage({
      room: room.id,
      authorAgentId: "agent-b",
      body: "reply",
      replyToMessageId: first.id,
    });

    await expect(
      sendChatMessage({
        room: room.name,
        authorAgentId: "agent-b",
        body: "bad reply",
        replyToMessageId: "missing",
      }),
    ).rejects.toMatchObject<Partial<HermesRoomServiceError>>({
      code: "chat_message_not_found",
    });

    const all = await service.readMessages({ room: room.name, limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0]?.mentionAgentIds).toEqual(["agent-b", "agent-c"]);

    const byAuthor = await service.readMessages({
      room: room.id,
      authorAgentId: "agent-b",
      limit: 10,
    });
    expect(byAuthor).toHaveLength(1);
    expect(byAuthor[0]?.body).toBe("reply");

    const detail = await service.inspectRoom({ room: room.name });
    expect(detail.room.messageCount).toBe(2);
    expect(detail.room.lastMessageAt).toBeTruthy();
  });

  test("lists unique agents who have posted to a room", async () => {
    const room = await service.createRoom({ name: "incident-room" });
    const otherRoom = await service.createRoom({ name: "other-room" });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "first",
    });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-b",
      body: "second",
    });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "third",
    });
    await sendChatMessage({
      room: otherRoom.name,
      authorAgentId: "unrelated-agent",
      body: "different room",
    });

    await expect(service.listRoomPosterAgentIds({ room: room.name })).resolves.toEqual([
      "agent-a",
      "agent-b",
    ]);
  });

  test("waits for new messages after a cursor and times out with an empty result", async () => {
    const room = await service.createRoom({ name: "loop-status" });
    const first = await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "ready",
    });

    const waitPromise = service.waitForMessages({
      room: room.name,
      afterMessageId: first.id,
      timeoutMs: 1000,
    });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-b",
      body: "new work",
    });

    const waited = await waitPromise;
    expect(waited).toHaveLength(1);
    expect(waited[0]?.body).toBe("new work");

    const timedOut = await service.waitForMessages({
      room: room.name,
      afterMessageId: waited[0]?.id,
      timeoutMs: 10,
    });
    expect(timedOut).toEqual([]);
  });

  test("deletes rooms, removes messages, and rejects pending waiters", async () => {
    const room = await service.createRoom({ name: "schedule-jobs" });
    await sendChatMessage({
      room: room.name,
      authorAgentId: "agent-a",
      body: "hello",
    });

    const waitPromise = service.waitForMessages({
      room: room.name,
      timeoutMs: 1000,
    });
    const deleted = await service.deleteRoom({ room: room.id });
    expect(deleted.room.messageCount).toBe(1);

    await expect(waitPromise).rejects.toMatchObject<Partial<HermesRoomServiceError>>({
      code: "chat_room_deleted",
    });
    await expect(service.inspectRoom({ room: room.name })).rejects.toMatchObject<
      Partial<HermesRoomServiceError>
    >({
      code: "chat_room_not_found",
    });
  });

  test("extracts inline mentions from chat bodies", () => {
    expect(
      parseMentionAgentIds(
        "Checking with @agent-a, (@agent_b), @everyone, and duplicate @agent-a again.",
      ),
    ).toEqual(["agent-a", "agent_b", "everyone"]);
    expect(parseMentionAgentIds("email@example.com is not a mention")).toEqual([]);
  });

  test("assigns a monotonic seq on post and bumps it on edit, preserving createdAt", async () => {
    const room = await service.createRoom({ name: "stream" });
    const first = await sendChatMessage({
      room: room.id,
      authorAgentId: "hermes",
      body: "partial",
    });
    const second = await sendChatMessage({ room: room.id, authorAgentId: "hermes", body: "other" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const edited = await service.editMessage({
      room: room.id,
      messageId: first.id,
      body: "partial → full",
    });
    expect(edited.id).toBe(first.id);
    expect(edited.body).toBe("partial → full");
    expect(edited.createdAt).toBe(first.createdAt); // anchored in the timeline
    expect(edited.seq).toBe(3); // floated past every prior cursor
    expect(edited.updatedAt).not.toBe(first.updatedAt);
  });

  test("rejects editing a missing message", async () => {
    const room = await service.createRoom({ name: "stream" });
    await expect(
      service.editMessage({ room: room.id, messageId: "nope", body: "x" }),
    ).rejects.toMatchObject<Partial<HermesRoomServiceError>>({ code: "chat_message_not_found" });
  });

  test("afterSeq wait resolves with an edited message that a positional cursor would miss", async () => {
    const room = await service.createRoom({ name: "stream" });
    const message = await sendChatMessage({ room: room.id, authorAgentId: "hermes", body: "a" });

    // Client has seen up to message.seq. A positional afterMessageId cursor on
    // this same message would never see the edit; the seq cursor does.
    const waitPromise = service.waitForMessages({
      room: room.id,
      afterSeq: message.seq,
      timeoutMs: 1000,
    });
    const edited = await service.editMessage({ room: room.id, messageId: message.id, body: "ab" });
    const delivered = await waitPromise;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.id).toBe(message.id);
    expect(delivered[0]?.body).toBe("ab");
    expect(delivered[0]?.seq).toBe(edited.seq);
  });

  test("afterSeq wait returns immediately when newer messages already exist", async () => {
    const room = await service.createRoom({ name: "stream" });
    const first = await sendChatMessage({ room: room.id, authorAgentId: "hermes", body: "a" });
    await sendChatMessage({ room: room.id, authorAgentId: "hermes", body: "b" });
    const delivered = await service.waitForMessages({ room: room.id, afterSeq: first.seq });
    expect(delivered.map((m) => m.body)).toEqual(["b"]);
  });

  test("backfills seq for a legacy store that predates the edit protocol", async () => {
    const legacy = {
      rooms: [
        {
          id: "room-1",
          name: "legacy",
          purpose: null,
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:02.000Z",
        },
      ],
      messages: [
        {
          id: "m-2",
          roomId: "room-1",
          authorAgentId: "hermes",
          body: "second",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-06-30T00:00:02.000Z",
        },
        {
          id: "m-1",
          roomId: "room-1",
          authorAgentId: "manual",
          body: "first",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-06-30T00:00:01.000Z",
        },
      ],
    };
    const legacyHome = await mkdtemp(path.join(tmpdir(), "paseo-chat-legacy-"));
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(path.join(legacyHome, "chat"), { recursive: true }),
    );
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path.join(legacyHome, "chat", "rooms.json"), JSON.stringify(legacy), "utf8"),
    );
    const legacyService = new FileBackedHermesRoomService({
      paseoHome: legacyHome,
      logger: pino({ level: "silent" }),
    });
    await legacyService.initialize();

    // seq filled in createdAt order (m-1 before m-2), and a fresh post continues
    // the sequence past the backfilled max.
    const next = await legacyService.dispatchMessage({
      room: "room-1",
      authorAgentId: "hermes",
      body: "third",
    });
    expect(next.seq).toBe(3);
    const all = await legacyService.readMessages({ room: "room-1", limit: 0 });
    const byId = new Map(all.map((m) => [m.id, m.seq]));
    expect(byId.get("m-1")).toBe(1);
    expect(byId.get("m-2")).toBe(2);
    await rm(legacyHome, { recursive: true, force: true });
  });
});

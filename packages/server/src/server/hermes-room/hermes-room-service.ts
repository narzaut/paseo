import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  ChatMessageSchema,
  ChatRoomDetailSchema,
  ChatRoomSchema,
  type ChatMessage,
  type ChatRoom,
  type ChatRoomDetail,
} from "@getpaseo/protocol/chat/types";

const HermesRoomStorePayloadSchema = z.object({
  rooms: z.array(ChatRoomSchema),
  messages: z.array(ChatMessageSchema),
});

type HermesRoomStorePayload = z.infer<typeof HermesRoomStorePayloadSchema>;

function normalizeRoomName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const CHAT_MENTION_PATTERN = /(?:^|[\s(])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;

export function parseMentionAgentIds(body: string): string[] {
  const mentionAgentIds = new Set<string>();
  for (const match of body.matchAll(CHAT_MENTION_PATTERN)) {
    const agentId = match[1]?.trim();
    if (agentId) {
      mentionAgentIds.add(agentId);
    }
  }
  return Array.from(mentionAgentIds).sort();
}

export class HermesRoomServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HermesRoomServiceError";
    this.code = code;
  }
}

interface Waiter {
  roomId: string;
  afterMessageId: string | null;
  // Edit-aware cursor. When non-null, the waiter resolves with messages whose
  // seq > afterSeq (new OR edited), and afterMessageId is ignored.
  afterSeq: number | null;
  resolve: (messages: ChatMessage[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

export interface CreateChatRoomInput {
  name: string;
  purpose?: string | null;
}

export interface InspectChatRoomInput {
  room: string;
}

export interface DeleteChatRoomInput {
  room: string;
}

export interface PostChatMessageInput {
  room: string;
  authorAgentId: string;
  body: string;
  replyToMessageId?: string | null;
}

export interface EditChatMessageInput {
  room: string;
  messageId: string;
  body: string;
}

export interface ReadChatMessagesInput {
  room: string;
  limit?: number;
  since?: string;
  authorAgentId?: string;
}

export interface ListChatRoomPosterAgentIdsInput {
  room: string;
}

export interface WaitForChatMessagesInput {
  room: string;
  afterMessageId?: string | null;
  afterSeq?: number;
  timeoutMs?: number;
}

export interface DeleteChatRoomResult {
  room: ChatRoomDetail;
}

export interface InspectChatRoomResult {
  room: ChatRoomDetail;
}

export class FileBackedHermesRoomService {
  private readonly filePath: string;
  private readonly logger: pino.Logger;
  private loaded = false;
  private readonly rooms = new Map<string, ChatRoom>();
  private readonly messagesByRoomId = new Map<string, ChatMessage[]>();
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly waitersByRoomId = new Map<string, Set<Waiter>>();
  // Monotonic, server-assigned sequence shared across all rooms. Bumped on
  // every create AND edit so an edit-aware `chat/wait` (afterSeq) re-delivers
  // edited messages. Seeded from the persisted store on load.
  private seqCounter = 0;

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "chat", "rooms.json");
    this.logger = options.logger.child({ component: "hermes-room-service" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async createRoom(input: CreateChatRoomInput): Promise<ChatRoomDetail> {
    await this.load();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new HermesRoomServiceError("invalid_chat_room_name", "Chat room name is required");
    }
    if (this.findRoomByName(name)) {
      throw new HermesRoomServiceError(
        "chat_room_name_taken",
        `Chat room already exists with name: ${name}`,
      );
    }

    const now = new Date().toISOString();
    const room = ChatRoomSchema.parse({
      id: randomUUID(),
      name,
      purpose: trimToNull(input.purpose),
      createdAt: now,
      updatedAt: now,
    });
    this.rooms.set(room.id, room);
    await this.enqueuePersist();
    return this.toRoomDetail(room);
  }

  async listRooms(): Promise<ChatRoomDetail[]> {
    await this.load();
    return Array.from(this.rooms.values())
      .map((room) => this.toRoomDetail(room))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async inspectRoom(input: InspectChatRoomInput): Promise<InspectChatRoomResult> {
    await this.load();
    const room = this.resolveRoom(input.room);
    return {
      room: this.toRoomDetail(room),
    };
  }

  async deleteRoom(input: DeleteChatRoomInput): Promise<DeleteChatRoomResult> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const detail = this.toRoomDetail(room);
    this.rooms.delete(room.id);
    this.messagesByRoomId.delete(room.id);
    await this.enqueuePersist();
    this.rejectWaiters(
      room.id,
      new HermesRoomServiceError("chat_room_deleted", `Chat room deleted: ${room.name}`),
    );
    return { room: detail };
  }

  async dispatchMessage(input: PostChatMessageInput): Promise<ChatMessage> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const body = input.body.trim();
    if (body.length === 0) {
      throw new HermesRoomServiceError("invalid_chat_message", "Chat message body is required");
    }
    const authorAgentId = input.authorAgentId.trim();
    if (authorAgentId.length === 0) {
      throw new HermesRoomServiceError("invalid_chat_author", "Chat message author is required");
    }

    const messages = this.getRoomMessages(room.id);
    const replyToMessageId = trimToNull(input.replyToMessageId);
    if (replyToMessageId) {
      const replyTarget = messages.find((message) => message.id === replyToMessageId);
      if (!replyTarget) {
        throw new HermesRoomServiceError(
          "chat_message_not_found",
          `Reply target not found: ${replyToMessageId}`,
        );
      }
    }

    const createdAt = new Date().toISOString();
    const message = ChatMessageSchema.parse({
      id: randomUUID(),
      roomId: room.id,
      authorAgentId,
      body,
      replyToMessageId,
      mentionAgentIds: parseMentionAgentIds(body),
      createdAt,
      updatedAt: createdAt,
      seq: (this.seqCounter += 1),
    });

    messages.push(message);
    this.messagesByRoomId.set(room.id, messages);
    this.rooms.set(
      room.id,
      ChatRoomSchema.parse({
        ...room,
        updatedAt: createdAt,
      }),
    );
    await this.enqueuePersist();
    this.notifyWaiters(room.id);
    return message;
  }

  async editMessage(input: EditChatMessageInput): Promise<ChatMessage> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const body = input.body.trim();
    if (body.length === 0) {
      throw new HermesRoomServiceError("invalid_chat_message", "Chat message body is required");
    }

    const messages = this.getRoomMessages(room.id);
    const index = messages.findIndex((message) => message.id === input.messageId);
    if (index === -1) {
      throw new HermesRoomServiceError(
        "chat_message_not_found",
        `Message to edit not found: ${input.messageId}`,
      );
    }

    const updatedAt = new Date().toISOString();
    // Bumping seq floats the edited message past every existing wait cursor so
    // afterSeq waiters re-deliver it; createdAt is preserved so the message
    // keeps its place in the client's chronological view while its body grows.
    const updated = ChatMessageSchema.parse({
      ...messages[index],
      body,
      mentionAgentIds: parseMentionAgentIds(body),
      updatedAt,
      seq: (this.seqCounter += 1),
    });
    messages[index] = updated;
    this.messagesByRoomId.set(room.id, messages);
    this.rooms.set(room.id, ChatRoomSchema.parse({ ...room, updatedAt }));
    await this.enqueuePersist();
    this.notifyWaiters(room.id);
    return updated;
  }

  async readMessages(input: ReadChatMessagesInput): Promise<ChatMessage[]> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const messages = [...this.getRoomMessages(room.id)];
    const since = trimToNull(input.since);
    const authorAgentId = trimToNull(input.authorAgentId);
    const limit = this.normalizeLimit(input.limit);

    const filtered = messages.filter((message) => {
      if (since && message.createdAt < since) {
        return false;
      }
      if (authorAgentId && message.authorAgentId !== authorAgentId) {
        return false;
      }
      return true;
    });

    if (limit === 0 || filtered.length <= limit) {
      return filtered;
    }
    return filtered.slice(filtered.length - limit);
  }

  async listRoomPosterAgentIds(input: ListChatRoomPosterAgentIdsInput): Promise<string[]> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const posters = new Set<string>();
    for (const message of this.getRoomMessages(room.id)) {
      posters.add(message.authorAgentId);
    }
    return Array.from(posters);
  }

  async waitForMessages(input: WaitForChatMessagesInput): Promise<ChatMessage[]> {
    await this.load();
    const room = this.resolveRoom(input.room);
    const timeoutMs = Math.max(0, Math.floor(input.timeoutMs ?? 0));

    // Edit-aware seq cursor takes precedence: returns new AND edited messages.
    if (input.afterSeq !== undefined) {
      const existing = this.selectMessagesAfterSeq(room.id, input.afterSeq);
      if (existing.length > 0) {
        return existing;
      }
      return this.registerWaiter(room.id, {
        afterMessageId: null,
        afterSeq: input.afterSeq,
        timeoutMs,
      });
    }

    const afterMessageId = trimToNull(input.afterMessageId);
    if (afterMessageId) {
      const existing = this.selectMessagesAfter(room.id, afterMessageId);
      if (existing.length > 0) {
        return existing;
      }
      const knownMessage = this.getRoomMessages(room.id).some(
        (message) => message.id === afterMessageId,
      );
      if (!knownMessage) {
        throw new HermesRoomServiceError(
          "chat_message_not_found",
          `Wait cursor not found: ${afterMessageId}`,
        );
      }
    }

    return this.registerWaiter(room.id, { afterMessageId, afterSeq: null, timeoutMs });
  }

  private registerWaiter(
    roomId: string,
    cursor: { afterMessageId: string | null; afterSeq: number | null; timeoutMs: number },
  ): Promise<ChatMessage[]> {
    return new Promise<ChatMessage[]>((resolve, reject) => {
      const waiter: Waiter = {
        roomId,
        afterMessageId: cursor.afterMessageId,
        afterSeq: cursor.afterSeq,
        resolve: (messages) => {
          if (waiter.timeout) {
            clearTimeout(waiter.timeout);
            waiter.timeout = null;
          }
          this.removeWaiter(waiter);
          resolve(messages);
        },
        reject: (error) => {
          if (waiter.timeout) {
            clearTimeout(waiter.timeout);
            waiter.timeout = null;
          }
          this.removeWaiter(waiter);
          reject(error);
        },
        timeout: null,
      };

      if (cursor.timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiter.resolve([]);
        }, cursor.timeoutMs);
      }

      const roomWaiters = this.waitersByRoomId.get(roomId) ?? new Set<Waiter>();
      roomWaiters.add(waiter);
      this.waitersByRoomId.set(roomId, roomWaiters);
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.rooms.clear();
    this.messagesByRoomId.clear();

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = HermesRoomStorePayloadSchema.parse(JSON.parse(raw));
      for (const room of parsed.rooms) {
        this.rooms.set(room.id, room);
      }
      for (const message of parsed.messages) {
        const messages = this.messagesByRoomId.get(message.roomId) ?? [];
        messages.push(message);
        this.messagesByRoomId.set(message.roomId, messages);
      }
      this.backfillSeq(parsed.messages);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load chat store");
      }
    }

    this.loaded = true;
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }

  private async persist(): Promise<void> {
    const payload: HermesRoomStorePayload = {
      rooms: Array.from(this.rooms.values()).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      messages: Array.from(this.messagesByRoomId.values())
        .flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
    await writeJsonFileAtomic(this.filePath, payload);
  }

  private findRoomByName(name: string): ChatRoom | null {
    const normalizedName = normalizeRoomName(name);
    for (const room of this.rooms.values()) {
      if (normalizeRoomName(room.name) === normalizedName) {
        return room;
      }
    }
    return null;
  }

  private resolveRoom(roomSelector: string): ChatRoom {
    const selector = roomSelector.trim();
    if (selector.length === 0) {
      throw new HermesRoomServiceError("invalid_chat_room", "Chat room name or ID is required");
    }
    const byId = this.rooms.get(selector);
    if (byId) {
      return byId;
    }
    const byName = this.findRoomByName(selector);
    if (byName) {
      return byName;
    }
    throw new HermesRoomServiceError("chat_room_not_found", `Chat room not found: ${selector}`);
  }

  private getRoomMessages(roomId: string): ChatMessage[] {
    return this.messagesByRoomId.get(roomId) ?? [];
  }

  private toRoomDetail(room: ChatRoom): ChatRoomDetail {
    const messages = this.getRoomMessages(room.id);
    return ChatRoomDetailSchema.parse({
      ...room,
      messageCount: messages.length,
      lastMessageAt: messages[messages.length - 1]?.createdAt ?? null,
    });
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) {
      return 20;
    }
    const normalized = Math.max(0, Math.floor(limit));
    return normalized;
  }

  private selectMessagesAfter(roomId: string, afterMessageId: string): ChatMessage[] {
    const messages = this.getRoomMessages(roomId);
    const index = messages.findIndex((message) => message.id === afterMessageId);
    if (index === -1) {
      return [];
    }
    return messages.slice(index + 1);
  }

  private selectMessagesAfterSeq(roomId: string, afterSeq: number): ChatMessage[] {
    return this.getRoomMessages(roomId)
      .filter((message) => (message.seq ?? 0) > afterSeq)
      .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  }

  private resolveWaiterMessages(waiter: Waiter): ChatMessage[] {
    if (waiter.afterSeq !== null) {
      return this.selectMessagesAfterSeq(waiter.roomId, waiter.afterSeq);
    }
    if (waiter.afterMessageId === null) {
      return this.getRoomMessages(waiter.roomId).slice(-1);
    }
    return this.selectMessagesAfter(waiter.roomId, waiter.afterMessageId);
  }

  private notifyWaiters(roomId: string): void {
    const waiters = this.waitersByRoomId.get(roomId);
    if (!waiters || waiters.size === 0) {
      return;
    }

    for (const waiter of Array.from(waiters)) {
      const messages = this.resolveWaiterMessages(waiter);
      if (messages.length === 0) {
        continue;
      }
      waiter.resolve(messages);
    }
  }

  /**
   * Assign a seq (and updatedAt) to any persisted message that predates the
   * edit-aware protocol, so the in-memory store always has a monotonic cursor.
   * Existing seqs are honored; missing ones are filled in createdAt order after
   * the current max. Seeds {@link seqCounter} to the highest seq seen.
   */
  private backfillSeq(messages: ChatMessage[]): void {
    let maxSeq = 0;
    for (const message of messages) {
      if (typeof message.seq === "number") {
        maxSeq = Math.max(maxSeq, message.seq);
      }
    }
    const missing = messages
      .filter((message) => typeof message.seq !== "number")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const message of missing) {
      maxSeq += 1;
      message.seq = maxSeq;
      if (message.updatedAt === undefined) {
        message.updatedAt = message.createdAt;
      }
    }
    this.seqCounter = maxSeq;
  }

  private removeWaiter(waiter: Waiter): void {
    const waiters = this.waitersByRoomId.get(waiter.roomId);
    if (!waiters) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.waitersByRoomId.delete(waiter.roomId);
    }
  }

  private rejectWaiters(roomId: string, error: Error): void {
    const waiters = this.waitersByRoomId.get(roomId);
    if (!waiters) {
      return;
    }
    for (const waiter of Array.from(waiters)) {
      waiter.reject(error);
    }
  }
}

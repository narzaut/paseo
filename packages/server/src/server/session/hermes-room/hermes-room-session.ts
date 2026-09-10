import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  HermesRoomServiceError,
  type FileBackedHermesRoomService,
} from "../../hermes-room/hermes-room-service.js";

export interface HermesRoomSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface HermesRoomSessionOptions {
  host: HermesRoomSessionHost;
  service: FileBackedHermesRoomService;
  clientId: string;
  logger: pino.Logger;
}

/** Routes the legacy chat wire surface used by the custom Hermes gateway and room UI. */
export class HermesRoomSession {
  private readonly host: HermesRoomSessionHost;
  private readonly service: FileBackedHermesRoomService;
  private readonly clientId: string;
  private readonly logger: pino.Logger;

  constructor(options: HermesRoomSessionOptions) {
    this.host = options.host;
    this.service = options.service;
    this.clientId = options.clientId;
    this.logger = options.logger;
  }

  private emitError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : "Hermes room request failed";
    const code =
      error instanceof HermesRoomServiceError ? error.code : "hermes_room_request_failed";
    this.logger.error({ err: error, requestType: request.type }, "Hermes room request failed");
    this.host.emit({
      type: "rpc_error",
      payload: { requestId: request.requestId, requestType: request.type, error: message, code },
    });
  }

  async handleCreate(
    request: Extract<SessionInboundMessage, { type: "chat/create" }>,
  ): Promise<void> {
    try {
      const room = await this.service.createRoom({ name: request.name, purpose: request.purpose });
      this.host.emit({
        type: "chat/create/response",
        payload: { requestId: request.requestId, room, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleList(request: Extract<SessionInboundMessage, { type: "chat/list" }>): Promise<void> {
    try {
      const rooms = await this.service.listRooms();
      this.host.emit({
        type: "chat/list/response",
        payload: { requestId: request.requestId, rooms, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleInspect(
    request: Extract<SessionInboundMessage, { type: "chat/inspect" }>,
  ): Promise<void> {
    try {
      const { room } = await this.service.inspectRoom({ room: request.room });
      this.host.emit({
        type: "chat/inspect/response",
        payload: { requestId: request.requestId, room, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleDelete(
    request: Extract<SessionInboundMessage, { type: "chat/delete" }>,
  ): Promise<void> {
    try {
      const { room } = await this.service.deleteRoom({ room: request.room });
      this.host.emit({
        type: "chat/delete/response",
        payload: { requestId: request.requestId, room, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handlePost(request: Extract<SessionInboundMessage, { type: "chat/post" }>): Promise<void> {
    try {
      const message = await this.service.dispatchMessage({
        room: request.room,
        authorAgentId: request.authorAgentId?.trim() || this.clientId,
        body: request.body,
        replyToMessageId: request.replyToMessageId,
      });
      this.host.emit({
        type: "chat/post/response",
        payload: { requestId: request.requestId, message, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleEdit(request: Extract<SessionInboundMessage, { type: "chat/edit" }>): Promise<void> {
    try {
      const message = await this.service.editMessage({
        room: request.room,
        messageId: request.messageId,
        body: request.body,
      });
      this.host.emit({
        type: "chat/edit/response",
        payload: { requestId: request.requestId, message, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleRead(request: Extract<SessionInboundMessage, { type: "chat/read" }>): Promise<void> {
    try {
      const messages = await this.service.readMessages({
        room: request.room,
        limit: request.limit,
        since: request.since,
        authorAgentId: request.authorAgentId,
      });
      this.host.emit({
        type: "chat/read/response",
        payload: { requestId: request.requestId, messages, error: null },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }

  async handleWait(request: Extract<SessionInboundMessage, { type: "chat/wait" }>): Promise<void> {
    try {
      const messages = await this.service.waitForMessages({
        room: request.room,
        afterMessageId: request.afterMessageId,
        afterSeq: request.afterSeq,
        timeoutMs: request.timeoutMs,
      });
      this.host.emit({
        type: "chat/wait/response",
        payload: {
          requestId: request.requestId,
          messages,
          timedOut: messages.length === 0,
          error: null,
        },
      });
    } catch (error) {
      this.emitError(request, error);
    }
  }
}

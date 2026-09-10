import { useCallback, useEffect, useRef, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  parseHermesGatewayStatus,
  type HermesGatewayStatus,
} from "@/screens/hermes-event-envelope";

export const HERMES_ROOM_NAME = "Hermes";
export const MANUAL_AUTHOR_ID = "manual";

export interface HermesRoomMessage {
  id: string;
  roomId: string;
  authorAgentId: string;
  body: string;
  replyToMessageId: string | null;
  mentionAgentIds: string[];
  createdAt: string;
  updatedAt?: string;
  // Monotonic server cursor (bumped on create AND edit). Optional on the wire
  // for back-compat; the fork daemon always sets it. Drives the edit-aware
  // wait so streamed/edited messages reach the room.
  seq?: number;
}

interface HermesRoomDetail {
  id: string;
  name: string;
}

export interface HermesRoomClient {
  listChatRooms(): Promise<{ rooms: HermesRoomDetail[]; error?: string | null }>;
  createChatRoom(options: { name: string; purpose?: string }): Promise<{
    room: HermesRoomDetail | null;
    error?: string | null;
  }>;
  readChatMessages(options: { room: string; limit?: number }): Promise<{
    messages: HermesRoomMessage[];
    error?: string | null;
  }>;
  waitForChatMessages(options: {
    room: string;
    afterMessageId?: string;
    afterSeq?: number;
    timeoutMs?: number;
  }): Promise<{
    messages: HermesRoomMessage[];
    timedOut?: boolean;
    error?: string | null;
  }>;
  postChatMessage(options: { room: string; body: string; authorAgentId?: string }): Promise<{
    message: HermesRoomMessage | null;
    error?: string | null;
  }>;
}

function mergeMessages(current: HermesRoomMessage[], incoming: HermesRoomMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    // Merge by id so an edited message (same id, bumped seq, grown body)
    // replaces its prior version in place rather than appending a duplicate.
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function maxSeq(messages: HermesRoomMessage[]): number {
  let max = 0;
  for (const message of messages) {
    if (typeof message.seq === "number" && message.seq > max) {
      max = message.seq;
    }
  }
  return max;
}

function resolveGatewayStatus(messages: HermesRoomMessage[]): HermesGatewayStatus {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const status = parseHermesGatewayStatus(messages[index]?.body ?? "");
    if (status) {
      return status;
    }
  }
  return "disconnected";
}

export function useHermesRoom(serverId: string, clientOverride?: HermesRoomClient | null) {
  const sessionClient = useHostRuntimeClient(serverId);
  const client = (clientOverride ?? sessionClient) as HermesRoomClient | null;
  const [roomId, setRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<HermesRoomMessage[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<HermesGatewayStatus>("disconnected");
  const lastSeenSeqRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (!client) {
        setStatus("loading");
        return;
      }
      setStatus("loading");
      setError(null);
      try {
        const listed = await client.listChatRooms();
        const existing = listed.rooms.find((room) => room.name === HERMES_ROOM_NAME);
        const room = existing ?? (await client.createChatRoom({ name: HERMES_ROOM_NAME })).room;
        if (!room || cancelled) {
          return;
        }
        setRoomId(room.id);
        const history = await client.readChatMessages({ room: room.id, limit: 50 });
        if (cancelled) {
          return;
        }
        setMessages(history.messages);
        lastSeenSeqRef.current = maxSeq(history.messages);
        setStatus("ready");

        for (;;) {
          if (cancelled) {
            return;
          }
          const next = await client.waitForChatMessages({
            room: room.id,
            afterSeq: lastSeenSeqRef.current,
            timeoutMs: 30000,
          });
          if (cancelled || next.messages.length === 0) {
            continue;
          }
          lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, maxSeq(next.messages));
          setMessages((current) => mergeMessages(current, next.messages));
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(
            caughtError instanceof Error ? caughtError.message : "Failed to load Hermes room",
          );
          setStatus("error");
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [client, serverId]);

  useEffect(() => {
    setGatewayStatus(resolveGatewayStatus(messages));
  }, [messages]);

  const sendMessage = useCallback(
    async (text: string) => {
      const normalized = text.trim();
      if (!client || !roomId || normalized.length === 0) {
        return;
      }
      const payload = await client.postChatMessage({
        room: roomId,
        body: normalized,
        authorAgentId: MANUAL_AUTHOR_ID,
      });
      const message = payload.message;
      if (!message) {
        return;
      }
      lastSeenSeqRef.current = Math.max(lastSeenSeqRef.current, message.seq ?? 0);
      setMessages((current) => mergeMessages(current, [message]));
    },
    [client, roomId],
  );

  return { roomId, messages, status, error, gatewayStatus, sendMessage };
}

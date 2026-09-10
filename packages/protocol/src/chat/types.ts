import { z } from "zod";

// COMPAT(chatRooms): retained after the v0.3.0 feature removal; remove after 2027-02-09 when mixed-version peers no longer send legacy messages.

export const ChatRoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ChatRoom = z.infer<typeof ChatRoomSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  authorAgentId: z.string(),
  body: z.string(),
  replyToMessageId: z.string().nullable(),
  mentionAgentIds: z.array(z.string()),
  createdAt: z.string(),
  // COMPAT(chatMessageEdit): added 2026-06-30, drop optionality when floor >= the
  // release that ships chat/edit. `updatedAt` tracks the last edit (defaults to
  // createdAt on the wire for unedited messages); `seq` is a monotonic
  // server-assigned sequence bumped on create AND edit, so an edit-aware
  // `chat/wait` cursor (afterSeq) re-delivers an edited message. Optional so a
  // 6-month-old client still parses messages from a new daemon and a new client
  // still parses a legacy store / old daemon that never set them.
  updatedAt: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRoomDetailSchema = ChatRoomSchema.extend({
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
});

export type ChatRoomDetail = z.infer<typeof ChatRoomDetailSchema>;

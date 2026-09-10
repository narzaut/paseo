import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem } from "@/types/stream";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import type { HermesRoomMessage } from "@/hooks/use-hermes-room";
import {
  type HermesEventEnvelope,
  parseHermesEventEnvelope,
  parseHermesGatewayStatus,
} from "@/screens/hermes-event-envelope";

export const HERMES_ROOM_AGENT_ID = "hermes-room";
const HERMES_AUTHOR_ID = "hermes";
const HERMES_ROOM_CWD = ".";
const HERMES_RESTART_COMMAND = "/restart";
// Synthetic provider id for Hermes tool-call cards. AgentProvider is a string;
// the value only needs to be stable and non-empty for the stream view.
const HERMES_PROVIDER = "hermes";

function toTimestamp(value: string): Date {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? new Date(0) : timestamp;
}

export function buildHermesRoomAgent(serverId: string): AgentScreenAgent {
  return {
    serverId,
    id: HERMES_ROOM_AGENT_ID,
    status: "idle",
    cwd: HERMES_ROOM_CWD,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Hermes `terminal` returns a JSON string {output, exit_code}; fall back to the
// raw string when it isn't JSON (older/plain results).
function parseTerminalResult(result?: string): { output?: string; exitCode?: number } {
  if (!result) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(result);
    const rec = asRecord(parsed);
    if (Object.keys(rec).length > 0) {
      return { output: asString(rec.output) ?? result, exitCode: asNumber(rec.exit_code) };
    }
  } catch {
    // not JSON
  }
  return { output: result };
}

function buildShellDetail(a: Record<string, unknown>, result?: string): ToolCallDetail {
  const { output, exitCode } = parseTerminalResult(result);
  return {
    type: "shell",
    command: asString(a.command) ?? "",
    ...(asString(a.cwd) !== undefined ? { cwd: asString(a.cwd) } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

// Hermes `read_file` returns a JSON envelope {content, total_lines, ...};
// surface just the file content, falling back to the raw string.
function parseFileContentResult(result?: string): string | undefined {
  if (result === undefined) {
    return undefined;
  }
  try {
    const rec = asRecord(JSON.parse(result));
    if (typeof rec.content === "string") {
      return rec.content;
    }
  } catch {
    // not JSON
  }
  return result;
}

function buildReadDetail(a: Record<string, unknown>, result?: string): ToolCallDetail {
  const content = parseFileContentResult(result);
  return {
    type: "read",
    filePath: asString(a.path) ?? "",
    ...(content !== undefined ? { content } : {}),
    ...(asNumber(a.offset) !== undefined ? { offset: asNumber(a.offset) } : {}),
    ...(asNumber(a.limit) !== undefined ? { limit: asNumber(a.limit) } : {}),
  };
}

function buildPatchDetail(a: Record<string, unknown>): ToolCallDetail {
  if (asString(a.patch) !== undefined) {
    return { type: "edit", filePath: asString(a.path) ?? "", unifiedDiff: asString(a.patch) };
  }
  return {
    type: "edit",
    filePath: asString(a.path) ?? "",
    ...(asString(a.old_string) !== undefined ? { oldString: asString(a.old_string) } : {}),
    ...(asString(a.new_string) !== undefined ? { newString: asString(a.new_string) } : {}),
  };
}

// Map a Hermes tool call onto Paseo's typed ToolCallDetail so it renders as a
// native card (command / file / diff) instead of a generic JSON blob. Unknown
// tools fall back to the generic input/output card.
function buildHermesToolDetail(name: string, args: unknown, result?: string): ToolCallDetail {
  const a = asRecord(args);
  switch (name) {
    case "terminal":
      return buildShellDetail(a, result);
    case "read_file":
      return buildReadDetail(a, result);
    case "write_file":
      return {
        type: "write",
        filePath: asString(a.path) ?? "",
        ...(asString(a.content) !== undefined ? { content: asString(a.content) } : {}),
      };
    case "patch":
      return buildPatchDetail(a);
    default:
      return { type: "unknown", input: args ?? null, output: result ?? null };
  }
}

function mapEnvelopeToStreamItem(
  envelope: HermesEventEnvelope,
  message: HermesRoomMessage,
  timestamp: Date,
): StreamItem | null {
  switch (envelope._type) {
    case "status":
      return null;
    case "thought":
      return {
        kind: "thought",
        id: message.id,
        text: envelope.text,
        timestamp,
        status: envelope.status ?? "ready",
      } satisfies StreamItem;
    case "tool_call": {
      const failed = envelope.status === "failed" || envelope.isError === true;
      let status: "running" | "completed" | "failed" = "running";
      if (failed) {
        status = "failed";
      } else if (envelope.status === "completed") {
        status = "completed";
      }
      return {
        kind: "tool_call",
        id: message.id,
        timestamp,
        payload: {
          source: "agent",
          data: {
            provider: HERMES_PROVIDER,
            callId: envelope.callId,
            name: envelope.name,
            status,
            error: failed ? (envelope.result ?? { message: "Tool call failed" }) : null,
            detail: buildHermesToolDetail(envelope.name, envelope.args, envelope.result),
            ...(envelope.durationMs !== undefined
              ? { metadata: { durationMs: envelope.durationMs } }
              : {}),
          },
        },
      } satisfies StreamItem;
    }
    case "activity_log":
      return {
        kind: "notification",
        sourceType: "notification",
        id: message.id,
        timestamp,
        level: envelope.activityType === "error" ? "error" : "info",
        message: envelope.message,
      } satisfies StreamItem;
  }
  return null;
}

export function buildHermesRoomStreamItems(messages: HermesRoomMessage[]): StreamItem[] {
  return messages.flatMap((message) => {
    const timestamp = toTimestamp(message.createdAt);
    if (message.authorAgentId === HERMES_AUTHOR_ID) {
      if (parseHermesGatewayStatus(message.body)) {
        return [];
      }
      const envelope = parseHermesEventEnvelope(message.body);
      if (envelope) {
        const item = mapEnvelopeToStreamItem(envelope, message, timestamp);
        return item ? [item] : [];
      }
      return [
        {
          kind: "assistant_message",
          id: message.id,
          messageId: message.id,
          text: message.body,
          timestamp,
        } satisfies StreamItem,
      ];
    }
    if (message.body.trim() === HERMES_RESTART_COMMAND) {
      return [];
    }
    return [
      {
        kind: "user_message",
        id: message.id,
        text: message.body,
        timestamp,
      } satisfies StreamItem,
    ];
  });
}

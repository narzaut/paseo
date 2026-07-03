/**
 * Hermes → Paseo structured-event envelope.
 *
 * The Hermes gateway has no rich agent-event stream over the Paseo chat API —
 * it can only post chat messages. To surface intermediate agent activity
 * (thoughts, tool calls, activity-log lines) in the Hermes room exactly like a
 * workspace session, the Hermes Paseo adapter encodes each event as a chat
 * message whose body is a JSON envelope authored by `hermes`:
 *
 *   {"_type":"thought","text":"...","status":"ready"}
 *   {"_type":"tool_call","callId":"abc","name":"read_file","args":{...},"status":"running"}
 *   {"_type":"tool_call","callId":"abc","name":"read_file","args":{...},"status":"completed","result":"...","isError":false,"durationMs":1234}
 *   {"_type":"activity_log","activityType":"error","message":"..."}
 *
 * A tool-call message is EDITED in place (same chat message id) as it
 * transitions running → completed, so it renders as a single card. Plain
 * assistant text is posted as a normal (non-JSON) body and falls back to an
 * assistant message.
 *
 * This file is the canonical TS half of that contract. The Python half lives in
 * the `hermes-paseo-adapter` repo (`adapter.py`). Keep the two in sync; the
 * spec of record is `PLAN.md` §1.1.
 */

/** A body is only a candidate envelope if it begins with this exact prefix. */
export const HERMES_EVENT_ENVELOPE_PREFIX = '{"_type":';

export type HermesToolCallStatus = "running" | "completed" | "failed";
export type HermesActivityType = "system" | "info" | "success" | "error";
export type HermesThoughtStatus = "loading" | "ready";
export type HermesGatewayStatus = "connected" | "disconnected";

export interface HermesThoughtEnvelope {
  _type: "thought";
  text: string;
  status?: HermesThoughtStatus;
}

export interface HermesStatusEnvelope {
  _type: "status";
  state: HermesGatewayStatus;
}

export interface HermesToolCallEnvelope {
  _type: "tool_call";
  callId: string;
  name: string;
  args?: unknown;
  status: HermesToolCallStatus;
  result?: string;
  isError?: boolean;
  durationMs?: number;
}

export interface HermesActivityLogEnvelope {
  _type: "activity_log";
  activityType: HermesActivityType;
  message: string;
}

export type HermesEventEnvelope =
  | HermesThoughtEnvelope
  | HermesStatusEnvelope
  | HermesToolCallEnvelope
  | HermesActivityLogEnvelope;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_CALL_STATUSES = new Set<HermesToolCallStatus>(["running", "completed", "failed"]);
const ACTIVITY_TYPES = new Set<HermesActivityType>(["system", "info", "success", "error"]);
const THOUGHT_STATUSES = new Set<HermesThoughtStatus>(["loading", "ready"]);
const GATEWAY_STATUSES = new Set<HermesGatewayStatus>(["connected", "disconnected"]);
const LEGACY_CONNECTED_STATUS = "🟢 **Hermes Gateway** — Connected";
const LEGACY_DISCONNECTED_STATUS = "🔴 **Hermes Gateway** — Disconnected";

function parseThought(parsed: Record<string, unknown>): HermesThoughtEnvelope | null {
  if (typeof parsed.text !== "string") {
    return null;
  }
  const status =
    typeof parsed.status === "string" && THOUGHT_STATUSES.has(parsed.status as HermesThoughtStatus)
      ? (parsed.status as HermesThoughtStatus)
      : undefined;
  return { _type: "thought", text: parsed.text, ...(status ? { status } : {}) };
}

function parseStatus(parsed: Record<string, unknown>): HermesStatusEnvelope | null {
  if (
    typeof parsed.state !== "string" ||
    !GATEWAY_STATUSES.has(parsed.state as HermesGatewayStatus)
  ) {
    return null;
  }
  return { _type: "status", state: parsed.state as HermesGatewayStatus };
}

function parseToolCall(parsed: Record<string, unknown>): HermesToolCallEnvelope | null {
  if (
    typeof parsed.callId !== "string" ||
    typeof parsed.name !== "string" ||
    typeof parsed.status !== "string" ||
    !TOOL_CALL_STATUSES.has(parsed.status as HermesToolCallStatus)
  ) {
    return null;
  }
  return {
    _type: "tool_call",
    callId: parsed.callId,
    name: parsed.name,
    status: parsed.status as HermesToolCallStatus,
    ...("args" in parsed ? { args: parsed.args } : {}),
    ...(typeof parsed.result === "string" ? { result: parsed.result } : {}),
    ...(typeof parsed.isError === "boolean" ? { isError: parsed.isError } : {}),
    ...(typeof parsed.durationMs === "number" ? { durationMs: parsed.durationMs } : {}),
  };
}

function parseActivityLog(parsed: Record<string, unknown>): HermesActivityLogEnvelope | null {
  if (
    typeof parsed.message !== "string" ||
    typeof parsed.activityType !== "string" ||
    !ACTIVITY_TYPES.has(parsed.activityType as HermesActivityType)
  ) {
    return null;
  }
  return {
    _type: "activity_log",
    activityType: parsed.activityType as HermesActivityType,
    message: parsed.message,
  };
}

/**
 * Parse a chat message body into a Hermes event envelope, or null when the body
 * is not a well-formed envelope (plain assistant text, malformed JSON, unknown
 * `_type`, or missing required fields). Returning null is the safe fallback:
 * the caller renders the body as ordinary assistant text.
 */
export function parseHermesEventEnvelope(body: string): HermesEventEnvelope | null {
  if (!body.startsWith(HERMES_EVENT_ENVELOPE_PREFIX)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  switch (parsed._type) {
    case "thought":
      return parseThought(parsed);
    case "status":
      return parseStatus(parsed);
    case "tool_call":
      return parseToolCall(parsed);
    case "activity_log":
      return parseActivityLog(parsed);
    default:
      return null;
  }
}

export function parseHermesGatewayStatus(body: string): HermesGatewayStatus | null {
  const envelope = parseHermesEventEnvelope(body);
  if (envelope?._type === "status") {
    return envelope.state;
  }
  if (body === LEGACY_CONNECTED_STATUS) {
    return "connected";
  }
  if (body === LEGACY_DISCONNECTED_STATUS) {
    return "disconnected";
  }
  return null;
}

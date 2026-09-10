import { describe, expect, it } from "vitest";
import {
  buildHermesRoomAgent,
  buildHermesRoomStreamItems,
  HERMES_ROOM_AGENT_ID,
} from "./hermes-room-screen-model";
import type { HermesRoomMessage } from "@/hooks/use-hermes-room";

describe("hermes-room-screen-model", () => {
  it("builds a synthetic Hermes agent for the shared stream view", () => {
    expect(buildHermesRoomAgent("srv-1")).toEqual({
      serverId: "srv-1",
      id: HERMES_ROOM_AGENT_ID,
      status: "idle",
      cwd: ".",
    });
  });

  it("maps manual messages to user stream items and Hermes messages to assistant items", () => {
    const messages: HermesRoomMessage[] = [
      {
        id: "m1",
        roomId: "room-hermes",
        authorAgentId: "manual",
        body: "hey",
        replyToMessageId: null,
        mentionAgentIds: [],
        createdAt: "2026-06-30T05:17:06.540Z",
      },
      {
        id: "m2",
        roomId: "room-hermes",
        authorAgentId: "hermes",
        body: "whatsup",
        replyToMessageId: "m1",
        mentionAgentIds: [],
        createdAt: "2026-06-30T05:17:09.540Z",
      },
    ];

    expect(buildHermesRoomStreamItems(messages)).toEqual([
      {
        kind: "user_message",
        id: "m1",
        text: "hey",
        timestamp: new Date("2026-06-30T05:17:06.540Z"),
      },
      {
        kind: "assistant_message",
        id: "m2",
        messageId: "m2",
        text: "whatsup",
        timestamp: new Date("2026-06-30T05:17:09.540Z"),
      },
    ]);
  });

  function hermesMessage(id: string, body: string): HermesRoomMessage {
    return {
      id,
      roomId: "room-hermes",
      authorAgentId: "hermes",
      body,
      replyToMessageId: null,
      mentionAgentIds: [],
      createdAt: "2026-06-30T05:17:09.540Z",
    };
  }

  const timestamp = new Date("2026-06-30T05:17:09.540Z");

  it("maps a thought envelope to a thought stream item", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage("t1", JSON.stringify({ _type: "thought", text: "analyzing", status: "ready" })),
    ]);
    expect(item).toEqual({
      kind: "thought",
      id: "t1",
      text: "analyzing",
      timestamp,
      status: "ready",
    });
  });

  it("defaults thought status to ready when omitted", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage("t2", JSON.stringify({ _type: "thought", text: "hmm" })),
    ]);
    expect(item).toMatchObject({ kind: "thought", status: "ready" });
  });

  it("maps a running read_file tool_call to a native read detail", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc1",
        JSON.stringify({
          _type: "tool_call",
          callId: "abc",
          name: "read_file",
          args: { path: "a.ts", offset: 1, limit: 50 },
          status: "running",
        }),
      ),
    ]);
    expect(item).toEqual({
      kind: "tool_call",
      id: "tc1",
      timestamp,
      payload: {
        source: "agent",
        data: {
          provider: "hermes",
          callId: "abc",
          name: "read_file",
          status: "running",
          error: null,
          detail: { type: "read", filePath: "a.ts", offset: 1, limit: 50 },
        },
      },
    });
  });

  it("maps a completed read_file tool_call with content + duration metadata", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc2",
        JSON.stringify({
          _type: "tool_call",
          callId: "abc",
          name: "read_file",
          args: { path: "a.ts" },
          status: "completed",
          result: "1|line one",
          isError: false,
          durationMs: 1234,
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: {
          status: "completed",
          detail: { type: "read", filePath: "a.ts", content: "1|line one" },
          metadata: { durationMs: 1234 },
        },
      },
    });
  });

  it("extracts file content from read_file's JSON result envelope", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc-rj",
        JSON.stringify({
          _type: "tool_call",
          callId: "r1",
          name: "read_file",
          args: { path: "/tmp/x.txt" },
          status: "completed",
          result: JSON.stringify({ content: "1|hello world", total_lines: 0, file_size: 11 }),
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: { detail: { type: "read", filePath: "/tmp/x.txt", content: "1|hello world" } },
      },
    });
  });

  it("maps a terminal tool_call to a shell detail, parsing output + exit code", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc-sh",
        JSON.stringify({
          _type: "tool_call",
          callId: "s1",
          name: "terminal",
          args: { command: "ls /etc" },
          status: "completed",
          result: JSON.stringify({ output: "a\nb", exit_code: 0 }),
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: { detail: { type: "shell", command: "ls /etc", output: "a\nb", exitCode: 0 } },
      },
    });
  });

  it("maps a write_file tool_call to a write detail", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc-w",
        JSON.stringify({
          _type: "tool_call",
          callId: "w1",
          name: "write_file",
          args: { path: "out.txt", content: "hello" },
          status: "completed",
          result: "wrote 5 bytes",
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: { detail: { type: "write", filePath: "out.txt", content: "hello" } },
      },
    });
  });

  it("maps a patch (replace) tool_call to an edit detail", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc-p",
        JSON.stringify({
          _type: "tool_call",
          callId: "p1",
          name: "patch",
          args: { mode: "replace", path: "a.ts", old_string: "foo", new_string: "bar" },
          status: "completed",
          result: "ok",
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: { detail: { type: "edit", filePath: "a.ts", oldString: "foo", newString: "bar" } },
      },
    });
  });

  it("falls back to a generic unknown detail for unmapped tools", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc-u",
        JSON.stringify({
          _type: "tool_call",
          callId: "u1",
          name: "vision_analyze",
          args: { image: "x.png" },
          status: "completed",
          result: "a cat",
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: {
        source: "agent",
        data: { detail: { type: "unknown", input: { image: "x.png" }, output: "a cat" } },
      },
    });
  });

  it("marks a tool_call failed when isError is set, carrying the result as error", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "tc3",
        JSON.stringify({
          _type: "tool_call",
          callId: "abc",
          name: "read_file",
          status: "completed",
          result: "boom",
          isError: true,
        }),
      ),
    ]);
    expect(item).toMatchObject({
      kind: "tool_call",
      payload: { source: "agent", data: { status: "failed", error: "boom" } },
    });
  });

  it("maps an activity_log error envelope to an error notification item", () => {
    const [item] = buildHermesRoomStreamItems([
      hermesMessage(
        "a1",
        JSON.stringify({ _type: "activity_log", activityType: "error", message: "nope" }),
      ),
    ]);
    expect(item).toEqual({
      kind: "notification",
      sourceType: "notification",
      id: "a1",
      timestamp,
      level: "error",
      message: "nope",
    });
  });

  it("falls back to assistant_message for malformed or non-envelope hermes bodies", () => {
    const items = buildHermesRoomStreamItems([
      hermesMessage("p1", "just text"),
      hermesMessage("p2", '{"_type":"thought"}'), // missing text → not an envelope
      hermesMessage("p3", '{"_type":"bogus","x":1}'),
      hermesMessage("p4", '{"_type": malformed'),
    ]);
    expect(items.every((item) => item.kind === "assistant_message")).toBe(true);
    expect(items.map((item) => (item.kind === "assistant_message" ? item.text : null))).toEqual([
      "just text",
      '{"_type":"thought"}',
      '{"_type":"bogus","x":1}',
      '{"_type": malformed',
    ]);
  });
});

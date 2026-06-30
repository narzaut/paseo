# Paseo Hermes Gateway MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a text-only Hermes-in-Paseo flow where Hermes listens in one Paseo chat room and the Paseo web client can open that room and talk to Hermes end to end.

**Architecture:** Reuse Paseo’s existing chat RPCs exactly as they exist today. Hermes gets a bundled gateway platform plugin that speaks Paseo’s real WebSocket contract (`hello` + wrapped `session` RPC messages), finds or creates one fixed `Hermes` room, seeds its cursor from the latest room message, then only processes new arrivals. Paseo gets a host-level `Hermes` screen in `packages/app`, not a fake workspace and not an Electron-only feature.

**Tech Stack:** Hermes gateway plugin system, Python asyncio + `websockets`, Paseo daemon WebSocket protocol, React Native / Expo web in `packages/app`, Vitest, Playwright.

## Global Constraints

- Text-only MVP. Do not add attachments, images, audio, markdown-rich blocks, or daemon schema changes in this plan.
- Paseo daemon changes are out of scope unless a missing transport contract is proven during implementation.
- Paseo client work must land in `packages/app`, not `packages/desktop`.
- The Hermes surface is host-level, not workspace-level.
- Reuse existing Paseo chat RPCs; do not add new WebSocket message types for MVP.
- Hermes must speak the real Paseo WebSocket envelope: send `hello`, then wrap chat RPCs in `{ "type": "session", "message": ... }`.
- Hermes adapter inbound dispatch must flow through `BasePlatformAdapter.handle_message(...)`, not `_message_handler(...)` directly.
- Use one fixed room named `Hermes` for MVP.
- Use one room = one Hermes session for MVP. Do not add per-user session fan-out in the first cut.
- Do not replay old room history into Hermes on connect or reconnect. Seed the cursor from the latest existing room message, then only process new arrivals.
- Browser e2e is the required client acceptance path for MVP, but the automated Paseo app e2e only needs to prove the client/daemon room flow. The full real Hermes round-trip is covered by Hermes repo integration tests plus manual Windows browser acceptance.
- Follow vertical TDD: one failing test, one implementation, verify green, commit.

---

## Repo roots

- **Hermes repo root:** `/home/ubuntu/.hermes/hermes-agent`
- **Paseo repo root:** `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main`

---

### Task 1: Create the Hermes Paseo platform plugin scaffold with real config gates

**Files:**
- Create: `/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/plugin.yaml`
- Create: `/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/__init__.py`
- Create: `/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/adapter.py`
- Test: `/home/ubuntu/.hermes/hermes-agent/tests/gateway/test_paseo_plugin_registration.py`

**Interfaces:**
- Consumes: `BasePlatformAdapter` from `gateway.platforms.base`, `PlatformConfig` and dynamic `Platform("paseo")` from `gateway.config`, plugin `register(ctx)` convention.
- Produces:
  - `class PaseoAdapter(BasePlatformAdapter)`
  - `def check_paseo_requirements() -> bool`
  - `def validate_paseo_config(config: PlatformConfig) -> bool`
  - `def is_paseo_connected(config: PlatformConfig) -> bool`
  - `def register(ctx) -> None`

- [ ] **Step 1: Write the failing registration test**

```python
from plugins.platforms.paseo import register


class DummyCtx:
    def __init__(self):
        self.calls = []

    def register_platform(self, **kwargs):
        self.calls.append(kwargs)



def test_paseo_plugin_registers_platform_entry():
    ctx = DummyCtx()

    register(ctx)

    assert len(ctx.calls) == 1
    entry = ctx.calls[0]
    assert entry["name"] == "paseo"
    assert entry["label"] == "Paseo"
    assert callable(entry["adapter_factory"])
    assert callable(entry["check_fn"])
    assert callable(entry["validate_config"])
    assert callable(entry["is_connected"])
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_plugin_registration.py -q
```

Expected: FAIL with import/file-not-found errors for `plugins.platforms.paseo`.

- [ ] **Step 3: Write the minimal plugin scaffold**

`/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/plugin.yaml`
```yaml
name: paseo-platform
label: Paseo
kind: platform
version: 1.0.0
description: >
  Hermes gateway adapter that connects to a Paseo daemon and relays one
  named chat room into the Hermes message pipeline.
author: NousResearch
optional_env:
  - name: PASEO_WS_URL
    description: "Paseo daemon WebSocket URL (for example ws://127.0.0.1:6767/ws)"
    prompt: "Paseo daemon WebSocket URL"
    password: false
  - name: PASEO_PASSWORD
    description: "Optional Paseo daemon password"
    prompt: "Paseo daemon password"
    password: true
```

`/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/__init__.py`
```python
from .adapter import register

__all__ = ["register"]
```

`/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/adapter.py`
```python
import logging

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult

logger = logging.getLogger(__name__)



def check_paseo_requirements() -> bool:
    try:
        import websockets  # noqa: F401
    except ImportError:
        return False
    return True



def validate_paseo_config(config: PlatformConfig) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool((extra.get("ws_url") or "").strip())



def is_paseo_connected(config: PlatformConfig) -> bool:
    return validate_paseo_config(config)


class PaseoAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("paseo"))
        extra = getattr(config, "extra", {}) or {}
        self._ws_url = str(extra.get("ws_url") or "")
        self._password = str(extra.get("password") or "") or None
        self._room_name = str(extra.get("room_name") or "Hermes")
        self._self_author_id = str(extra.get("author_id") or "hermes")

    async def connect(self) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, chat_id: str, content: str, reply_to=None, metadata=None) -> SendResult:
        raise NotImplementedError



def register(ctx) -> None:
    ctx.register_platform(
        name="paseo",
        label="Paseo",
        adapter_factory=lambda cfg: PaseoAdapter(cfg),
        check_fn=check_paseo_requirements,
        validate_config=validate_paseo_config,
        is_connected=is_paseo_connected,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_plugin_registration.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/.hermes/hermes-agent && git add plugins/platforms/paseo tests/gateway/test_paseo_plugin_registration.py && git commit -m "feat: scaffold paseo gateway plugin"
```

---

### Task 2: Implement the real Paseo WebSocket client contract inside the Hermes adapter

**Files:**
- Modify: `/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/adapter.py`
- Test: `/home/ubuntu/.hermes/hermes-agent/tests/gateway/test_paseo_transport.py`

**Interfaces:**
- Consumes:
  - Paseo WebSocket contract from `packages/protocol/src/messages.ts`
  - Chat RPC names from `packages/protocol/src/chat/rpc-schemas.ts`
  - Daemon password rules from `packages/server/src/server/auth.ts`
- Produces:
  - `class PaseoWsClient`
  - `async def PaseoWsClient.connect() -> None`
  - `async def PaseoWsClient.close() -> None`
  - `async def PaseoWsClient.request(message_type: str, payload: dict[str, Any], response_type: str) -> dict[str, Any]`

- [ ] **Step 1: Write the failing transport test**

```python
import asyncio
import json

import pytest
import websockets

from plugins.platforms.paseo.adapter import PaseoWsClient


@pytest.mark.asyncio
async def test_paseo_ws_client_sends_hello_and_wrapped_session_rpc():
    seen = {"hello": None, "request": None}
    ready = asyncio.Event()

    async def handler(ws):
        seen["hello"] = json.loads(await ws.recv())
        seen["request"] = json.loads(await ws.recv())
        await ws.send(
            json.dumps(
                {
                    "type": "session",
                    "message": {
                        "type": "chat/list/response",
                        "payload": {
                            "requestId": seen["request"]["message"]["requestId"],
                            "rooms": [],
                            "error": None,
                        },
                    },
                }
            )
        )
        ready.set()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        client = PaseoWsClient(f"ws://127.0.0.1:{port}/ws")
        await client.connect()
        payload = await client.request("chat/list", {}, "chat/list/response")
        await ready.wait()
        await client.close()

    assert seen["hello"]["type"] == "hello"
    assert seen["hello"]["clientType"] == "cli"
    assert seen["request"]["type"] == "session"
    assert seen["request"]["message"]["type"] == "chat/list"
    assert payload["rooms"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_transport.py -q
```

Expected: FAIL because `PaseoWsClient` does not exist.

- [ ] **Step 3: Implement the minimal transport client**

Add this shape to `adapter.py`:

```python
import asyncio
import json
import uuid
from typing import Any

try:
    import websockets
except ImportError:  # pragma: no cover - guarded by check_paseo_requirements()
    websockets = None


class PaseoWsClient:
    def __init__(self, ws_url: str, password: str | None = None):
        self._ws_url = ws_url.rstrip("/")
        self._password = password.strip() if password else None
        self._ws = None
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}

    async def connect(self) -> None:
        if websockets is None:
            raise RuntimeError("websockets is not installed")

        headers = {}
        subprotocols = None
        if self._password:
            headers["Authorization"] = f"Bearer {self._password}"
            subprotocols = [f"paseo.bearer.{self._password}"]

        self._ws = await websockets.connect(
            self._ws_url,
            additional_headers=headers or None,
            subprotocols=subprotocols,
            max_size=None,
        )
        await self._ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "clientId": f"hermes-paseo-{uuid.uuid4()}",
                    "clientType": "cli",
                    "protocolVersion": 1,
                    "appVersion": "hermes-paseo-mvp",
                }
            )
        )
        self._reader_task = asyncio.create_task(self._reader())

    async def close(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
            self._reader_task = None
        if self._ws is not None:
            await self._ws.close()
            self._ws = None
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

    async def request(self, message_type: str, payload: dict[str, Any], response_type: str) -> dict[str, Any]:
        if self._ws is None:
            raise RuntimeError("Paseo websocket is not connected")

        request_id = str(payload.get("requestId") or uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self._ws.send(
            json.dumps(
                {
                    "type": "session",
                    "message": {
                        "type": message_type,
                        **payload,
                        "requestId": request_id,
                    },
                }
            )
        )
        result = await future
        if result["type"] != response_type:
            raise RuntimeError(f"Expected {response_type}, got {result['type']}")
        return result["payload"]

    async def _reader(self) -> None:
        assert self._ws is not None
        async for raw in self._ws:
            frame = json.loads(raw)
            if frame.get("type") != "session":
                continue
            message = frame.get("message") or {}
            payload = message.get("payload") or {}
            request_id = payload.get("requestId")
            if not request_id:
                continue
            future = self._pending.pop(request_id, None)
            if future is None or future.done():
                continue
            if message.get("type") == "rpc_error":
                future.set_exception(RuntimeError(payload.get("error") or payload.get("code") or "rpc_error"))
                continue
            future.set_result(message)
```

Also update the imports at the top of `adapter.py`:

```python
import contextlib
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_transport.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/.hermes/hermes-agent && git add plugins/platforms/paseo/adapter.py tests/gateway/test_paseo_transport.py && git commit -m "feat: add paseo websocket transport client"
```

---

### Task 3: Implement room bootstrap, cursor seeding, and inbound dispatch through `handle_message`

**Files:**
- Modify: `/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/adapter.py`
- Test: `/home/ubuntu/.hermes/hermes-agent/tests/gateway/test_paseo_adapter.py`

**Interfaces:**
- Consumes:
  - `MessageEvent`, `MessageType`, and `SessionSource`
  - `BasePlatformAdapter.handle_message(...)`
  - Paseo RPCs `chat/list`, `chat/create`, `chat/read`
- Produces:
  - `async def _ensure_room(self) -> dict[str, Any]`
  - `async def _seed_cursor_from_latest(self) -> None`
  - `def _normalize_inbound(self, room: dict[str, Any], message: dict[str, Any]) -> MessageEvent | None`
  - `async def _handle_inbound_messages(self, room: dict[str, Any], messages: list[dict[str, Any]]) -> None`

- [ ] **Step 1: Write the failing adapter bootstrap tests**

```python
import asyncio
from unittest.mock import AsyncMock

from gateway.config import PlatformConfig
from plugins.platforms.paseo.adapter import PaseoAdapter


class FakePaseoClient:
    def __init__(self):
        self.calls = []
        self.room = {"id": "room-hermes", "name": "Hermes"}

    async def request(self, message_type, payload, response_type):
        self.calls.append((message_type, payload, response_type))
        if message_type == "chat/list":
            return {"rooms": [self.room], "error": None}
        if message_type == "chat/read":
            return {
                "messages": [
                    {
                        "id": "m2",
                        "roomId": "room-hermes",
                        "authorAgentId": "manual",
                        "body": "existing history",
                        "replyToMessageId": None,
                        "mentionAgentIds": [],
                        "createdAt": "2026-06-30T00:00:02.000Z",
                    }
                ],
                "error": None,
            }
        raise AssertionError(message_type)



def test_bootstrap_seeds_cursor_without_replaying_history():
    adapter = PaseoAdapter(
        PlatformConfig(enabled=True, extra={"ws_url": "ws://127.0.0.1:6767/ws", "room_name": "Hermes"})
    )
    adapter._client = FakePaseoClient()
    adapter.handle_message = AsyncMock()

    asyncio.run(adapter._connect_room_once_for_test())

    assert adapter._room_id == "room-hermes"
    assert adapter._last_seen_message_id == "m2"
    adapter.handle_message.assert_not_awaited()



def test_inbound_messages_flow_through_base_handle_message():
    adapter = PaseoAdapter(
        PlatformConfig(enabled=True, extra={"ws_url": "ws://127.0.0.1:6767/ws", "author_id": "hermes"})
    )
    adapter.handle_message = AsyncMock()
    room = {"id": "room-hermes", "name": "Hermes"}
    inbound = {
        "id": "m3",
        "roomId": "room-hermes",
        "authorAgentId": "manual",
        "body": "hello",
        "replyToMessageId": None,
        "mentionAgentIds": [],
        "createdAt": "2026-06-30T00:00:03.000Z",
    }

    asyncio.run(adapter._handle_inbound_messages(room, [inbound]))

    adapter.handle_message.assert_awaited_once()
    event = adapter.handle_message.await_args.args[0]
    assert event.text == "hello"
    assert event.source.chat_id == "room-hermes"
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_adapter.py -q
```

Expected: FAIL because `_connect_room_once_for_test`, `_seed_cursor_from_latest`, and `_handle_inbound_messages` do not exist.

- [ ] **Step 3: Implement the minimal bootstrap path**

Add this shape to `adapter.py`:

```python
from datetime import datetime

from gateway.platforms.base import MessageEvent, MessageType
from gateway.session import SessionSource


class PaseoAdapter(BasePlatformAdapter):
    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("paseo"))
        extra = getattr(config, "extra", {}) or {}
        self._ws_url = str(extra.get("ws_url") or "")
        self._password = str(extra.get("password") or "") or None
        self._room_name = str(extra.get("room_name") or "Hermes")
        self._self_author_id = str(extra.get("author_id") or "hermes")
        self._client: PaseoWsClient | None = None
        self._room_id = ""
        self._room_name_current = self._room_name
        self._last_seen_message_id: str | None = None
        self._pump_task: asyncio.Task | None = None

    async def _connect_room_once_for_test(self) -> None:
        room = await self._ensure_room()
        await self._seed_cursor_from_latest()
        self._room_name_current = str(room.get("name") or self._room_name)

    async def _ensure_room(self) -> dict[str, Any]:
        assert self._client is not None
        listed = await self._client.request("chat/list", {}, "chat/list/response")
        for room in listed.get("rooms", []):
            if room.get("name") == self._room_name:
                self._room_id = room["id"]
                return room
        created = await self._client.request(
            "chat/create",
            {"name": self._room_name},
            "chat/create/response",
        )
        room = created["room"]
        self._room_id = room["id"]
        return room

    async def _seed_cursor_from_latest(self) -> None:
        assert self._client is not None
        history = await self._client.request(
            "chat/read",
            {"room": self._room_id, "limit": 1},
            "chat/read/response",
        )
        latest = history.get("messages", [])
        self._last_seen_message_id = latest[-1]["id"] if latest else None

    def _normalize_inbound(self, room: dict[str, Any], message: dict[str, Any]) -> MessageEvent | None:
        if message.get("authorAgentId") == self._self_author_id:
            return None
        return MessageEvent(
            text=message.get("body", ""),
            message_type=MessageType.TEXT,
            message_id=message.get("id"),
            raw_message=message,
            source=SessionSource(
                platform=Platform("paseo"),
                chat_id=room["id"],
                chat_name=room.get("name"),
                chat_type="group",
                user_id=message.get("authorAgentId"),
                user_name=message.get("authorAgentId"),
            ),
            timestamp=datetime.now(),
        )

    async def _handle_inbound_messages(self, room: dict[str, Any], messages: list[dict[str, Any]]) -> None:
        for message in messages:
            self._last_seen_message_id = message.get("id") or self._last_seen_message_id
            event = self._normalize_inbound(room, message)
            if event is None:
                continue
            await self.handle_message(event)
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_adapter.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/.hermes/hermes-agent && git add plugins/platforms/paseo/adapter.py tests/gateway/test_paseo_adapter.py && git commit -m "feat: bootstrap paseo room and dispatch inbound messages"
```

---

### Task 4: Implement outbound posting and reconnect-on-daemon-restart loop

**Files:**
- Modify: `/home/ubuntu/.hermes/hermes-agent/plugins/platforms/paseo/adapter.py`
- Test: `/home/ubuntu/.hermes/hermes-agent/tests/gateway/test_paseo_adapter.py`
- Test: `/home/ubuntu/.hermes/hermes-agent/tests/gateway/test_paseo_adapter_integration.py`

**Interfaces:**
- Consumes:
  - `BasePlatformAdapter.send(...)`
  - Paseo `chat/post` and `chat/wait`
  - `PaseoWsClient`
- Produces:
  - `async def connect(self) -> bool`
  - `async def disconnect(self) -> None`
  - `async def send(self, chat_id: str, content: str, reply_to=None, metadata=None) -> SendResult`
  - `async def _run_forever(self) -> None`

- [ ] **Step 1: Write the failing send/reconnect tests**

```python
import asyncio
from unittest.mock import AsyncMock

from gateway.config import PlatformConfig
from plugins.platforms.paseo.adapter import PaseoAdapter


class FakePaseoClient:
    def __init__(self):
        self.posted = []
        self.wait_calls = 0

    async def request(self, message_type, payload, response_type):
        if message_type == "chat/post":
            self.posted.append(payload)
            return {
                "message": {
                    "id": "reply-1",
                    "roomId": payload["room"],
                    "authorAgentId": payload["authorAgentId"],
                    "body": payload["body"],
                    "replyToMessageId": payload.get("replyToMessageId"),
                    "mentionAgentIds": [],
                    "createdAt": "2026-06-30T00:00:10.000Z",
                },
                "error": None,
            }
        if message_type == "chat/wait":
            self.wait_calls += 1
            if self.wait_calls == 1:
                return {
                    "messages": [
                        {
                            "id": "m4",
                            "roomId": payload["room"],
                            "authorAgentId": "manual",
                            "body": "second",
                            "replyToMessageId": None,
                            "mentionAgentIds": [],
                            "createdAt": "2026-06-30T00:00:11.000Z",
                        }
                    ],
                    "timedOut": False,
                    "error": None,
                }
            return {"messages": [], "timedOut": True, "error": None}
        raise AssertionError(message_type)



def test_send_posts_with_hermes_author_id():
    adapter = PaseoAdapter(
        PlatformConfig(enabled=True, extra={"ws_url": "ws://127.0.0.1:6767/ws", "author_id": "hermes"})
    )
    adapter._client = FakePaseoClient()

    result = asyncio.run(adapter.send("room-hermes", "hi from hermes"))

    assert result.success is True
    assert adapter._client.posted[0]["authorAgentId"] == "hermes"



def test_wait_loop_dispatches_new_messages():
    adapter = PaseoAdapter(
        PlatformConfig(enabled=True, extra={"ws_url": "ws://127.0.0.1:6767/ws", "room_name": "Hermes"})
    )
    adapter._client = FakePaseoClient()
    adapter._room_id = "room-hermes"
    adapter._room_name_current = "Hermes"
    adapter._running = True
    adapter.handle_message = AsyncMock(side_effect=lambda event: setattr(adapter, "_running", False))

    asyncio.run(adapter._run_forever_once_for_test())

    adapter.handle_message.assert_awaited_once()
    assert adapter.handle_message.await_args.args[0].text == "second"
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_adapter.py -q
```

Expected: FAIL because `send()` and the runtime loop are incomplete.

- [ ] **Step 3: Implement the minimal runtime loop**

Extend `adapter.py` with this shape:

```python
class PaseoAdapter(BasePlatformAdapter):
    async def connect(self) -> bool:
        if not self._ws_url:
            return False
        self._running = True
        self._pump_task = asyncio.create_task(self._run_forever())
        return True

    async def disconnect(self) -> None:
        self._running = False
        if self._pump_task is not None:
            self._pump_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._pump_task
            self._pump_task = None
        if self._client is not None:
            await self._client.close()
            self._client = None

    async def send(self, chat_id: str, content: str, reply_to=None, metadata=None) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="Paseo adapter is not connected", retryable=True)
        payload = await self._client.request(
            "chat/post",
            {
                "room": chat_id,
                "body": content,
                "authorAgentId": self._self_author_id,
                **({"replyToMessageId": reply_to} if reply_to else {}),
            },
            "chat/post/response",
        )
        message = payload.get("message") or {}
        return SendResult(success=True, message_id=message.get("id"))

    async def _run_forever_once_for_test(self) -> None:
        room = {"id": self._room_id, "name": self._room_name_current}
        response = await self._client.request(
            "chat/wait",
            {
                "room": self._room_id,
                **({"afterMessageId": self._last_seen_message_id} if self._last_seen_message_id else {}),
                "timeoutMs": 30000,
            },
            "chat/wait/response",
        )
        await self._handle_inbound_messages(room, response.get("messages", []))

    async def _run_forever(self) -> None:
        while self._running:
            try:
                if self._client is None:
                    self._client = PaseoWsClient(self._ws_url, self._password)
                    await self._client.connect()
                    room = await self._ensure_room()
                    self._room_name_current = str(room.get("name") or self._room_name)
                    await self._seed_cursor_from_latest()
                await self._run_forever_once_for_test()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("Paseo adapter loop failed, reconnecting: %s", exc)
                if self._client is not None:
                    await self._client.close()
                    self._client = None
                self._room_id = ""
                await asyncio.sleep(2)
```

For the integration test, use a tiny in-process fake WebSocket server that:
- accepts `hello`
- answers `chat/list`, `chat/read`, `chat/wait`, and `chat/post`
- deliberately closes the socket once, then accepts a second connection

Assert that:
- a live `PaseoAdapter.connect()` dispatches one inbound message
- a live `send()` produces a wrapped `chat/post` frame
- after the forced socket close, the adapter reconnects and keeps waiting instead of crashing

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/ubuntu/.hermes/hermes-agent && python -m pytest tests/gateway/test_paseo_adapter.py tests/gateway/test_paseo_adapter_integration.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/.hermes/hermes-agent && git add plugins/platforms/paseo/adapter.py tests/gateway/test_paseo_adapter.py tests/gateway/test_paseo_adapter_integration.py && git commit -m "feat: add paseo send loop and reconnect coverage"
```

---

### Task 5: Add the host-level Hermes screen in `packages/app`

**Files:**
- Create: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/app/h/[serverId]/hermes.tsx`
- Modify: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/app/h/[serverId]/_layout.tsx`
- Create: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/screens/hermes-room-screen.tsx`
- Create: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/hooks/use-hermes-room.ts`
- Test: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/hooks/use-hermes-room.test.tsx`

**Interfaces:**
- Consumes:
  - `useHostRouteServerId()`
  - session store client lookup pattern from `use-file-explorer-actions.ts`
  - Paseo client methods `createChatRoom`, `listChatRooms`, `postChatMessage`, `readChatMessages`, `waitForChatMessages`
- Produces:
  - `useHermesRoom(serverId: string, clientOverride?: any): { roomId: string | null; messages: ChatMessage[]; status: "loading" | "ready" | "error"; error: string | null; sendMessage(text: string): Promise<void> }`
  - `HermesRoomScreen({ serverId: string })`
  - `/h/[serverId]/hermes`

- [ ] **Step 1: Write the failing hook test**

```tsx
/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHermesRoom } from "./use-hermes-room";


describe("useHermesRoom", () => {
  it("creates or reuses the Hermes room, loads recent messages, and sends text", async () => {
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
    expect(result.current.messages.map((m) => m.body)).toEqual(["hello"]);
    expect(client.createChatRoom).toHaveBeenCalledWith({ name: "Hermes" });

    await act(async () => {
      await result.current.sendMessage("hi from browser");
    });

    expect(client.postChatMessage).toHaveBeenCalledWith({
      room: "room-hermes",
      body: "hi from browser",
      authorAgentId: "manual",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && npx vitest run packages/app/src/hooks/use-hermes-room.test.tsx --bail=1
```

Expected: FAIL because `use-hermes-room.ts` does not exist.

- [ ] **Step 3: Implement the minimal hook and screen**

`packages/app/src/hooks/use-hermes-room.ts`
```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/session-store";

const HERMES_ROOM_NAME = "Hermes";
const MANUAL_AUTHOR_ID = "manual";

function mergeMessages(current: any[], incoming: any[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function useHermesRoom(serverId: string, clientOverride?: any) {
  const sessionClient = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const client = clientOverride ?? sessionClient;
  const [roomId, setRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const lastSeenMessageIdRef = useRef<string | null>(null);

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
        const existing = listed.rooms.find((room: any) => room.name === HERMES_ROOM_NAME);
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
        lastSeenMessageIdRef.current = history.messages.at(-1)?.id ?? null;
        setStatus("ready");

        while (!cancelled) {
          const next = await client.waitForChatMessages({
            room: room.id,
            afterMessageId: lastSeenMessageIdRef.current ?? undefined,
            timeoutMs: 30000,
          });
          if (cancelled || !next.messages.length) {
            continue;
          }
          lastSeenMessageIdRef.current = next.messages.at(-1)?.id ?? lastSeenMessageIdRef.current;
          setMessages((current) => mergeMessages(current, next.messages));
        }
      } catch (caughtError) {
        if (!cancelled) {
          setError(caughtError instanceof Error ? caughtError.message : "Failed to load Hermes room");
          setStatus("error");
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [client, serverId]);

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
      if (payload.message) {
        lastSeenMessageIdRef.current = payload.message.id;
        setMessages((current) => mergeMessages(current, [payload.message]));
      }
    },
    [client, roomId],
  );

  return { roomId, messages, status, error, sendMessage };
}
```

`packages/app/src/screens/hermes-room-screen.tsx`
```tsx
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useHermesRoom } from "@/hooks/use-hermes-room";

export function HermesRoomScreen({ serverId }: { serverId: string }) {
  const { messages, status, error, sendMessage } = useHermesRoom(serverId);
  const [draft, setDraft] = useState("");

  async function handleSend() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    await sendMessage(text);
  }

  return (
    <View testID="hermes-room-screen" style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Hermes</Text>
      {status === "loading" ? <Text>Loading…</Text> : null}
      {error ? <Text>{error}</Text> : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8 }}>
        {messages.map((message) => (
          <View key={message.id}>
            <Text>{message.authorAgentId}</Text>
            <Text>{message.body}</Text>
          </View>
        ))}
      </ScrollView>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Message Hermes"
        accessibilityLabel="Message Hermes"
        style={{ borderWidth: 1, padding: 12, borderRadius: 8 }}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={handleSend}>
        <Text>Send</Text>
      </Pressable>
    </View>
  );
}
```

`packages/app/src/app/h/[serverId]/hermes.tsx`
```tsx
import { Redirect } from "expo-router";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { HermesRoomScreen } from "@/screens/hermes-room-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export default function HermesRoute() {
  const serverId = useHostRouteServerId();
  if (!serverId) {
    return <Redirect href={buildOpenProjectRoute()} />;
  }
  return <HermesRoomScreen serverId={serverId} />;
}
```

`packages/app/src/app/h/[serverId]/_layout.tsx`
```tsx
      <Stack.Screen name="hermes" />
```

Insert that new screen in the same owned-stack list as `index`, `sessions`, and `settings`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && npx vitest run packages/app/src/hooks/use-hermes-room.test.tsx --bail=1
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && git add packages/app/src/app/h/[serverId]/hermes.tsx packages/app/src/app/h/[serverId]/_layout.tsx packages/app/src/screens/hermes-room-screen.tsx packages/app/src/hooks/use-hermes-room.ts packages/app/src/hooks/use-hermes-room.test.tsx && git commit -m "feat: add host-level hermes room screen"
```

---

### Task 6: Add route helper, sidebar entry, and browser client acceptance using the existing app fixture stack

**Files:**
- Modify: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/utils/host-routes.ts`
- Modify: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/utils/host-routes.test.ts`
- Modify: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/src/components/left-sidebar.tsx`
- Modify: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/e2e/helpers/seed-client.ts`
- Create: `/home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main/packages/app/e2e/hermes-room.spec.ts`

**Interfaces:**
- Consumes:
  - route helpers in `host-routes.ts`
  - sidebar footer button pattern in `left-sidebar.tsx`
  - existing Playwright `test` fixture from `packages/app/e2e/fixtures.ts`
  - existing seed daemon client transport from `packages/app/e2e/helpers/seed-client.ts`
- Produces:
  - `buildHermesRoute(serverId?: string | null): string`
  - one sidebar button that navigates to `/h/[serverId]/hermes`
  - Playwright happy-path spec that proves the Paseo web client can load the Hermes room and post a message through the daemon chat APIs

- [ ] **Step 1: Write the failing route test and e2e spec shell**

Add to `packages/app/src/utils/host-routes.test.ts`:

```ts
it("buildHermesRoute returns the host-level Hermes route", () => {
  expect(buildHermesRoute("srv-1")).toBe("/h/srv-1/hermes");
});
```

Create `packages/app/e2e/hermes-room.spec.ts`:
```ts
import { test, expect } from "./fixtures";
import { buildHermesRoute } from "../src/utils/host-routes";
import { connectSeedClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

test("Hermes room loads history and sends a message", async ({ page }) => {
  const client = await connectSeedClient();
  try {
    const created = await client.createChatRoom({ name: "Hermes" });
    const room = created.room!;
    await client.postChatMessage({ room: room.id, body: "seeded hello", authorAgentId: "hermes" });

    await page.goto(buildHermesRoute(getServerId()));
    await expect(page.getByText("Hermes")).toBeVisible();
    await expect(page.getByText("seeded hello")).toBeVisible();

    await page.getByPlaceholder("Message Hermes").fill("hello from browser");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("hello from browser")).toBeVisible();
  } finally {
    await client.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && npx vitest run packages/app/src/utils/host-routes.test.ts --bail=1
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && npm run test:e2e --workspace=@getpaseo/app -- hermes-room.spec.ts
```

Expected:
- unit route test fails because `buildHermesRoute` does not exist
- Playwright fails because there is no Hermes route / sidebar entry / seed-client chat methods yet

- [ ] **Step 3: Implement the minimal route helper, sidebar button, and seed-client typing**

Add to `packages/app/src/utils/host-routes.ts`:
```ts
export function buildHermesRoute(serverId?: string | null): string {
  const normalized = trimNonEmpty(serverId);
  if (!normalized) {
    return "/";
  }
  return `/h/${encodeSegment(normalized)}/hermes`;
}
```

Update `packages/app/src/components/left-sidebar.tsx`:
```tsx
import { Bot } from "lucide-react-native";
import { buildHermesRoute } from "@/utils/host-routes";
```

Add the Hermes handler alongside the existing Home / Settings handlers:
```tsx
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeHermesServerId = activeWorkspaceSelection?.serverId ?? hosts[0]?.serverId ?? null;

  const handleHermesMobile = useCallback(() => {
    if (!activeHermesServerId) {
      return;
    }
    showMobileAgent();
    router.push(buildHermesRoute(activeHermesServerId));
  }, [activeHermesServerId, showMobileAgent]);

  const handleHermesDesktop = useCallback(() => {
    if (!activeHermesServerId) {
      return;
    }
    router.push(buildHermesRoute(activeHermesServerId));
  }, [activeHermesServerId]);
```

Pass that through `SidebarFooter`, then render one more footer button next to Home / Settings:
```tsx
        <FooterIconButton
          onPress={handleHermes}
          testID="sidebar-hermes"
          accessibilityLabel={labels.hermes}
          icon={Bot}
          theme={theme}
        />
```

Update the sidebar labels shape to include `hermes: t("sidebar.actions.hermes")`.

Update `packages/app/e2e/helpers/seed-client.ts` by extending the `SeedDaemonClient` interface only. Do not add new runtime wrappers; the underlying daemon client already has these methods.
```ts
  listChatRooms(): Promise<{ rooms: Array<{ id: string; name: string }>; error: string | null }>;
  createChatRoom(options: { name: string; purpose?: string }): Promise<{
    room: { id: string; name: string } | null;
    error: string | null;
  }>;
  readChatMessages(options: { room: string; limit?: number }): Promise<{
    messages: Array<{
      id: string;
      roomId: string;
      authorAgentId: string;
      body: string;
      replyToMessageId: string | null;
      mentionAgentIds: string[];
      createdAt: string;
    }>;
    error: string | null;
  }>;
  postChatMessage(options: {
    room: string;
    body: string;
    authorAgentId?: string;
  }): Promise<{
    message: {
      id: string;
      roomId: string;
      authorAgentId: string;
      body: string;
      replyToMessageId: string | null;
      mentionAgentIds: string[];
      createdAt: string;
    } | null;
    error: string | null;
  }>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && npx vitest run packages/app/src/utils/host-routes.test.ts --bail=1
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && npm run test:e2e --workspace=@getpaseo/app -- hermes-room.spec.ts
```

Expected: PASS.

Then perform the manual Windows browser acceptance run:
```text
1. Start the modified Paseo daemon with web UI enabled on the server.
2. Start Hermes gateway with the Paseo plugin enabled and pointed at that daemon.
3. Open the served Paseo web UI from the Windows PC over HTTPS.
4. Click Hermes in the left sidebar.
5. Send "hello from windows".
6. Verify the message appears immediately and a Hermes reply arrives in the same thread.
7. Reload the page and verify the thread history is still visible.
8. Restart the Hermes gateway only and verify the next message still succeeds.
9. Restart the Paseo daemon only, wait for the Hermes adapter to reconnect, and verify the next message still succeeds with no duplicate replay of older room messages.
```

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/workspace/opensrc/repos/github.com/getpaseo/paseo/main && git add packages/app/src/utils/host-routes.ts packages/app/src/utils/host-routes.test.ts packages/app/src/components/left-sidebar.tsx packages/app/e2e/helpers/seed-client.ts packages/app/e2e/hermes-room.spec.ts && git commit -m "feat: add hermes route, sidebar entry, and browser acceptance"
```

---

## Self-Review

### Spec coverage
- Hermes gateway adapter: covered by Tasks 1-4.
- Real Paseo WebSocket contract and daemon password auth: covered by Task 2.
- No backlog replay on reconnect: covered by Tasks 3-4 and manual acceptance step 9.
- Paseo app client surface in `packages/app`: covered by Tasks 5-6.
- Browser client acceptance on Windows over HTTPS: covered by Task 6 manual acceptance.
- No `packages/desktop` work: enforced in Global Constraints.
- No daemon/protocol changes: enforced in Global Constraints and task file lists.

### Placeholder scan
- No `TODO`, `TBD`, or “similar to previous task” shortcuts remain.
- Every task names exact files, commands, and expected results.
- The automated app e2e no longer assumes a separately booted Hermes process; it proves only the client/daemon room path, which the harness can actually run.

### Type consistency
- Hermes side produces `PaseoAdapter`, `PaseoWsClient`, `_ensure_room`, `_seed_cursor_from_latest`, `_run_forever`.
- Paseo side produces `useHermesRoom`, `HermesRoomScreen`, `buildHermesRoute`.
- Later tasks consume the same names.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-paseo-hermes-gateway-mvp.md`.

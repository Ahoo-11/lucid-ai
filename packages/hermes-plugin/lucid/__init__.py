"""Lucid observability for Hermes Agent.

Forwards Hermes observer hooks (telemetry schema ``hermes.observer.v1``) to a
Lucid server, which turns them into runs, model calls, tool calls, sub-agents
and approval decisions.

Hermes runs hook callbacks inline, so callbacks only copy the payload onto a
queue; a background thread batches and POSTs them. Nothing here may slow down
or break the agent: every failure is swallowed. When Lucid is unreachable,
batches wait in a bounded spool folder inside the Hermes home (which Docker
setups already persist) and are resent once it is back.

Configuration, first match wins (put them in ~/.hermes/.env on a server):
  LUCID_ENDPOINT / LUCID_API_KEY environment variables
  ~/.lucid/config.json ({"endpoint": ..., "apiKey": ...}), written by `lucid connect hermes`
  http://127.0.0.1:4318 (a local Lucid server)
Optional:
  LUCID_BACKFILL_DAYS=30   also upload past sessions from state.db, once, newest
                           first, reporting progress to Lucid as it goes

Lessons the owner approves in Lucid are added to every turn (see _Lessons).
"""

from __future__ import annotations

import atexit
import gzip
import hashlib
import json
import logging
import os
import queue
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

HOOKS = [
    "on_session_start",
    "on_session_end",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "pre_tool_call",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
    "pre_approval_request",
    "post_approval_response",
]

DEFAULT_ENDPOINT = "http://127.0.0.1:4318"
# Legacy compatibility fields: large, unsanitized duplicates of what the
# sanitized `request` / `response` payloads already carry.
DROPPED_FIELDS = {"conversation_history", "request_messages", "assistant_message"}

MAX_STRING = 20_000
MAX_ITEMS = 300
MAX_DEPTH = 8
MAX_NODES = 8_000
# Tool definitions are JSON schemas: they nest deeply and must stay intact,
# or replaying the decision sends schemas the provider rejects.
TOOLS_MAX_DEPTH = 64
TOOLS_MAX_NODES = 100_000
TRUNCATED = "…[truncated by Lucid]"

BATCH_SIZE = 100
FLUSH_SECONDS = 0.5
MAX_QUEUE = 10_000
SEND_TIMEOUT = 5.0
EXIT_FLUSH_SECONDS = 3.0
GZIP_OVER_BYTES = 8_192
SPOOL_MAX_BYTES = 50 * 1024 * 1024
SPOOL_RETRY_SECONDS = 30.0
# Malformed or oversized: these never succeed on retry. Auth errors (401) do,
# once the key is fixed, so those batches are kept.
REJECTED_FOREVER = {400, 413, 422}
BACKFILL_TIMEOUT = 60.0
BACKFILL_MARKER = "lucid-backfill.json"
LESSONS_REFRESH_SECONDS = 60.0
LESSONS_TIMEOUT = 5.0
# Lucid caps a lesson at 400 characters and sends at most 10; this is a backstop.
LESSONS_MAX_CHARS = 4_000
# Same lists as `lucid import hermes`; older Hermes versions lack some columns.
SESSION_COLUMNS = [
    "id", "source", "model", "system_prompt_hash", "parent_session_id", "started_at", "ended_at", "end_reason", "title",
    "cwd", "git_branch", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "estimated_cost_usd",
    "actual_cost_usd", "billing_provider",
]
MESSAGE_COLUMNS = [
    "id", "session_id", "role", "content", "tool_call_id", "tool_calls", "tool_name", "timestamp", "finish_reason",
    "reasoning", "reasoning_content", "display_kind",
]

log = logging.getLogger("hermes.plugins.lucid")


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore[import-not-found]

        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _spool_dir() -> Path:
    return Path(os.environ.get("LUCID_SPOOL_DIR") or _hermes_home() / "lucid-spool")


def _post_json(path: str, body: dict[str, Any], timeout: float) -> bool:
    """POST to Lucid, gzipped when large. True on a 2xx answer."""
    endpoint, key = _config()
    headers = {"Content-Type": "application/json", "User-Agent": "lucid-hermes-plugin/0.4"}
    if key:
        headers["x-api-key"] = key
    data = json.dumps(body, separators=(",", ":"), default=str).encode("utf-8")
    if len(data) > GZIP_OVER_BYTES:
        data = gzip.compress(data)
        headers["Content-Encoding"] = "gzip"
    request = urllib.request.Request(f"{endpoint}{path}", data=data, method="POST", headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return 200 <= response.status < 300


def _config() -> tuple[str, Optional[str]]:
    endpoint = os.environ.get("LUCID_ENDPOINT")
    key = os.environ.get("LUCID_API_KEY")
    if not endpoint or not key:
        home = Path(os.environ.get("LUCID_HOME") or Path.home() / ".lucid")
        try:
            saved = json.loads((home / "config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}
        endpoint = endpoint or saved.get("endpoint")
        key = key or saved.get("apiKey")
    return (endpoint or DEFAULT_ENDPOINT).rstrip("/"), key


def _jsonable(value: Any, depth: int = 0, budget: Optional[list[int]] = None, max_depth: int = MAX_DEPTH) -> Any:
    """JSON-safe copy with bounded size: hook payloads can hold whole files."""
    if budget is None:
        budget = [MAX_NODES]
    if budget[0] <= 0:
        return TRUNCATED
    budget[0] -= 1
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING else value[:MAX_STRING] + TRUNCATED
    if depth >= max_depth:
        return TRUNCATED
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_ITEMS:
                out[TRUNCATED] = True
                break
            out[str(key)] = _jsonable(item, depth + 1, budget, max_depth)
        return out
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        out_list = [_jsonable(item, depth + 1, budget, max_depth) for item in items[:MAX_ITEMS]]
        if len(items) > MAX_ITEMS:
            out_list.append(TRUNCATED)
        return out_list
    for attr in ("model_dump", "to_dict", "dict"):
        method = getattr(value, attr, None)
        if callable(method):
            try:
                return _jsonable(method(), depth + 1, budget, max_depth)
            except Exception:
                break
    if hasattr(value, "__dict__"):
        return _jsonable({k: v for k, v in vars(value).items() if not k.startswith("_")}, depth + 1, budget, max_depth)
    return _jsonable(repr(value), depth + 1, budget, max_depth)


def _sent_tools(kwargs: dict[str, Any]) -> Optional[list[Any]]:
    """The tool list Hermes is about to send.

    Hermes' sanitized `request` payload cuts JSON schemas off at 8 levels
    (`<dict depth limit>`), and no hook passes the raw tools. The request dict
    (`api_kwargs`) is a local in the agent's conversation loop; that thread
    waits while observer hooks run on a worker thread, so look across threads.
    `request_messages` is a shallow copy of the request's message list, so
    identity of its last message picks the right request even when several
    agents (sub-agents) are mid-call. Reading changes nothing.
    """
    sent = kwargs.get("request_messages")
    probe = sent[-1] if isinstance(sent, list) and sent else None
    candidates: list[list[Any]] = []
    for top in sys._current_frames().values():
        frame = top
        for _ in range(48):
            if frame is None:
                break
            api_kwargs = frame.f_locals.get("api_kwargs")
            if isinstance(api_kwargs, dict) and isinstance(api_kwargs.get("tools"), list):
                messages = api_kwargs.get("messages") or api_kwargs.get("input")
                if probe is not None and isinstance(messages, list) and any(m is probe for m in messages[-3:]):
                    return api_kwargs["tools"]
                candidates.append(api_kwargs["tools"])
                break
            frame = frame.f_back
    # Without a match, only an unambiguous single request is safe to use.
    return candidates[0] if len(candidates) == 1 and probe is None else None


def _raw_tools(kwargs: dict[str, Any]) -> Optional[list[Any]]:
    """Intact tool definitions: the ones being sent, else the (possibly cut) hook copy."""
    tools = _sent_tools(kwargs)
    if tools is None:
        request = kwargs.get("request")
        body = request.get("body") if isinstance(request, dict) else None
        tools = body.get("tools") if isinstance(body, dict) else None
    if not isinstance(tools, list):
        return None
    return _jsonable(tools, budget=[TOOLS_MAX_NODES], max_depth=TOOLS_MAX_DEPTH)


def _raw_messages(kwargs: dict[str, Any]) -> Optional[list[Any]]:
    """The unsanitized messages Hermes sends (`request_messages`), with the system
    prompt put back in front when the provider API carries it separately."""
    messages = kwargs.get("request_messages")
    if not isinstance(messages, list) or not messages:
        return None
    out = _jsonable(messages, budget=[TOOLS_MAX_NODES], max_depth=TOOLS_MAX_DEPTH)
    system = kwargs.get("system_prompt")
    has_system = any(isinstance(m, dict) and m.get("role") in ("system", "developer") for m in out)
    if isinstance(system, str) and system.strip() and not has_system:
        out.insert(0, {"role": "system", "content": _jsonable(system)})
    return out


class _Sender:
    """Background batching sender. Starts on the first event."""

    def __init__(self) -> None:
        self.queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=MAX_QUEUE)
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()
        self.spool_lock = threading.Lock()
        self.last_spool_try = 0.0
        self.warned = False
        self.spool_full_warned = False

    def put(self, event: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            return  # Lucid is falling behind; never block the agent
        if self.thread is None:
            with self.lock:
                if self.thread is None:
                    self.thread = threading.Thread(target=self._run, name="lucid-sender", daemon=True)
                    self.thread.start()

    def _drain(self, limit: int) -> list[dict[str, Any]]:
        batch: list[dict[str, Any]] = []
        while len(batch) < limit:
            try:
                batch.append(self.queue.get_nowait())
            except queue.Empty:
                break
        return batch

    def _post(self, batch: list[dict[str, Any]], timeout: float = SEND_TIMEOUT) -> bool:
        """True once the batch is dealt with; False means keep it and retry."""
        try:
            ok = _post_json("/v1/hooks/hermes", {"events": batch}, timeout)
        except urllib.error.HTTPError as error:
            if error.code in REJECTED_FOREVER:
                log.warning("Lucid rejected %d events (HTTP %d); dropping them", len(batch), error.code)
                return True  # resending the same bytes would fail the same way
            ok = False
            if not self.warned:
                self.warned = True
                log.warning("Lucid answered HTTP %d; keeping events until it accepts them", error.code)
        except (OSError, urllib.error.URLError, ValueError) as error:
            ok = False
            if not self.warned:
                self.warned = True
                log.warning("Lucid: could not reach %s (%s); keeping events until it is back", _config()[0], error)
        if ok:
            self.warned = False
        return ok

    def _spool(self, batch: list[dict[str, Any]]) -> None:
        """Keep a batch on disk for later. Bounded: past the cap, new batches are dropped."""
        try:
            folder = _spool_dir()
            folder.mkdir(parents=True, exist_ok=True)
            used = sum(f.stat().st_size for f in folder.glob("*.json.gz"))
            data = gzip.compress(json.dumps(batch, separators=(",", ":"), default=str).encode("utf-8"))
            if used + len(data) > SPOOL_MAX_BYTES:
                if not self.spool_full_warned:
                    self.spool_full_warned = True
                    log.warning("Lucid: offline spool is full (%d MB); dropping new events", SPOOL_MAX_BYTES // 1_048_576)
                return
            name = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}.json.gz"
            tmp = folder / f".{name}.tmp"
            tmp.write_bytes(data)
            tmp.replace(folder / name)  # atomic: a half-written file is never resent
        except Exception:
            log.debug("Lucid: could not spool a batch", exc_info=True)

    def drain_spool(self, limit: int = 50) -> None:
        """Resend spooled batches, oldest first; stop at the first failure."""
        if not self.spool_lock.acquire(blocking=False):
            return
        try:
            self.last_spool_try = time.monotonic()
            files = sorted(_spool_dir().glob("*.json.gz"))[:limit]
            for path in files:
                try:
                    batch = json.loads(gzip.decompress(path.read_bytes()))
                except Exception:
                    path.unlink(missing_ok=True)  # unreadable: nothing to recover
                    continue
                if not self._post(batch):
                    return
                path.unlink(missing_ok=True)
                self.spool_full_warned = False
        except Exception:
            log.debug("Lucid: spool drain failed", exc_info=True)
        finally:
            self.spool_lock.release()

    def _spool_waiting(self) -> bool:
        try:
            return any(_spool_dir().glob("*.json.gz"))
        except OSError:
            return False

    def _run(self) -> None:
        while True:
            try:
                first = self.queue.get(timeout=FLUSH_SECONDS)
            except queue.Empty:
                if time.monotonic() - self.last_spool_try > SPOOL_RETRY_SECONDS and self._spool_waiting():
                    self.drain_spool()
                continue
            batch = [first] + self._drain(BATCH_SIZE - 1)
            try:
                if self._post(batch):
                    if self._spool_waiting():
                        self.drain_spool()  # Lucid is back: catch up
                else:
                    self._spool(batch)
            finally:
                for _ in batch:
                    self.queue.task_done()

    def flush(self, seconds: float = EXIT_FLUSH_SECONDS) -> None:
        """Synchronous best-effort flush, for process exit (one-shot `hermes chat -q`).

        Waits on the queue's unfinished-task count, which also covers a batch
        the worker has taken but not finished sending.
        """
        deadline = time.monotonic() + seconds
        while self.queue.unfinished_tasks and time.monotonic() < deadline:
            batch = self._drain(BATCH_SIZE)
            if not batch:
                time.sleep(0.02)
                continue
            try:
                if not self._post(batch, timeout=max(0.2, deadline - time.monotonic())):
                    self._spool(batch)  # offline at exit: keep it for the next run
            finally:
                for _ in batch:
                    self.queue.task_done()


class _Correlator:
    """Links events Hermes reports separately.

    Sub-agents run as their own sessions with their own turns; their events are
    re-tagged with the parent run (`lucid_root_turn_id`) and the sub-agent step
    they belong under (`lucid_parent_step`). Approvals and turn ends carry no
    turn id, so the current turn is attached. Tool calls without a provider id
    get a generated one, paired pre → post.
    """

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.children: dict[str, dict[str, str]] = {}
        self.session_turn: dict[str, str] = {}
        self.last_turn: Optional[tuple[str, str]] = None
        self.tool_ids: dict[tuple[str, str], list[str]] = {}
        self.approvals: dict[tuple[str, str], str] = {}
        self.tools_sent: set[str] = set()

    def annotate(self, hook: str, payload: dict[str, Any]) -> None:
        with self.lock:
            session = str(payload.get("session_id") or "")
            if hook == "subagent_start":
                self._start_child(payload)
            child = self.children.get(session) or (
                self.children.get(str(payload.get("parent_session_id") or "")) if hook.startswith("subagent_") else None
            )
            if child:
                payload["lucid_root_turn_id"] = child["root_turn"]
                payload["lucid_root_session_id"] = child["root_session"]
                payload["lucid_parent_step"] = child["step"]

            if hook == "pre_llm_call" and session and session not in self.children and payload.get("turn_id"):
                self.session_turn[session] = str(payload["turn_id"])
                self.last_turn = (str(payload["turn_id"]), session)
            if hook == "on_session_end" and session in self.session_turn:
                payload["lucid_turn_id"] = self.session_turn[session]
            if hook in ("pre_approval_request", "post_approval_response") and self.last_turn:
                payload["lucid_turn_id"], payload["lucid_root_session_id"] = self.last_turn
                key = (str(payload.get("session_key") or ""), str(payload.get("command") or ""))
                if hook == "pre_approval_request":
                    self.approvals[key] = f"approval:{uuid.uuid4().hex[:12]}"
                approval = self.approvals.get(key) if hook == "pre_approval_request" else self.approvals.pop(key, None)
                if approval:
                    payload["lucid_approval_id"] = approval
            if hook in ("pre_tool_call", "post_tool_call") and not payload.get("tool_call_id"):
                key = (session, str(payload.get("tool_name") or ""))
                if hook == "pre_tool_call":
                    generated = f"tool:{uuid.uuid4().hex[:12]}"
                    self.tool_ids.setdefault(key, []).append(generated)
                    payload["lucid_tool_id"] = generated
                elif self.tool_ids.get(key):
                    payload["lucid_tool_id"] = self.tool_ids[key].pop()

    def _start_child(self, payload: dict[str, Any]) -> None:
        child_session = str(payload.get("child_session_id") or "")
        parent_session = str(payload.get("parent_session_id") or "")
        if not child_session:
            return
        parent = self.children.get(parent_session)
        if parent:  # a sub-agent of a sub-agent: same root run, nested step
            root_turn, root_session = parent["root_turn"], parent["root_session"]
        else:
            root_turn = str(payload.get("parent_turn_id") or self.session_turn.get(parent_session) or "")
            root_session = parent_session
        if root_turn:
            self.children[child_session] = {"root_turn": root_turn, "root_session": root_session, "step": f"subagent:{child_session}"}

    def tools_once(self, payload: dict[str, Any], tools: Optional[list[Any]]) -> None:
        """Send tool names on every request, full tool schemas only when they change.

        `tools` is the separately captured, intact copy; the size-bounded one
        in the request body is dropped.
        """
        request = payload.get("request")
        body = request.get("body") if isinstance(request, dict) else None
        if isinstance(body, dict):
            body.pop("tools", None)
        if not isinstance(tools, list):
            return
        names = []
        for tool in tools:
            fn = tool.get("function", tool) if isinstance(tool, dict) else {}
            if isinstance(fn, dict) and fn.get("name"):
                names.append(str(fn["name"]))
        payload["tool_names"] = names
        digest = hashlib.sha256(json.dumps(tools, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]
        payload["tools_hash"] = digest
        with self.lock:
            if digest not in self.tools_sent:
                self.tools_sent.add(digest)
                payload["tools_def"] = tools


_sender = _Sender()
_correlator = _Correlator()


def _reasoning(message: Any) -> Optional[str]:
    for attr in ("reasoning", "reasoning_content"):
        value = message.get(attr) if isinstance(message, dict) else getattr(message, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    return None


class _Lessons:
    """Lessons the owner approved in Lucid ("When running as a cron job, never use
    execute_code"), added to every turn through pre_llm_call's context, which
    Hermes appends to the copy of the user message sent to the model; nothing
    on disk changes. A background thread refreshes them; the hook only reads the
    cached copy, so a turn never waits on the network. If Lucid can't be
    reached, the last lessons stay in effect; turning one off in Lucid takes it
    out within a minute."""

    def __init__(self) -> None:
        self.block = ""
        self.lock = threading.Lock()
        self.started = False

    def context(self) -> Optional[dict[str, str]]:
        with self.lock:
            return {"context": self.block} if self.block else None

    def refresh(self) -> None:
        endpoint, key = _config()
        headers = {"User-Agent": "lucid-hermes-plugin/0.4"}
        if key:
            headers["x-api-key"] = key
        request = urllib.request.Request(f"{endpoint}/v1/lessons?harness=hermes", headers=headers)
        with urllib.request.urlopen(request, timeout=LESSONS_TIMEOUT) as response:
            lessons = json.loads(response.read().decode("utf-8")).get("lessons") or []
        lines = [f"- {str(lesson.get('text', '')).strip()}" for lesson in lessons if str(lesson.get("text", "")).strip()]
        block = ""
        if lines:
            block = "Lessons from your owner, via Lucid (follow them):\n" + "\n".join(lines)
        with self.lock:
            self.block = block[:LESSONS_MAX_CHARS]

    def _loop(self) -> None:
        while True:
            try:
                self.refresh()
            except Exception:  # an older Lucid, or offline: keep what we have
                log.debug("Lucid lessons refresh failed", exc_info=True)
            time.sleep(LESSONS_REFRESH_SECONDS)

    def start(self) -> None:
        if not self.started:
            self.started = True
            threading.Thread(target=self._loop, name="lucid-lessons", daemon=True).start()


_lessons = _Lessons()


def _make_hook(hook: str):
    def _hook(**kwargs: Any) -> Optional[dict[str, str]]:
        _observe(hook, kwargs)
        # The one hook whose return value Hermes uses: context for this turn.
        return _lessons.context() if hook == "pre_llm_call" else None

    return _hook


def _observe(hook: str, kwargs: dict[str, Any]) -> None:
    try:
        reasoning = _reasoning(kwargs.get("assistant_message")) if hook == "post_api_request" else None
        tools = _raw_tools(kwargs) if hook == "pre_api_request" else None
        messages = _raw_messages(kwargs) if hook == "pre_api_request" else None
        payload = _jsonable({k: v for k, v in kwargs.items() if k not in DROPPED_FIELDS})
        payload["hook"] = hook
        payload["ts"] = time.time()
        if reasoning:
            payload["reasoning"] = reasoning[:MAX_STRING]
        if hook == "pre_api_request":
            _correlator.tools_once(payload, tools)
            # Replays need the exact messages; the sanitized copy may be cut.
            body = payload.get("request", {}).get("body") if isinstance(payload.get("request"), dict) else None
            if messages is not None and isinstance(body, dict):
                body["messages"] = messages
        _correlator.annotate(hook, payload)
        _sender.put(payload)
    except Exception:  # observability must never break the agent
        log.debug("Lucid hook %s failed", hook, exc_info=True)


def _history_groups(db_path: Path, days: float) -> list[tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
    """Past sessions from Hermes' state.db, grouped by root session (a sub-agent
    session travels with the conversation that started it)."""
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        have = {row["name"] for row in connection.execute("pragma table_info(sessions)")}
        have_messages = {row["name"] for row in connection.execute("pragma table_info(messages)")}
        session_cols = ", ".join(c for c in SESSION_COLUMNS if c in have)
        message_cols = ", ".join(c for c in MESSAGE_COLUMNS if c in have_messages)
        rows = [dict(row) for row in connection.execute(f"select {session_cols} from sessions order by started_at")]
        by_id = {str(row["id"]): row for row in rows}

        def root_of(row: dict[str, Any]) -> dict[str, Any]:
            seen: set[str] = set()
            while row.get("parent_session_id") and str(row["parent_session_id"]) in by_id and str(row["id"]) not in seen:
                seen.add(str(row["id"]))
                row = by_id[str(row["parent_session_id"])]
            return row

        since = time.time() - days * 86_400
        groups: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            root = root_of(row)
            if float(root.get("ended_at") or root.get("started_at") or 0) >= since:
                groups.setdefault(str(root["id"]), []).append(row)
        out = []
        for sessions in groups.values():
            messages: list[dict[str, Any]] = []
            for session in sessions:
                messages.extend(
                    dict(row)
                    for row in connection.execute(
                        f"select {message_cols} from messages where session_id = ? order by timestamp, id", (session["id"],)
                    )
                )
            out.append((sessions, messages))
        return out
    finally:
        connection.close()


class _SyncProgress:
    """Tells Lucid how far the backfill is ("12 of 40"), so the dashboard shows
    it's still bringing runs in. Best effort: a Lucid without /v1/syncs, or a
    lost report, never stops the backfill. A backfill that stops early simply
    goes quiet, and Lucid stops showing it after a few minutes."""

    EVERY_SECONDS = 2.0

    def __init__(self, total: int) -> None:
        self.id = uuid.uuid4().hex
        self.total = total
        self.done = 0
        self.sent_at = 0.0
        if total:
            self._send()

    def advance(self) -> None:
        self.done += 1
        if time.time() - self.sent_at >= self.EVERY_SECONDS:
            self._send()

    def finish(self) -> None:
        if self.total:
            self._send(finished=True)

    def _send(self, finished: bool = False) -> None:
        self.sent_at = time.time()
        report = {"id": self.id, "harness": "hermes", "total": self.total, "done": self.done, "finished": finished}
        try:
            _post_json("/v1/syncs", report, 10.0)
        except Exception:  # noqa: BLE001 (progress is decoration; the upload matters)
            pass


def _backfill(days: float) -> None:
    """Upload past sessions once per Lucid endpoint, from inside Hermes.

    Works where the CLI cannot reach (a remote VPS or container): only the
    plugin and its .env settings are needed. Re-imports are harmless (runs
    upsert by id, and sessions captured live are skipped server-side); the
    marker only saves the work. A network failure leaves no marker, so the
    next Hermes start tries again.
    """
    try:
        home = _hermes_home()
        db_path = home / "state.db"
        marker = home / BACKFILL_MARKER
        endpoint = _config()[0]
        try:
            done = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            done = {}
        if endpoint in done or not db_path.exists():
            return
        # Newest first, so the runs people remember show up first.
        groups = list(reversed(_history_groups(db_path, days)))
        sync = _SyncProgress(len(groups))
        imported = 0
        for sessions, messages in groups:
            try:
                if _post_json("/v1/imports/hermes", {"sessions": sessions, "messages": messages}, BACKFILL_TIMEOUT):
                    imported += 1
            except urllib.error.HTTPError as error:
                if error.code not in REJECTED_FOREVER:
                    log.warning("Lucid backfill stopped (HTTP %d); will retry on the next start", error.code)
                    return
                log.warning("Lucid backfill skipped a conversation (HTTP %d)", error.code)
            except (OSError, urllib.error.URLError, ValueError) as error:
                log.warning("Lucid backfill stopped (%s); will retry on the next start", error)
                return
            sync.advance()
        sync.finish()
        done[endpoint] = {"at": time.time(), "days": days, "conversations": imported}
        tmp = marker.with_name(f".{BACKFILL_MARKER}.tmp")
        tmp.write_text(json.dumps(done, indent=2), encoding="utf-8")
        tmp.replace(marker)
        log.info("Lucid backfill: uploaded %d past conversations", imported)
    except Exception:
        log.warning("Lucid backfill failed", exc_info=True)


def _backfill_days() -> Optional[float]:
    try:
        days = float(os.environ.get("LUCID_BACKFILL_DAYS") or 0)
    except ValueError:
        return None
    return days if days > 0 else None


def register(ctx: Any) -> None:
    for hook in HOOKS:
        ctx.register_hook(hook, _make_hook(hook))
    atexit.register(_sender.flush)
    _lessons.start()
    days = _backfill_days()
    if days:
        threading.Thread(target=_backfill, args=(days,), name="lucid-backfill", daemon=True).start()

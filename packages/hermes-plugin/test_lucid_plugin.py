"""Tests for the Lucid Hermes plugin. Stdlib only: python -I test_lucid_plugin.py"""

import gzip
import importlib.util
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

RECEIVED: list[dict] = []
ANSWER = {"status": 200}
LESSONS: dict = {"lessons": []}
FETCHES: list[dict] = []
# Files the fake Lucid serves under /install/hermes/lucid/, for updates.
FILES: dict[str, bytes] = {}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path in FILES:
            body = FILES[self.path]
        else:
            FETCHES.append({"path": self.path, "key": self.headers.get("x-api-key"), "staged": self.headers.get("x-lucid-plugin-staged")})
            body = json.dumps(LESSONS).encode("utf-8")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers["Content-Length"]))
        encoding = self.headers.get("Content-Encoding")
        if encoding == "gzip":
            body = gzip.decompress(body)
        if ANSWER["status"] == 200:
            RECEIVED.append({"path": self.path, "key": self.headers.get("x-api-key"), "encoding": encoding, "body": json.loads(body)})
        self.send_response(ANSWER["status"])
        self.end_headers()
        self.wfile.write(b'{"imported": 1}')

    def log_message(self, *args):
        pass


class FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn


def load_plugin():
    path = Path(__file__).parent / "lucid" / "__init__.py"
    spec = importlib.util.spec_from_file_location("lucid_plugin_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AssistantMessage:
    """Stands in for Hermes' normalized message object (not JSON-serializable)."""

    def __init__(self):
        self.role = "assistant"
        self.content = ""
        self.reasoning = "Look at the failing test first."


class PluginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        os.environ["LUCID_ENDPOINT"] = f"http://127.0.0.1:{cls.server.server_port}"
        os.environ["LUCID_API_KEY"] = "lucid_live_test"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        RECEIVED.clear()
        FETCHES.clear()
        FILES.clear()
        LESSONS.clear()
        LESSONS["lessons"] = []
        ANSWER["status"] = 200
        os.environ.pop("LUCID_BACKFILL_DAYS", None)
        self.home = home = Path(tempfile.mkdtemp(prefix="lucid-hermes-"))
        self.plugin = load_plugin()
        # Pinned per loaded copy: sender threads of earlier tests keep running
        # and must not touch this test's folders.
        self.plugin._hermes_home = lambda: home
        self.plugin._spool_dir = lambda: home / "lucid-spool"
        self.ctx = FakeCtx()
        self.plugin.register(self.ctx)

    def tearDown(self):
        os.environ.pop("LUCID_BACKFILL_DAYS", None)
        self.wait_for(lambda: self.plugin._sender.queue.unfinished_tasks == 0)
        os.environ["LUCID_ENDPOINT"] = f"http://127.0.0.1:{self.server.server_port}"
        shutil.rmtree(self.home, ignore_errors=True)

    def spooled(self):
        return sorted((self.home / "lucid-spool").glob("*.json.gz"))

    def wait_for(self, condition, seconds=10):
        deadline = time.time() + seconds
        while time.time() < deadline and not condition():
            time.sleep(0.05)
        return condition()

    def events(self):
        self.plugin._sender.flush(seconds=5)
        deadline = time.time() + 5
        while time.time() < deadline and not RECEIVED:
            time.sleep(0.05)
        return [event for post in RECEIVED for event in post["body"]["events"]]

    def test_registers_every_observer_hook(self):
        self.assertEqual(set(self.ctx.hooks), set(self.plugin.HOOKS))

    def test_forwards_a_turn_with_subagent_and_approval(self):
        h = self.ctx.hooks
        turn = "s1:task:abc"
        tools = [{"type": "function", "function": {"name": "terminal", "description": "x" * 50}}]
        h["pre_llm_call"](session_id="s1", turn_id=turn, user_message="Fix the test", conversation_history=[{"role": "user"}] * 500)
        for n in (1, 2):
            h["pre_api_request"](session_id="s1", turn_id=turn, api_request_id=f"{turn}:api:{n}", request={"method": "POST", "body": {"messages": [], "tools": tools}})
        h["post_api_request"](session_id="s1", turn_id=turn, api_request_id=f"{turn}:api:1", usage={"input_tokens": 5}, assistant_message=AssistantMessage())
        h["pre_tool_call"](session_id="s1", turn_id=turn, tool_name="terminal", args={"command": "npm test"})
        h["post_tool_call"](session_id="s1", turn_id=turn, tool_name="terminal", result="ok", status="ok")
        h["subagent_start"](parent_session_id="s1", parent_turn_id=turn, child_session_id="c1", child_goal="Read tests")
        h["pre_api_request"](session_id="c1", turn_id="c1:t:1", api_request_id="c1:t:1:api:1", request={"body": {}})
        h["subagent_start"](parent_session_id="c1", parent_turn_id="c1:t:1", child_session_id="c2", child_goal="Nested")
        h["pre_approval_request"](command="rm -rf build", description="Delete", session_key="k")
        h["post_approval_response"](command="rm -rf build", description="Delete", session_key="k", choice="deny")
        h["on_session_end"](session_id="s1", completed=True)

        events = self.events()
        self.assertTrue(all(post["path"] == "/v1/hooks/hermes" and post["key"] == "lucid_live_test" for post in RECEIVED))
        by_hook = {}
        for event in events:
            by_hook.setdefault(event["hook"], []).append(event)

        # Legacy duplicates are dropped; reasoning is lifted out of the message object.
        self.assertNotIn("conversation_history", by_hook["pre_llm_call"][0])
        self.assertEqual(by_hook["post_api_request"][0]["reasoning"], "Look at the failing test first.")
        self.assertNotIn("assistant_message", by_hook["post_api_request"][0])

        # Tool names every time, full schemas only once.
        first, second = by_hook["pre_api_request"][:2]
        self.assertEqual(first["tool_names"], ["terminal"])
        self.assertIn("tools_def", first)
        self.assertNotIn("tools_def", second)
        self.assertNotIn("tools", first["request"]["body"])

        # Tool calls without a provider id are paired by a generated id.
        pre_tool, post_tool = by_hook["pre_tool_call"][0], by_hook["post_tool_call"][0]
        self.assertTrue(pre_tool["lucid_tool_id"].startswith("tool:"))
        self.assertEqual(pre_tool["lucid_tool_id"], post_tool["lucid_tool_id"])

        # Child events go to the parent run, nested sub-agents under their parent step.
        child_api = [e for e in by_hook["pre_api_request"] if e["session_id"] == "c1"][0]
        self.assertEqual(child_api["lucid_root_turn_id"], turn)
        self.assertEqual(child_api["lucid_parent_step"], "subagent:c1")
        nested = [e for e in by_hook["subagent_start"] if e["child_session_id"] == "c2"][0]
        self.assertEqual(nested["lucid_root_turn_id"], turn)
        self.assertEqual(nested["lucid_parent_step"], "subagent:c1")

        # Approvals and turn ends get the current turn.
        pre_approval, post_approval = by_hook["pre_approval_request"][0], by_hook["post_approval_response"][0]
        self.assertEqual(pre_approval["lucid_turn_id"], turn)
        self.assertEqual(pre_approval["lucid_approval_id"], post_approval["lucid_approval_id"])
        self.assertEqual(by_hook["on_session_end"][0]["lucid_turn_id"], turn)

    def test_keeps_deep_tool_schemas_intact(self):
        # A realistic schema: an array of objects with nested enums sits ~12
        # levels below the hook's kwargs. The general size bound must not cut it.
        schema = {"type": "object", "properties": {"steps": {"type": "array", "items": {"type": "object", "properties": {"action": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["click", "type"]}}}}}}}}
        tools = [{"type": "function", "function": {"name": "browser_exec", "description": "Run steps", "parameters": schema}}]
        self.ctx.hooks["pre_api_request"](session_id="s", turn_id="t", api_request_id="t:api:1", request={"method": "POST", "body": {"messages": [{"role": "user", "content": "hi"}], "tools": tools}})
        event = self.events()[0]
        self.assertEqual(event["tools_def"], tools)
        self.assertNotIn("truncated by Lucid", json.dumps(event["tools_def"]))
        self.assertNotIn("tools", event["request"]["body"])

    def test_takes_tools_and_messages_from_what_hermes_sends(self):
        # Hermes' sanitized `request` has schemas cut to "<dict depth limit>";
        # the plugin reads the intact list from the caller's `api_kwargs`.
        intact = [{"type": "function", "function": {"name": "clarify", "parameters": {"type": "object", "properties": {"questions": {"type": "array", "items": {"type": "object", "properties": {"q": {"type": "string"}}}}}}}}]
        cut = [{"type": "function", "function": {"name": "clarify", "parameters": {"type": "object", "properties": {"questions": {"type": "array", "items": {"type": "<str depth limit>"}}}}}}]
        hook = self.ctx.hooks["pre_api_request"]

        # Another agent mid-call with different tools: must not be picked.
        other_ready, other_done = threading.Event(), threading.Event()

        def other_agent():
            api_kwargs = {"tools": [{"type": "function", "function": {"name": "wrong_tool"}}], "messages": [{"role": "user", "content": "other"}]}
            other_ready.set()
            other_done.wait(5)
            return api_kwargs

        threading.Thread(target=other_agent, daemon=True).start()
        other_ready.wait(5)

        def conversation_loop():
            # Stands in for Hermes: the request lives in this frame, and the hook
            # runs on a worker thread while this one waits (as Hermes does).
            api_kwargs = {"model": "x", "tools": intact, "messages": [{"role": "user", "content": "hi, the full message"}]}
            worker = threading.Thread(
                target=lambda: hook(
                    session_id="s",
                    turn_id="t",
                    api_request_id="t:api:1",
                    request={"method": "POST", "body": {"messages": [{"role": "user", "content": "hi…"}], "tools": cut}},
                    request_messages=list(api_kwargs["messages"]),
                    system_prompt="You are Hermes.",
                )
            )
            worker.start()
            worker.join(5)
            return api_kwargs

        conversation_loop()
        other_done.set()
        event = self.events()[0]
        self.assertEqual(event["tools_def"], intact)
        self.assertEqual(event["request"]["body"]["messages"], [{"role": "system", "content": "You are Hermes."}, {"role": "user", "content": "hi, the full message"}])

    def test_bounds_huge_payloads(self):
        self.ctx.hooks["post_tool_call"](session_id="s", turn_id="t", tool_call_id="c", result="x" * 100_000)
        event = self.events()[0]
        self.assertLess(len(event["result"]), 25_000)

    def test_never_raises_when_the_server_is_down(self):
        os.environ["LUCID_ENDPOINT"] = "http://127.0.0.1:9"
        self.ctx.hooks["pre_llm_call"](session_id="s", turn_id="t", user_message="hi")
        self.plugin._sender.flush(seconds=1)

    def test_keeps_events_while_lucid_is_down_and_resends_them(self):
        os.environ["LUCID_ENDPOINT"] = "http://127.0.0.1:9"
        self.ctx.hooks["pre_llm_call"](session_id="s", turn_id="t-offline", user_message="while down")
        self.assertTrue(self.wait_for(lambda: len(self.spooled()) == 1), "batch was not spooled")
        self.assertEqual(RECEIVED, [])

        os.environ["LUCID_ENDPOINT"] = f"http://127.0.0.1:{self.server.server_port}"
        # The sender may be mid-retry against the dead port; keep asking until it is free.
        self.assertTrue(self.wait_for(lambda: self.plugin._sender.drain_spool() or (RECEIVED and not self.spooled())))
        events = [event for post in RECEIVED for event in post["body"]["events"]]
        self.assertEqual([e["turn_id"] for e in events], ["t-offline"])

    def test_spool_has_a_size_cap(self):
        self.plugin.SPOOL_MAX_BYTES = 1  # nothing fits
        self.plugin._sender._spool([{"hook": "pre_llm_call"}])
        self.assertEqual(self.spooled(), [])

    def test_compresses_large_batches(self):
        self.ctx.hooks["post_tool_call"](session_id="s", turn_id="t", tool_call_id="c", result="line of output\n" * 1_000)
        self.events()
        self.assertEqual(RECEIVED[0]["encoding"], "gzip")
        RECEIVED.clear()
        self.ctx.hooks["pre_llm_call"](session_id="s", turn_id="t", user_message="small")
        self.events()
        self.assertIsNone(RECEIVED[0]["encoding"])

    def test_drops_batches_the_server_rejects_for_good(self):
        ANSWER["status"] = 400
        self.ctx.hooks["pre_llm_call"](session_id="s", turn_id="t", user_message="malformed somehow")
        self.plugin._sender.flush(seconds=5)
        self.assertEqual(self.spooled(), [])

    def make_state_db(self, now):
        # Older Hermes schema: no git_branch / reasoning_content columns.
        db = sqlite3.connect(self.home / "state.db")
        db.execute("create table sessions (id text primary key, source text, model text, parent_session_id text, started_at real, ended_at real, title text)")
        db.execute("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real)")
        db.executemany(
            "insert into sessions values (?, ?, ?, ?, ?, ?, ?)",
            [
                ("root", "cli", "m", None, now - 3_600, now - 3_000, "Fix the build"),
                ("child", "cli", "m", "root", now - 3_500, now - 3_400, None),
                ("old", "cli", "m", None, now - 90 * 86_400, now - 90 * 86_400, "Ancient"),
            ],
        )
        db.executemany(
            "insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)",
            [("root", "user", "fix it", now - 3_590), ("child", "user", "read logs", now - 3_490), ("old", "user", "hello", now - 90 * 86_400)],
        )
        db.commit()
        db.close()

    def test_backfills_history_once(self):
        self.make_state_db(time.time())
        self.plugin._backfill(30)
        imports = [post for post in RECEIVED if post["path"] == "/v1/imports/hermes"]
        self.assertEqual(len(imports), 1)  # the child travels with its root; the old one is outside the window
        body = imports[0]["body"]
        self.assertEqual(sorted(s["id"] for s in body["sessions"]), ["child", "root"])
        self.assertEqual(sorted(m["content"] for m in body["messages"]), ["fix it", "read logs"])
        self.assertNotIn("git_branch", body["sessions"][0])
        self.assertTrue((self.home / "lucid-backfill.json").exists())
        # Lucid hears how far it got, so the dashboard can say it's still syncing.
        syncs = [post["body"] for post in RECEIVED if post["path"] == "/v1/syncs"]
        self.assertEqual([(s["total"], s["done"], s["finished"]) for s in syncs], [(1, 0, False), (1, 1, True)])
        self.assertEqual({s["id"] for s in syncs}, {syncs[0]["id"]})
        self.assertEqual(syncs[0]["harness"], "hermes")

        RECEIVED.clear()
        self.plugin._backfill(30)
        self.assertEqual(RECEIVED, [])

    def test_backfill_sends_the_newest_conversations_first(self):
        now = time.time()
        self.make_state_db(now)
        db = sqlite3.connect(self.home / "state.db")
        db.execute("insert into sessions values ('newer', 'cli', 'm', null, ?, ?, 'Newer task')", (now - 600, now - 500))
        db.commit()
        db.close()
        self.plugin._backfill(30)
        imports = [post["body"] for post in RECEIVED if post["path"] == "/v1/imports/hermes"]
        self.assertEqual([body["sessions"][0]["id"] for body in imports], ["newer", "root"])

    def test_backfill_retries_on_next_start_when_lucid_is_down(self):
        self.make_state_db(time.time())
        os.environ["LUCID_ENDPOINT"] = "http://127.0.0.1:9"
        self.plugin._backfill(30)
        self.assertFalse((self.home / "lucid-backfill.json").exists())

    def test_adds_approved_lessons_to_every_turn(self):
        hook = self.ctx.hooks["pre_llm_call"]
        turn = {"session_id": "s1", "turn_id": "s1:task:1", "user_message": "check the repos"}
        self.assertIsNone(hook(**turn))  # nothing approved yet: nothing added

        LESSONS["lessons"] = [
            {"id": "l1", "text": "When running as a cron job, never use execute_code."},
            {"id": "l2", "text": "Call one local tool per tool call."},
        ]
        expected = {
            "context": "Lessons from your owner, via Lucid (follow them):\n"
            "- When running as a cron job, never use execute_code.\n"
            "- Call one local tool per tool call."
        }

        def refreshed():
            self.plugin._lessons.refresh()
            return hook(**turn) == expected

        self.assertTrue(self.wait_for(refreshed))
        self.assertEqual(FETCHES[-1], {"path": "/v1/lessons?harness=hermes", "key": "lucid_live_test", "staged": None})
        # Only pre_llm_call's answer is used by Hermes; the others stay observers.
        self.assertIsNone(self.ctx.hooks["post_llm_call"](session_id="s1", turn_id="s1:task:1", assistant_response="ok"))
        # The turn is still observed as before.
        self.assertTrue(any(event["hook"] == "pre_llm_call" for event in self.events()))

        # Lucid unreachable: the lessons already approved stay in effect.
        os.environ["LUCID_ENDPOINT"] = "http://127.0.0.1:9"
        with self.assertRaises(OSError):
            self.plugin._lessons.refresh()
        self.assertEqual(hook(**turn), expected)

        # Turned off in Lucid: gone from the next refresh.
        os.environ["LUCID_ENDPOINT"] = f"http://127.0.0.1:{self.server.server_port}"
        LESSONS["lessons"] = []
        self.plugin._lessons.refresh()
        self.assertIsNone(hook(**turn))

    def test_version_matches_its_manifest(self):
        manifest = (Path(__file__).parent / "lucid" / "plugin.yaml").read_text(encoding="utf-8")
        self.assertIn(f'version: "{self.plugin.VERSION}"', manifest)

    def copy_of_plugin(self):
        """The plugin loaded from a scratch folder, so an update can't touch the real files."""
        folder = self.home / "plugins" / "lucid"
        shutil.copytree(Path(__file__).parent / "lucid", folder, ignore=shutil.ignore_patterns("__pycache__"))
        spec = importlib.util.spec_from_file_location("lucid_plugin_copy", folder / "__init__.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, folder

    def offer(self, version, init_py, yaml):
        FILES["/install/hermes/lucid/__init__.py"] = init_py.encode("utf-8")
        FILES["/install/hermes/lucid/plugin.yaml"] = yaml.encode("utf-8")
        LESSONS["update"] = {"version": version, "files": {name: f"/install/hermes/lucid/{name}" for name in ("__init__.py", "plugin.yaml")}}

    def test_updates_itself_when_the_owner_asks(self):
        plugin, folder = self.copy_of_plugin()
        self.offer("0.6.0", 'VERSION = "0.6.0"\n', 'name: lucid\nversion: "0.6.0"\n')
        plugin._lessons.refresh()
        self.assertEqual((folder / "__init__.py").read_text(encoding="utf-8"), 'VERSION = "0.6.0"\n')
        self.assertIn('version: "0.6.0"', (folder / "plugin.yaml").read_text(encoding="utf-8"))
        self.assertEqual(plugin._lessons.staged, "0.6.0")
        self.assertEqual(sorted(p.name for p in folder.iterdir() if p.name.endswith(".part")), [])
        # Lucid hears it's waiting for a restart; the same offer isn't downloaded twice.
        FILES.clear()
        plugin._lessons.refresh()
        self.assertEqual(FETCHES[-1]["staged"], "0.6.0")

    def test_refuses_updates_that_arent_its_own_files_or_arent_whole(self):
        plugin, folder = self.copy_of_plugin()
        original = (folder / "__init__.py").read_bytes()
        # From anywhere but the Lucid it reports to.
        LESSONS["update"] = {"version": "0.6.0", "files": {"__init__.py": "http://elsewhere.example/x.py", "plugin.yaml": "/install/hermes/lucid/plugin.yaml"}}
        plugin._lessons.refresh()
        # Broken code, or not the version promised.
        self.offer("0.6.0", "def broken(:\n", 'version: "0.6.0"\n')
        plugin._lessons.refresh()
        self.offer("0.6.0", 'VERSION = "0.6.0"\n', 'version: "0.5.9"\n')
        plugin._lessons.refresh()
        self.assertEqual((folder / "__init__.py").read_bytes(), original)
        self.assertIsNone(plugin._lessons.staged)

    def test_backfill_starts_from_register_when_asked(self):
        self.make_state_db(time.time())
        os.environ["LUCID_BACKFILL_DAYS"] = "7"
        self.plugin.register(FakeCtx())
        self.assertTrue(self.wait_for(lambda: any(post["path"] == "/v1/imports/hermes" for post in RECEIVED)))


if __name__ == "__main__":
    sys.exit(unittest.main(verbosity=1, exit=False).result.wasSuccessful() is False)

#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("cto-relay-snapshot.py")
SPEC = importlib.util.spec_from_file_location("cto_relay_snapshot", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


ROUTER_SOP = Path(__file__).resolve().parents[1] / "monitors/cto-slack-relay/WAKE_SOP.md"


def event(
    key: str = "C0ALZJHGE49:1",
    fingerprint: str = "route:C0ALZJHGE49:1",
    channel: str = "C0ALZJHGE49",
    text: str = "<@U0BNFGX2UAX> HeyDonna event",
    slack_event_type: str = "message.channel",
) -> dict:
    return {
        "dedup_key": key,
        "fingerprint": fingerprint,
        "sop_path": str(ROUTER_SOP),
        "exact_tuple": {
            "channel": channel,
            "ts": key.rsplit(":", 1)[-1],
            "thread_ts": None,
            "user": "U1",
            "bot_id": None,
            "text": text,
        },
        "source_evidence": {"slack_event_type": slack_event_type},
        "wake_text": f"SOP path: {ROUTER_SOP}\n\nCurrent message:\n{text}",
    }


class RelaySnapshotTests(unittest.TestCase):
    def test_current_object_schema_finds_pending_event(self) -> None:
        events = MODULE.extract_events({"version": 1, "events": [event()]})
        self.assertEqual(MODULE.pending_events(events, set(), {}, 0.0, None), [event()])

    def test_legacy_list_schema_remains_supported(self) -> None:
        self.assertEqual(MODULE.extract_events([event()]), [event()])

    def test_key_or_fingerprint_ack_suppresses_event(self) -> None:
        events = [event()]
        self.assertEqual(
            MODULE.pending_events(events, {"C0ALZJHGE49:1"}, {}, 0.0, None), []
        )
        self.assertEqual(
            MODULE.pending_events(
                events, {"route:C0ALZJHGE49:1"}, {}, 0.0, None
            ),
            [],
        )

    def test_live_sop_routes_dm_directly_to_cto_dm_task(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        source = event(
            "D0BPG55FG72:1",
            "route:D0BPG55FG72:1",
            "D0BPG55FG72",
            "HeyDonna DM",
            "message.im",
        )
        routed = MODULE.route_event(source, table, ROUTER_SOP)
        self.assertEqual(
            routed["relay_route"]["destination_thread_id"],
            "01a0911a-a718-7743-b37e-e785f24f3708",
        )
        self.assertEqual(routed["relay_route"]["project"], "heydonna")
        self.assertEqual(routed["relay_route"]["match"], "direct_message")
        self.assertEqual(
            routed["relay_route"]["consumer_sop_path"],
            "/Users/rajiv/.codex/monitors/cto-dms/WAKE_SOP.md",
        )
        self.assertNotIn(
            "01a02002-6986-7953-ab5a-cc8087476873",
            json.dumps(routed["relay_route"]),
        )

    def test_live_sop_keeps_non_dm_heydonna_on_existing_route(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        routed = MODULE.route_event(event(), table, ROUTER_SOP)
        self.assertEqual(
            routed["relay_route"]["destination_thread_id"],
            "01a09112-a09c-7361-9a2a-0ada6a4e9dfb",
        )
        self.assertEqual(routed["relay_route"]["match"], "default")

    def test_live_sop_routes_app_mentions_to_cto_decisions(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        source = event(
            "C0ALZJHGE49:2",
            "route:C0ALZJHGE49:2",
            "C0ALZJHGE49",
            "<@U0BNFGX2UAX> HeyDonna app mention",
            "app_mention",
        )
        routed = MODULE.route_event(source, table, ROUTER_SOP)
        self.assertEqual(
            routed["relay_route"]["destination_thread_id"],
            "01a09112-a09c-7361-9a2a-0ada6a4e9dfb",
        )
        self.assertEqual(routed["relay_route"]["match"], "default")
        self.assertEqual(
            routed["relay_route"]["consumer_sop_path"],
            "/Users/rajiv/.codex/monitors/heydonna-pm-chat/WAKE_SOP.md",
        )

    def test_live_sop_routes_superproofer_to_godavari(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        source = event(
            "C09TYQC1DEF:2",
            "route:C09TYQC1DEF:2",
            "C09TYQC1DEF",
            "Superproofer event",
        )
        routed = MODULE.route_event(source, table, ROUTER_SOP)
        self.assertEqual(
            routed["relay_route"]["destination_thread_id"],
            "01a02002-6986-7953-ab5a-cc8087476873",
        )
        self.assertEqual(routed["relay_route"]["project"], "superproofer")
        self.assertNotIn(
            "01a0911a-a718-7743-b37e-e785f24f3708",
            json.dumps(routed["relay_route"]),
        )

    def test_route_uses_exact_channel_not_message_text(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        misleading = event(text="<@U0BNFGX2UAX> Godavari Superproofer SFT should not affect routing")
        routed = MODULE.route_event(misleading, table, ROUTER_SOP)
        self.assertEqual(routed["relay_route"]["project"], "heydonna")

    def test_queued_legacy_unmentioned_dev_alert_is_not_routed(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        old_alert = event(text="CI failed", slack_event_type="message.channel")
        old_alert["source_evidence"].pop("explicit_cto_mention", None)
        self.assertIsNone(MODULE.route_event(old_alert, table, ROUTER_SOP))

    def test_queued_legacy_explicit_mention_remains_routable(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        old_mention = event(text="<@U0BNFGX2UAX> please inspect", slack_event_type="message.channel")
        old_mention["source_evidence"].pop("explicit_cto_mention", None)
        self.assertEqual(
            MODULE.route_event(old_mention, table, ROUTER_SOP)["relay_route"]["destination_thread_id"],
            "01a09112-a09c-7361-9a2a-0ada6a4e9dfb",
        )

    def test_queued_legacy_quoted_or_code_mentions_are_not_routed(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        for text in ("> <@U0BNFGX2UAX> old request", "`<@U0BNFGX2UAX>`", "```<@U0BNFGX2UAX>```"):
            queued = event(text=text, slack_event_type="message.channel")
            queued["source_evidence"].pop("explicit_cto_mention", None)
            self.assertIsNone(MODULE.route_event(queued, table, ROUTER_SOP), text)

    def test_current_ingress_attestation_preserves_block_only_mention(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        queued = event(text="", slack_event_type="message.channel")
        queued["source_evidence"]["explicit_cto_mention"] = True
        self.assertIsNotNone(MODULE.route_event(queued, table, ROUTER_SOP))

    def test_legacy_rich_text_user_mention_remains_routable(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        queued = event(text="", slack_event_type="message.channel")
        queued["source_evidence"].pop("explicit_cto_mention", None)
        queued["exact_tuple"]["blocks"] = [{
            "type": "rich_text",
            "elements": [{
                "type": "rich_text_section",
                "elements": [{"type": "user", "user_id": "U0BNFGX2UAX"}],
            }],
        }]
        self.assertIsNotNone(MODULE.route_event(queued, table, ROUTER_SOP))

    def test_current_negative_attestation_overrides_misleading_text(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        queued = event(text="<@U0BNFGX2UAX> but in a quote", slack_event_type="message.channel")
        queued["source_evidence"]["explicit_cto_mention"] = False
        self.assertIsNone(MODULE.route_event(queued, table, ROUTER_SOP))

    def test_missing_machine_route_table_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "WAKE_SOP.md"
            path.write_text("# prose only\n", encoding="utf-8")
            with self.assertRaises(MODULE.SnapshotError):
                MODULE.extract_route_table(path)

    def test_old_route_table_version_fails_closed_during_install(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "WAKE_SOP.md"
            path.write_text(
                '<!-- CTO_SLACK_ROUTE_TABLE_V1\n{"version":1}\nCTO_SLACK_ROUTE_TABLE_END -->',
                encoding="utf-8",
            )
            with self.assertRaises(MODULE.SnapshotError):
                MODULE.extract_route_table(path)

    def test_event_with_unexpected_relay_sop_fails_closed(self) -> None:
        table = MODULE.extract_route_table(ROUTER_SOP)
        source = event()
        source["sop_path"] = "/tmp/wrong-sop.md"
        with self.assertRaises(MODULE.SnapshotError):
            MODULE.route_event(source, table, ROUTER_SOP)

    def test_unknown_schema_fails_closed(self) -> None:
        with self.assertRaises(MODULE.SnapshotError):
            MODULE.extract_events({"version": 1})

    def test_cli_writes_current_schema_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events_path = root / "events.json"
            ack_path = root / "ack.json"
            output_path = root / "snapshot.json"
            heartbeat_path = root / "heartbeat"
            claims_path = root / "claims.json"
            lock_path = root / "relay.lock"
            events_path.write_text(json.dumps({"events": [event()]}), encoding="utf-8")
            ack_path.write_text(json.dumps({"handled": []}), encoding="utf-8")

            original = MODULE.os.sys.argv
            MODULE.os.sys.argv = [
                str(SCRIPT),
                "--events-file",
                str(events_path),
                "--ack-file",
                str(ack_path),
                "--output",
                str(output_path),
                "--heartbeat-file",
                str(heartbeat_path),
                "--claims-file",
                str(claims_path),
                "--lock-file",
                str(lock_path),
                "--route-sop",
                str(ROUTER_SOP),
            ]
            try:
                self.assertEqual(MODULE.main(), 0)
            finally:
                MODULE.os.sys.argv = original

            routed = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(len(routed), 1)
            self.assertEqual(routed[0]["dedup_key"], event()["dedup_key"])
            self.assertEqual(routed[0]["relay_route"]["project"], "heydonna")
            self.assertTrue(heartbeat_path.read_text(encoding="utf-8").strip().endswith("Z"))

    def test_cli_limit_freezes_only_oldest_pending_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events_path = root / "events.json"
            ack_path = root / "ack.json"
            output_path = root / "snapshot.json"
            heartbeat_path = root / "heartbeat"
            claims_path = root / "claims.json"
            lock_path = root / "relay.lock"
            first = event("C0ALZJHGE49:1", "route:C0ALZJHGE49:1", text="unmentioned old alert")
            first["source_evidence"].pop("explicit_cto_mention", None)
            second = event("C0ALZJHGE49:2", "route:C0ALZJHGE49:2", text="<@U0BNFGX2UAX> please inspect")
            events_path.write_text(
                json.dumps({"events": [first, second]}), encoding="utf-8"
            )
            ack_path.write_text(json.dumps({"handled": []}), encoding="utf-8")

            original = MODULE.os.sys.argv
            MODULE.os.sys.argv = [
                str(SCRIPT),
                "--events-file",
                str(events_path),
                "--ack-file",
                str(ack_path),
                "--output",
                str(output_path),
                "--heartbeat-file",
                str(heartbeat_path),
                "--limit",
                "1",
                "--claims-file",
                str(claims_path),
                "--lock-file",
                str(lock_path),
                "--route-sop",
                str(ROUTER_SOP),
            ]
            try:
                self.assertEqual(MODULE.main(), 0)
            finally:
                MODULE.os.sys.argv = original

            routed = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(len(routed), 1)
            self.assertEqual(routed[0]["dedup_key"], second["dedup_key"])
            self.assertEqual(routed[0]["relay_route"]["project"], "heydonna")
            self.assertEqual(json.loads(ack_path.read_text(encoding="utf-8")), {"handled": []})
            self.assertEqual(
                json.loads(events_path.read_text(encoding="utf-8"))["events"],
                [first, second],
            )

    def test_cli_failure_atomically_invalidates_stale_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events_path = root / "events.json"
            ack_path = root / "ack.json"
            output_path = root / "snapshot.json"
            heartbeat_path = root / "heartbeat"
            claims_path = root / "claims.json"
            lock_path = root / "relay.lock"
            missing_sop = root / "missing-sop.md"
            events_path.write_text(json.dumps({"events": [event()]}), encoding="utf-8")
            ack_path.write_text(json.dumps({"handled": []}), encoding="utf-8")
            output_path.write_text(
                json.dumps([{"dedup_key": "stale", "routed_wake_text": "stale"}]),
                encoding="utf-8",
            )

            original = MODULE.os.sys.argv
            MODULE.os.sys.argv = [
                str(SCRIPT),
                "--events-file",
                str(events_path),
                "--ack-file",
                str(ack_path),
                "--output",
                str(output_path),
                "--heartbeat-file",
                str(heartbeat_path),
                "--claims-file",
                str(claims_path),
                "--lock-file",
                str(lock_path),
                "--route-sop",
                str(missing_sop),
            ]
            try:
                self.assertEqual(MODULE.main(), 2)
            finally:
                MODULE.os.sys.argv = original

            self.assertEqual(json.loads(output_path.read_text(encoding="utf-8")), [])
            self.assertFalse(claims_path.exists())


if __name__ == "__main__":
    unittest.main()

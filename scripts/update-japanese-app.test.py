import importlib.util
import os
from pathlib import Path
import stat
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import json
import plistlib
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("japanese_update", Path(__file__).with_name("update-japanese-app.py"))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class JapaneseUpdateSafetyTests(unittest.TestCase):
    def test_prepare_adds_matching_japanese_locale_only_to_the_staged_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "Staged.app"
            source_resources = root / "apps/desktop/node_modules/electron/dist/Electron.app" / update.ELECTRON_MAC_RESOURCES
            target_resources = app / update.ELECTRON_MAC_RESOURCES
            for resources in (source_resources, target_resources):
                resources.mkdir(parents=True)
                (resources / "Info.plist").write_bytes(plistlib.dumps({"CFBundleVersion": "44.4.2"}))
            source = source_resources / "ja.lproj"
            source.mkdir()
            (source / "locale.pak").write_bytes(b"japanese Chromium messages")
            (target_resources / "en.lproj").mkdir()
            (target_resources / "en.lproj/locale.pak").write_bytes(b"retained English locale")
            info = {"CFBundleLocalizations": ["en", "fr"]}
            with patch.object(update, "REPO", root):
                self.assertTrue(update.prepare_japanese_localization(app, info))
                self.assertFalse(update.prepare_japanese_localization(app, info))
            update.validate_japanese_localization(app, info)
            self.assertEqual((target_resources / "ja.lproj/locale.pak").read_bytes(), b"japanese Chromium messages")
            self.assertEqual((target_resources / "en.lproj/locale.pak").read_bytes(), b"retained English locale")
            self.assertEqual(info["CFBundleDevelopmentRegion"], "ja")
            self.assertEqual(info["CFBundleLocalizations"], ["en", "fr", "ja"])
            self.assertEqual((source / "locale.pak").read_bytes(), b"japanese Chromium messages")

    def test_prepare_refuses_a_missing_or_mismatched_electron_locale(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / "Staged.app"
            source_resources = root / "apps/desktop/node_modules/electron/dist/Electron.app" / update.ELECTRON_MAC_RESOURCES
            target_resources = app / update.ELECTRON_MAC_RESOURCES
            target_resources.mkdir(parents=True)
            info = {}
            with patch.object(update, "REPO", root):
                with self.assertRaisesRegex(ValueError, "locale is missing"):
                    update.prepare_japanese_localization(app, info)
                source_resources.mkdir(parents=True)
                (source_resources / "ja.lproj").mkdir()
                (source_resources / "ja.lproj/locale.pak").write_bytes(b"other runtime")
                (source_resources / "Info.plist").write_bytes(plistlib.dumps({"CFBundleVersion": "45.0.0"}))
                (target_resources / "Info.plist").write_bytes(plistlib.dumps({"CFBundleVersion": "44.4.2"}))
                with self.assertRaisesRegex(ValueError, "does not match staged framework"):
                    update.prepare_japanese_localization(app, info)
            self.assertFalse((target_resources / "ja.lproj").exists())
            self.assertEqual(info, {})

    def test_prepared_locale_validation_rejects_missing_chromium_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Staged.app"
            (app / "Contents/Resources/ja.lproj").mkdir(parents=True)
            info = {"CFBundleDevelopmentRegion": "ja", "CFBundleLocalizations": ["ja"]}
            with self.assertRaisesRegex(ValueError, "Chromium locale resources"):
                update.validate_japanese_localization(app, info)

    def test_install_removes_restored_metadata_before_signature_checks(self):
        output = Path("/virtual-update")
        prepared = output / ".install" / f"{update.APP_NAME}.app"
        attributes = set()
        verified = []

        def command(arguments, **kwargs):
            if arguments[:3] == ["ditto", "-x", "-k"]:
                attributes.add(prepared)
            return Mock(stdout="", returncode=0)

        def move(source, destination):
            # The destination can also receive Finder metadata during a Mac bundle move.
            attributes.add(Path(destination))

        def verify(app, expected):
            if app in attributes:
                raise ValueError("resource fork, Finder information, or similar detritus not allowed")
            verified.append(app)

        args = Mock()
        args.output_dir.resolve.return_value = output
        with patch.object(update, "assert_installer_idle"), \
                patch.object(update, "INSTALL_STAGE", output / ".install"), \
                patch.object(update, "validate_identity"), \
                patch.object(Path, "read_text", return_value=json.dumps({"version": "0.0.44-ja.2"})), \
                patch.object(Path, "mkdir"), \
                patch.object(update, "run", side_effect=command), \
                patch.object(update, "move_to_trash"), \
                patch.object(update.shutil, "move", side_effect=move), \
                patch.object(update, "clear_signing_attributes", side_effect=attributes.discard), \
                patch.object(update, "verify", side_effect=verify), \
                patch("builtins.print"):
            update.install(args)
        self.assertEqual(verified, [prepared, update.INSTALLED_APP])

    def test_local_revision_has_numeric_macos_metadata(self):
        release, build = update.numeric_versions("0.0.44-ja.2")
        self.assertEqual(release, "0.0.44")
        self.assertEqual(build, "0.44.2")
        for version in ("0.0.44", "0.0.44-ja.0", "0.0.44-ja.100", "0.1.44-ja.2", "0.0.44-ja.2/../app"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                update.numeric_versions(version)

    def test_changed_server_or_native_runtime_blocks_packaging(self):
        before = {"protectedDigest": "source", "serverDigest": "server", "nativeDigest": "native"}
        after = dict(before, bootstrapIsolated=True)
        update.assert_runtime_preserved(before, after)
        for key in before:
            with self.subTest(key=key), self.assertRaises(ValueError):
                update.assert_runtime_preserved(before, dict(after, **{key: "changed"}))
        with self.assertRaises(ValueError):
            update.assert_runtime_preserved(before, dict(after, bootstrapIsolated=False))

    def test_non_japanese_desktop_bootstrap_is_rejected(self):
        with self.assertRaises(ValueError):
            update.assert_isolated_bootstrap('require("./main.cjs");')
        update.assert_isolated_bootstrap(
            'process.env.T3CODE_HOME="' + update.RUNTIME_PATH + '"; process.env.T3CODE_DISABLE_AUTO_UPDATE="true";'
        )
        with self.assertRaises(ValueError):
            update.assert_isolated_bootstrap(
                'process.env.T3CODE_HOME="' + update.RUNTIME_PATH + '"; process.env.T3CODE_DISABLE_AUTO_UPDATE="false";'
            )

    def test_install_while_running_refuses_before_any_file_operation(self):
        args = Mock()
        with patch.object(update, "run", return_value=Mock(stdout="ASN:0x0-0x123:")), \
                patch.object(update, "move_to_trash") as trash, \
                patch.object(update, "validate_identity") as identity:
            with self.assertRaisesRegex(ValueError, "running app"):
                update.install(args)
            trash.assert_not_called()
            identity.assert_not_called()
            args.output_dir.resolve.assert_not_called()

    def test_install_with_loaded_watcher_refuses_before_any_file_operation(self):
        args = Mock()
        with patch.object(update, "run", return_value=Mock(stdout="")), \
                patch.object(update.subprocess, "run", return_value=Mock(returncode=0)), \
                patch.object(update, "move_to_trash") as trash:
            with self.assertRaisesRegex(ValueError, "launch agent"):
                update.install(args)
            trash.assert_not_called()
            args.output_dir.resolve.assert_not_called()

    def test_signing_cleanup_uses_native_xattr_and_only_known_attributes(self):
        listing = "/some app/Helper.app: com.apple.FinderInfo:\n00 00\n/some app/Info.plist: com.apple.ResourceFork:\n00\n/some app: com.apple.quarantine: preserved\n"
        with patch.object(update, "run", return_value=Mock(stdout=listing)) as command:
            update.clear_signing_attributes(Path("/some app"))
        self.assertEqual([call.args[0] for call in command.call_args_list], [
            ["xattr", "-lr", "/some app"],
            ["xattr", "-d", "com.apple.FinderInfo", "/some app/Helper.app"],
            ["xattr", "-d", "com.apple.ResourceFork", "/some app/Info.plist"],
        ])


def discard(path):
    """Test replacement for move_to_trash: never touch the real ~/.Trash."""
    if path.is_dir():
        update.shutil.rmtree(path)
    elif path.exists():
        path.unlink()


class ServerSwapDigestPolicyTests(unittest.TestCase):
    before = {"protectedDigest": "p", "protectedDigestExServer": "px", "serverDigest": "s", "nativeDigest": "n"}

    def after(self, **changes):
        return dict(self.before, bootstrapIsolated=True, serverEntryPresent=True, **changes)

    def test_default_policy_ignores_the_new_fields_and_still_blocks_server_changes(self):
        update.assert_runtime_preserved(self.before, self.after())
        update.assert_runtime_preserved(self.before, self.after(protectedDigestExServer="other"))
        for key in ("protectedDigest", "serverDigest", "nativeDigest"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                update.assert_runtime_preserved(self.before, self.after(**{key: "changed"}))

    def test_server_replacement_allows_only_the_server_dist_to_change(self):
        replaced = self.after(protectedDigest="p2", serverDigest="s2")
        with self.assertRaises(ValueError):
            update.assert_runtime_preserved(self.before, replaced)
        update.assert_runtime_preserved(self.before, replaced, server_replaced=True)
        for key in ("protectedDigestExServer", "nativeDigest"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                update.assert_runtime_preserved(self.before, dict(replaced, **{key: "changed"}), server_replaced=True)
        with self.assertRaises(ValueError):
            update.assert_runtime_preserved(self.before, dict(replaced, serverEntryPresent=False), server_replaced=True)
        with self.assertRaises(ValueError):
            update.assert_runtime_preserved(self.before, dict(replaced, bootstrapIsolated=False), server_replaced=True)

    def test_latest_json_marks_the_policy_and_pins_the_recorded_server_digest(self):
        recorded = dict(self.before, serverReplaced=True, serverDigestAfter="s2")
        update.assert_runtime_preserved(recorded, self.after(serverDigest="s2", protectedDigest="p2"))
        with self.assertRaisesRegex(ValueError, "serverDigestAfter"):
            update.assert_runtime_preserved(recorded, self.after(serverDigest="tampered"))
        # A latest.json from before this feature has no flag and keeps the strict policy.
        with self.assertRaises(ValueError):
            update.assert_runtime_preserved(self.before, self.after(serverDigest="s2"))

    def test_asar_inspection_reports_a_server_excluded_protected_digest(self):
        for needle in ("protectedDigestExServer", "!name.startsWith('apps/server/dist/')", "serverEntryPresent"):
            self.assertIn(needle, update.ASAR_SCRIPT)
        # The default digest keeps its original inputs.
        self.assertIn("!name.startsWith('apps/server/dist/client/')", update.ASAR_SCRIPT)


class ServerDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.server = Path(self.temp.name) / "apps/server"
        self.dist = self.server / "dist"
        self.dist.mkdir(parents=True)
        (self.server / "package.json").write_text(json.dumps({"name": "t3", "version": "0.0.44"}))
        (self.dist / "bin.mjs").write_text(
            '#!/usr/bin/env node\nimport * as fs from "node:fs";\nimport { x } from "./chunk-1.mjs";\n'
            'const worker = new URL("./worker.mjs", import.meta.url);\n// import { y } from "./not-an-import.mjs"\n')
        (self.dist / "chunk-1.mjs").write_text('import path from "path";\nexport const x = 1;\n')
        (self.dist / "worker.mjs").write_text("export {};\n")

    def test_complete_server_directory_is_accepted(self):
        report = update.validate_server_dir(self.dist)
        self.assertEqual(report, {"packageVersion": "0.0.44", "bareImports": []})

    def test_missing_entry_chunk_or_wrong_metadata_is_refused(self):
        (self.dist / "chunk-1.mjs").unlink()
        with self.assertRaisesRegex(ValueError, "chunk-1.mjs"):
            update.validate_server_dir(self.dist)
        (self.dist / "chunk-1.mjs").write_text("export {};\n")
        (self.server / "package.json").write_text(json.dumps({"name": "other", "version": "1"}))
        with self.assertRaisesRegex(ValueError, "metadata"):
            update.validate_server_dir(self.dist)
        (self.dist / "bin.mjs").unlink()
        with self.assertRaisesRegex(ValueError, "bin.mjs"):
            update.validate_server_dir(self.dist)

    def test_unbundled_packages_must_exist_in_the_packaged_node_modules(self):
        (self.dist / "chunk-1.mjs").write_text('import { Effect } from "effect";\nimport p from "@scope/pkg/sub";\n')
        report = update.validate_server_dir(self.dist)
        self.assertEqual(report["bareImports"], ["@scope/pkg/sub", "effect"])
        update.assert_imports_resolvable(report["bareImports"], {"effect": "1", "@scope/pkg": "1"})
        with self.assertRaisesRegex(ValueError, "effect"):
            update.assert_imports_resolvable(report["bareImports"], {"@scope/pkg": "1"})

    def test_server_replacement_keeps_the_client_owned_by_web_dir(self):
        package = Path(self.temp.name) / "package"
        old = package / "apps/server/dist"
        (old / "client").mkdir(parents=True)
        (old / "client/index.html").write_text("web")
        (old / "bin.mjs").write_text("old")
        (old / "stale-chunk.mjs").write_text("old")
        (self.dist / "client").mkdir()
        (self.dist / "client/index.html").write_text("ignored")
        with patch.object(update, "move_to_trash", side_effect=discard):
            update.replace_server_dist(package, self.dist)
        names = sorted(str(path.relative_to(old)) for path in old.rglob("*") if path.is_file())
        self.assertEqual(names, ["bin.mjs", "chunk-1.mjs", "client/index.html", "worker.mjs"])
        self.assertEqual((old / "client/index.html").read_text(), "web")
        self.assertIn("import", (old / "bin.mjs").read_text())

    def test_version_output_must_match_server_metadata(self):
        self.assertEqual(update.server_version_report("t3 v0.0.44\n", "0.0.44", "0.0.44"), ("0.0.44", True))
        self.assertEqual(update.server_version_report("t3 v0.0.43\n", None, "0.0.44"), ("0.0.43", False))
        for output, package in (("t3 v0.0.44\n", "0.0.43"), ("Error: boom\n", None), ("", None)):
            with self.subTest(output=output), self.assertRaises(ValueError):
                update.server_version_report(output, package, "0.0.44")



class DatabaseBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / "runtime"
        self.userdata = self.runtime / "userdata"
        self.userdata.mkdir(parents=True)
        self.root = Path(self.temp.name) / "backups"
        (self.userdata / "state.sqlite").write_bytes(b"main" * 1000)
        (self.userdata / "state.sqlite-wal").write_bytes(b"wal" * 10)
        (self.userdata / "state.sqlite-shm").write_bytes(b"shm")
        (self.userdata / "settings.json").write_text("{}")
        idle = patch.object(update, "assert_database_idle")
        idle.start()
        self.addCleanup(idle.stop)

    def test_copies_database_with_wal_and_shm_and_records_hashes(self):
        destination = update.backup_database_state(self.runtime, self.root, now="20261006-120000")
        self.assertEqual(destination, self.root / "20261006-120000")
        self.assertEqual(sorted(path.name for path in destination.iterdir()),
                         ["manifest.json", "settings.json", "state.sqlite", "state.sqlite-shm", "state.sqlite-wal"])
        manifest = json.loads((destination / "manifest.json").read_text())
        for name, entry in manifest["files"].items():
            self.assertEqual(entry["bytes"], (self.userdata / name).stat().st_size)
            self.assertEqual(entry["sha256"], update.file_sha256(destination / name))
        # The source stays untouched and a second backup in the same second does not overwrite the first.
        self.assertEqual((self.userdata / "state.sqlite").read_bytes(), b"main" * 1000)
        self.assertNotEqual(update.backup_database_state(self.runtime, self.root, now="20261006-120000"), destination)

    def test_database_without_wal_is_backed_up_alone(self):
        (self.userdata / "state.sqlite-wal").unlink()
        destination = update.backup_database_state(self.runtime, self.root, now="t")
        self.assertFalse((destination / "state.sqlite-wal").exists())
        self.assertTrue((destination / "state.sqlite").is_file())

    def test_missing_database_refuses(self):
        (self.userdata / "state.sqlite").unlink()
        with self.assertRaisesRegex(ValueError, "does not exist"):
            update.backup_database_state(self.runtime, self.root)
        self.assertFalse(self.root.exists())

    def test_bad_copy_refuses_and_discards_the_partial_backup(self):
        def corrupting_copy(source, target):
            Path(target).write_bytes(Path(source).read_bytes()[:-1])
        trashed = []
        with patch.object(update.shutil, "copy2", side_effect=corrupting_copy), \
                patch.object(update, "move_to_trash", side_effect=trashed.append):
            with self.assertRaisesRegex(ValueError, "does not match"):
                update.backup_database_state(self.runtime, self.root, now="t")
        self.assertEqual(trashed, [self.root / "t"])

    def test_source_changing_during_copy_refuses(self):
        real_copy = update.shutil.copy2

        def copy_then_write(source, target):
            real_copy(source, target)
            if Path(source).name == "state.sqlite-shm":
                (self.userdata / "state.sqlite").write_bytes(b"changed" * 1000)
        with patch.object(update.shutil, "copy2", side_effect=copy_then_write), \
                patch.object(update, "move_to_trash"):
            with self.assertRaisesRegex(ValueError, "does not match|changed during"):
                update.backup_database_state(self.runtime, self.root, now="t")

    def test_not_enough_space_refuses(self):
        with patch.object(update.shutil, "disk_usage", return_value=Mock(free=10)):
            with self.assertRaisesRegex(ValueError, "free space"):
                update.backup_database_state(self.runtime, self.root)

    def test_a_process_holding_the_database_is_detected(self):
        patch.stopall()
        with patch.object(update.subprocess, "run", return_value=Mock(stdout="4242\n")):
            with self.assertRaisesRegex(ValueError, "4242"):
                update.assert_database_idle(self.userdata / "state.sqlite")
        with patch.object(update.subprocess, "run", return_value=Mock(stdout="")):
            update.assert_database_idle(self.userdata / "state.sqlite")


class ServerInstallOrderTests(unittest.TestCase):
    def run_install(self, expected, backup_effect=None, idle_effect=None):
        output = Path("/virtual-update")
        events = []
        args = Mock()
        args.output_dir.resolve.return_value = output
        backup = Mock(side_effect=backup_effect or (lambda: Path("/virtual-backup/1")))

        def record(name):
            return lambda *a, **k: events.append(name) or Mock(stdout="", returncode=0)

        def trash(path):
            events.append(("trash", path))
            return Path("/virtual-trash/old.app")
        with patch.object(update, "assert_installer_idle", side_effect=lambda: events.append("idle") or (idle_effect() if idle_effect else None)), \
                patch.object(update, "INSTALL_STAGE", output / ".install"), \
                patch.object(update, "validate_identity"), \
                patch.object(Path, "read_text", return_value=json.dumps(expected)), \
                patch.object(Path, "mkdir"), patch.object(Path, "write_text", record("note")), \
                patch.object(update, "run", side_effect=record("run")), \
                patch.object(update, "move_to_trash", side_effect=trash), \
                patch.object(update, "backup_database_state", side_effect=lambda: events.append("backup") or backup()), \
                patch.object(update.shutil, "move", side_effect=record("move")), \
                patch.object(update, "clear_signing_attributes"), patch.object(update, "verify"), \
                patch("builtins.print"):
            try:
                update.install(args)
            except ValueError:
                events.append("refused")
        return events

    def test_server_swap_backs_up_before_the_installed_bundle_moves(self):
        events = self.run_install({"version": "x", "serverReplaced": True})
        self.assertLess(events.index("backup"), events.index(("trash", update.INSTALLED_APP)))
        self.assertEqual(events[events.index("backup") + 1], "idle")

    def test_failed_backup_stops_before_the_installed_bundle_is_touched(self):
        def fail():
            raise ValueError("disk full")
        events = self.run_install({"version": "x", "serverReplaced": True}, fail)
        self.assertIn("refused", events)
        self.assertNotIn(("trash", update.INSTALLED_APP), events)
        self.assertNotIn("move", events)

    def test_reopened_app_after_backup_refuses_before_bundle_moves(self):
        checks = 0
        def idle():
            nonlocal checks
            checks += 1
            if checks == 3:
                raise ValueError("app reopened during backup")
        events = self.run_install({"version": "x", "serverReplaced": True}, idle_effect=idle)
        self.assertIn("backup", events)
        self.assertIn("refused", events)
        self.assertNotIn(("trash", update.INSTALLED_APP), events)
        self.assertNotIn("move", events)

    def test_default_install_does_not_back_up_or_change_flow(self):
        events = self.run_install({"version": "x"})
        self.assertNotIn("backup", events)
        self.assertIn(("trash", update.INSTALLED_APP), events)


class SnapshotServerCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / "source-runtime"
        userdata = self.runtime / "userdata"
        userdata.mkdir(parents=True)
        self.source = userdata / "state.sqlite"
        self.source_connection = sqlite3.connect(self.source)
        self.addCleanup(self.source_connection.close)
        self.source_connection.execute("PRAGMA journal_mode=WAL")
        self.source_connection.execute("CREATE TABLE fixture_rows(value TEXT)")
        self.source_connection.execute("INSERT INTO fixture_rows VALUES ('committed in WAL')")
        self.source_connection.commit()
        (userdata / "settings.json").write_text('{"continueAfterServerUpdate":true}')
        self.log = self.root / "calls.jsonl"
        self.entry = self.root / "fake-server.py"
        self.entry.write_text(FAKE_SERVER_RUNTIME)

    def check(self, **kwargs):
        with patch.object(update, "move_to_trash", side_effect=discard), \
                patch.dict(os.environ, {"CHECK_LOG_FILE": str(self.log), **kwargs}):
            return update.check_server_entry(Path(sys.executable), self.entry,
                                             scratch_root=self.root, runtime=self.runtime, timeout_seconds=3)

    def test_migrates_a_wal_snapshot_then_starts_an_empty_isolated_server(self):
        before = update.file_sha256(self.source)
        self.assertEqual(self.check(), "t3 v0.0.44\n")
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([call["operation"] for call in calls], ["version", "migration", "serve"])
        self.assertEqual(calls[1]["fixture"], "committed in WAL")
        self.assertEqual(calls[1]["settings"], {"continueAfterServerUpdate": True})
        self.assertFalse(calls[2]["databaseExisted"])
        self.assertNotEqual(calls[1]["t3home"], calls[2]["t3home"])
        for call in calls:
            self.assertNotEqual(call["home"], str(Path.home()))
            self.assertNotEqual(call["t3home"], str(self.runtime))
            self.assertEqual(Path(call["cwd"]).resolve(), Path(call["home"]).resolve())
        self.assertEqual(update.file_sha256(self.source), before)
        self.assertEqual(self.source_connection.execute("SELECT value FROM fixture_rows").fetchone()[0], "committed in WAL")
        self.assertEqual(self.source_connection.execute("SELECT name FROM sqlite_master WHERE name='effect_sql_migrations'").fetchall(), [])
        self.assertFalse(list(self.root.glob("t3-server-check-*")))

    def test_failed_migration_refuses_before_starting_http(self):
        with self.assertRaisesRegex(ValueError, "migration check"):
            self.check(CHECK_FAIL_MIGRATION="1")
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([call["operation"] for call in calls], ["version", "migration"])
        self.assertFalse(list(self.root.glob("t3-server-check-*")))

    def test_http_descriptor_failure_refuses_and_stops_its_spawned_process(self):
        processes = []
        popen = update.subprocess.Popen
        def spawn(*args, **kwargs):
            process = popen(*args, **kwargs)
            if "serve" in args[0]:
                processes.append(process)
            return process
        with patch.object(update.subprocess, "Popen", side_effect=spawn):
            with self.assertRaisesRegex(ValueError, "HTTP descriptor"):
                self.check(CHECK_BAD_HTTP="1")
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(list(self.root.glob("t3-server-check-*")))

    def test_startup_timeout_stops_the_exact_process_it_spawned(self):
        processes = []
        popen = update.subprocess.Popen
        def spawn(*args, **kwargs):
            process = popen(*args, **kwargs)
            if "serve" in args[0]:
                processes.append(process)
            return process
        with patch.object(update, "move_to_trash", side_effect=discard), \
                patch.dict(os.environ, {"CHECK_LOG_FILE": str(self.log), "CHECK_NO_READY": "1"}), \
                patch.object(update.subprocess, "Popen", side_effect=spawn):
            with self.assertRaises(subprocess.TimeoutExpired):
                update.check_server_entry(Path(sys.executable), self.entry, scratch_root=self.root,
                                          runtime=self.runtime, timeout_seconds=0.5)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(list(self.root.glob("t3-server-check-*")))

    def test_timeout_discards_scratch_and_never_touches_source(self):
        before = update.file_sha256(self.source)
        with patch.object(update, "move_to_trash", side_effect=discard), \
                patch.object(update.subprocess, "run", side_effect=subprocess.TimeoutExpired("fake", 3)):
            with self.assertRaises(subprocess.TimeoutExpired):
                update.check_server_entry(Path(sys.executable), self.entry, scratch_root=self.root, runtime=self.runtime)
        self.assertEqual(update.file_sha256(self.source), before)
        self.assertFalse(list(self.root.glob("t3-server-check-*")))

    def test_default_backup_location_is_application_support(self):
        self.assertIn("Application Support", str(update.BACKUP_ROOT))
        self.assertNotIn("Caches", str(update.BACKUP_ROOT))


FAKE_SERVER_RUNTIME = r"""
import http.server, json, os, sqlite3, sys
from pathlib import Path
args = sys.argv[1:]
t3home = Path(os.environ['T3CODE_HOME'])
operation = 'version' if '--version' in args else 'migration' if args[:3] == ['auth', 'session', 'list'] else 'serve'
record = {'operation': operation, 'home': os.environ['HOME'], 't3home': str(t3home), 'cwd': str(Path.cwd())}
if operation == 'migration':
    with sqlite3.connect(t3home / 'userdata/state.sqlite') as database:
        record['fixture'] = database.execute('SELECT value FROM fixture_rows').fetchone()[0]
        record['settings'] = json.loads((t3home / 'userdata/settings.json').read_text())
        if os.environ.get('CHECK_FAIL_MIGRATION') != '1':
            database.execute('CREATE TABLE effect_sql_migrations(id INTEGER)')
            database.execute('INSERT INTO effect_sql_migrations VALUES (1)')
if operation == 'serve':
    record['databaseExisted'] = (t3home / 'userdata/state.sqlite').exists()
with open(os.environ['CHECK_LOG_FILE'], 'a') as log:
    log.write(json.dumps(record) + '\n')
if operation == 'version':
    print('t3 v0.0.44')
elif operation == 'migration':
    if os.environ.get('CHECK_FAIL_MIGRATION') == '1':
        sys.exit(4)
    print('[]')
else:
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({} if os.environ.get('CHECK_BAD_HTTP') == '1' else {'environmentId': 'fixture', 'serverVersion': '0.0.44'}).encode())
    port = int(args[args.index('--port') + 1])
    server = http.server.HTTPServer(('127.0.0.1', port), Handler)
    if os.environ.get('CHECK_NO_READY') != '1':
        print('T3 Code server is ready.', flush=True)
    server.serve_forever()
"""


class InterruptedInstallTests(unittest.TestCase):
    def test_interrupt_during_replacement_restores_the_old_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installed = root / f"{update.APP_NAME}.app"
            installed.mkdir()
            (installed / "identity").write_text("old")
            stage = root / "stage"
            prepared = stage / installed.name
            (root / "latest.json").write_text(json.dumps({"version": "x", "serverReplaced": True}))
            args = Mock(output_dir=root)
            previous = root / "old.app"
            backup = root / "backup"
            backup.mkdir()
            real_move = update.shutil.move
            calls = []
            def trash(path):
                calls.append(path)
                if path == installed and not previous.exists():
                    real_move(str(path), str(previous))
                    return previous
                if path == installed and path.exists():
                    real_move(str(path), str(root / "rejected.app"))
            def extract(*args, **kwargs):
                prepared.mkdir(parents=True)
                (prepared / "identity").write_text("new")
            def verify(path, expected):
                if path == installed:
                    raise KeyboardInterrupt()
            with patch.object(update, "INSTALLED_APP", installed), \
                    patch.object(update, "INSTALL_STAGE", stage), \
                    patch.object(update, "assert_installer_idle"), \
                    patch.object(update, "validate_identity"), patch.object(update, "run", side_effect=extract), \
                    patch.object(update, "move_to_trash", side_effect=trash), \
                    patch.object(update, "backup_database_state", return_value=backup), \
                    patch.object(update, "clear_signing_attributes"), \
                    patch.object(update, "verify", side_effect=verify), patch("builtins.print"):
                with self.assertRaises(KeyboardInterrupt):
                    update.install(args)
            self.assertEqual((installed / "identity").read_text(), "old")
            self.assertEqual((root / "rejected.app/identity").read_text(), "new")
            self.assertFalse(previous.exists())

    def test_trash_keeps_app_extension_and_restores_an_interrupted_move(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "old.app"
            bundle.mkdir()
            (bundle / "identity").write_text("old")
            real_move = update.shutil.move
            def interrupted(source, target):
                real_move(source, target)
                if Path(source) == bundle:
                    raise KeyboardInterrupt()
            with patch.object(Path, "home", return_value=root), \
                    patch.object(update.shutil, "move", side_effect=interrupted):
                with self.assertRaises(KeyboardInterrupt):
                    update.move_to_trash(bundle)
            self.assertTrue(bundle.is_dir())
            self.assertFalse(list((root / ".Trash").iterdir()))
            with patch.object(Path, "home", return_value=root):
                destination = update.move_to_trash(bundle)
            self.assertEqual(destination.suffix, ".app")
            self.assertEqual((destination / "identity").read_text(), "old")


class CommandLineTests(unittest.TestCase):
    def test_install_rejects_prepare_only_server_flags(self):
        with patch.object(sys, "argv", ["x", "--install", "--server-dir", "/tmp/dist"]), \
                patch.object(update, "install") as install, patch("sys.stderr"):
            with self.assertRaises(SystemExit):
                update.main()
            install.assert_not_called()

    def test_check_server_needs_a_server_dir_and_default_prepare_has_no_server_swap(self):
        args = Mock(server_dir=None, check_server=True, version=update.LOCAL_VERSION)
        args.web_dir.resolve.return_value = Path("/virtual-web")
        with patch.object(update, "validate_identity"), patch.object(Path, "is_file", return_value=True):
            with self.assertRaisesRegex(ValueError, "--server-dir"):
                update.prepare(args)

    def test_timeout_is_reported_as_a_refusal_without_a_traceback(self):
        with patch.object(sys, "argv", ["x"]), \
                patch.object(update, "prepare", side_effect=subprocess.TimeoutExpired("fake", 90)), \
                patch("sys.stderr") as stderr:
            self.assertEqual(update.main(), 1)
            self.assertTrue(stderr.write.called)

    def test_help_documents_rollback(self):
        for needle in ("--server-dir", "state.sqlite-wal", "Roll back", "previous-app.txt", "--check-server"):
            self.assertIn(needle, update.ROLLBACK_HELP)


if __name__ == "__main__":
    unittest.main()

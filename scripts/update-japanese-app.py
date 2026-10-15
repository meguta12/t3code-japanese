#!/usr/bin/env python3
"""Prepare the local Japanese app; install the verified ZIP only while it is closed."""

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import selectors
import socket
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request


APP_NAME = "T3 Code 日本語版"
APP_ID = "com.t3tools.T3Code.Japanese"
INSTALLED_APP = Path("/Applications") / f"{APP_NAME}.app"
INSTALL_STAGE = Path.home() / "Library/Caches/T3JapaneseUpdate/.install"
DEFAULT_OUTPUT = Path("/Users/keita/Documents/Codex/2026-10-04/t3-uiux")
RUNTIME_PATH = "Library/Application Support/T3 Code 日本語版/runtime"
REPO = Path(__file__).resolve().parents[1]
LOCAL_VERSION = "0.0.44-ja.2"
SERVER_ENTRY = "apps/server/dist/bin.mjs"  # Launched by the desktop bootstrap (main.cjs backendEntryPath).
BACKUP_ROOT = Path.home() / "Library/Application Support/T3JapaneseUpdate/backups"
DATABASE_FILES = ("state.sqlite", "state.sqlite-wal", "state.sqlite-shm")
BACKUP_FILES = (*DATABASE_FILES, "settings.json")
ELECTRON_MAC_RESOURCES = Path("Contents/Frameworks/Electron Framework.framework/Versions/A/Resources")
SCRATCH_ROOT = Path("/private/tmp")
NODE_BUILTINS = frozenset("""assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel
dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline
repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib""".split())

ROLLBACK_HELP = f"""
server swap (--server-dir) and rollback:
  Without --server-dir the packaged server runtime is never modified (digests must match).
  With --server-dir <apps/server/dist> everything under apps/server/dist except client/ is replaced;
  the client still comes from --web-dir. Only that directory may change: everything else in the archive
  and the native modules must stay identical. latest.json records serverReplaced, serverDigestBefore
  and serverDigestAfter. --check-server migrates a read-only VACUUM INTO snapshot with the packaged
  auth CLI, checks SQLite integrity, then boots an empty isolated server and checks its HTTP descriptor.
  `--install` of such a build first copies state.sqlite (+ -wal/-shm) and settings.json from
  ~/{RUNTIME_PATH}/userdata into
  ~/Library/Application Support/T3JapaneseUpdate/backups/<timestamp>/ (sizes and sha256 verified, manifest.json
  written) and refuses to continue if that fails. The previous app bundle is moved to ~/.Trash.

  Roll back (app closed, launch agent com.keita.t3-always-on paused):
    1. Move "/Applications/{APP_NAME}.app" to the Trash and move the previous bundle from
       ~/.Trash/t3-japanese-{APP_NAME}-<id>.app (its location is also in the backup folder's
       previous-app.txt) back to /Applications/{APP_NAME}.app.
    2. Move ~/{RUNTIME_PATH}/userdata/state.sqlite, state.sqlite-wal and state.sqlite-shm to the Trash
       (a stale -wal/-shm must not be applied to the restored file), then copy the files from the
       backup folder back into that userdata directory (including settings.json).
  Restore both together: a newer server may have migrated the database schema.
"""

ASAR_SCRIPT = r"""
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [modulePath, operation, ...args] = process.argv.slice(1);
const { default: asar } = await import(pathToFileURL(modulePath));
if (operation === 'extract') {
  asar.extractAll(args[0], args[1]);
} else if (operation === 'package') {
  await asar.createPackageWithOptions(args[0], args[1], { unpackDir: 'node_modules' });
} else if (operation === 'inspect') {
  const archive = args[0];
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  const entries = [];
  const server = [];
  const native = [];
  const exServer = [];
  let serverEntryPresent = false;
  for (const entry of asar.listPackage(archive).sort()) {
    const name = entry.slice(1);
    const stat = asar.statFile(archive, name, false);
    if (stat.files) continue;
    const fingerprint = stat.link
      ? ['link', stat.link]
      : ['file', hash(asar.extractFile(archive, name)), Boolean(stat.executable)];
    const row = [name, fingerprint];
    if (name.startsWith('apps/server/') && !name.startsWith('apps/server/dist/client/')) {
      server.push(row);
    }
    if (name.startsWith('node_modules/')) native.push(row);
    if (name === 'apps/server/dist/bin.mjs') serverEntryPresent = true;
    if (name !== 'package.json' && !name.startsWith('apps/server/dist/client/') &&
        !name.startsWith('apps/desktop/dist-electron/')) {
      entries.push(row);
      if (!name.startsWith('apps/server/dist/')) exServer.push(row);
    }
  }
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  const boot = asar.extractFile(archive, 'apps/desktop/dist-electron/boot.cjs').toString();
  const main = asar.extractFile(archive, 'apps/desktop/dist-electron/main.cjs').toString();
  console.log(JSON.stringify({
    protectedDigest: hash(JSON.stringify(entries)),
    protectedDigestExServer: hash(JSON.stringify(exServer)),
    serverEntryPresent,
    serverDigest: hash(JSON.stringify(server)),
    nativeDigest: hash(JSON.stringify(native)),
    integrity: hash(asar.getRawHeader(archive).headerString),
    archiveSha256: hash(await (await import('node:fs/promises')).readFile(archive)),
    version: pkg.version,
    productName: pkg.productName,
    bootstrapIsolated: /process\.env\.T3CODE_DISABLE_AUTO_UPDATE\s*=\s*["']true["']/.test(boot) &&
      boot.includes('T3CODE_HOME') && boot.includes('Library/Application Support/T3 Code 日本語版/runtime') &&
      main.includes('t3code-japanese'),
  }));
} else throw new Error(`Unknown operation: ${operation}`);
"""


def run(arguments, **kwargs):
    return subprocess.run(arguments, check=True, **kwargs)


def read_plist(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        return plistlib.load(stream)


def validate_identity(app):
    info = read_plist(app)
    if info.get("CFBundleIdentifier") != APP_ID:
        raise ValueError(f"Refusing an app with a different bundle identity: {app}")
    return info


def numeric_versions(version):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-ja\.(\d+)", version)
    if not match:
        raise ValueError("Use a local revision such as 0.0.44-ja.2.")
    major, minor, patch, revision = map(int, match.groups())
    # macOS build metadata uses three numeric parts; local patch/revision each fit in two digits.
    if major > 9999 or minor != 0 or patch > 99 or not 1 <= revision <= 99:
        raise ValueError("Local builds require a major.0.patch release and revision 1 through 99.")
    return f"{major}.{minor}.{patch}", f"{major}.{patch}.{revision}"


def assert_isolated_bootstrap(text):
    if (not all(value in text for value in ("process.env.T3CODE_HOME", RUNTIME_PATH))
            or not re.search(r'''process\.env\.T3CODE_DISABLE_AUTO_UPDATE\s*=\s*["']true["']''', text)):
        raise ValueError("Desktop bootstrap must preserve Japanese runtime isolation and disable auto updates.")


def assert_runtime_preserved(before, after, server_replaced=None):
    """Default: the packaged server runtime must be byte-identical. With server_replaced, only
    apps/server/dist may differ; every other protected entry and the native modules must match, and the
    new server digest must equal the one recorded in latest.json (serverDigestAfter) when present."""
    if server_replaced is None:
        server_replaced = bool(before.get("serverReplaced"))
    keys = ("protectedDigestExServer", "nativeDigest") if server_replaced \
        else ("protectedDigest", "serverDigest", "nativeDigest")
    for key in keys:
        if before[key] != after[key]:
            raise ValueError(f"Packaged runtime changed outside the approved client/desktop boundary: {key}")
    if server_replaced:
        if not after.get("serverEntryPresent"):
            raise ValueError(f"The packaged archive has no server entry at {SERVER_ENTRY}.")
        if "serverDigestAfter" in before and before["serverDigestAfter"] != after["serverDigest"]:
            raise ValueError("The packaged server does not match the serverDigestAfter recorded in latest.json.")
    if not after["bootstrapIsolated"]:
        raise ValueError("The packaged desktop bootstrap lost Japanese runtime isolation.")


def validate_server_dir(server):
    """Static checks that a built apps/server/dist can replace the packaged one."""
    entry = server / "bin.mjs"
    if not server.is_dir() or not entry.is_file():
        raise ValueError(f"--server-dir must be a built apps/server/dist containing bin.mjs: {server}")
    metadata = server.parent / "package.json"
    package_version = None
    if server.name == "dist" and metadata.is_file():
        info = json.loads(metadata.read_text())
        if info.get("name") != "t3" or not isinstance(info.get("version"), str):
            raise ValueError(f"{metadata} is not the t3 server package metadata.")
        package_version = info["version"]
    bare = set()
    for module in sorted(server.rglob("*.mjs")):
        relative = module.relative_to(server)
        if relative.parts[0] == "client":
            continue
        text = module.read_text(encoding="utf-8")
        # Bundled documentation comments quote example paths; only code lines count.
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith(("//", "*", "/*")))
        for target in set(re.findall(r"""["'](\.{1,2}/[A-Za-z0-9_.\-/]+\.m?js)["']""", code)):
            resolved = (module.parent / target).resolve()
            if not resolved.is_file() or not resolved.is_relative_to(server.resolve()):
                raise ValueError(f"{relative} references {target}, which is missing from the new server directory.")
        for specifier in re.findall(r"""^(?:import|export)\b[^\n]*?\bfrom\s*["']([^"']+)["']""", text, re.M) + \
                re.findall(r"""^import\s*["']([^"']+)["']""", text, re.M):
            if not specifier.startswith((".", "node:")) and specifier.split("/")[0] not in NODE_BUILTINS:
                bare.add(specifier)
    return {"packageVersion": package_version, "bareImports": sorted(bare)}


def assert_imports_resolvable(bare_imports, dependencies):
    """Unbundled packages can only come from the archive's node_modules (the root package.json deps)."""
    for specifier in bare_imports:
        parts = specifier.split("/")
        package = "/".join(parts[:2] if specifier.startswith("@") else parts[:1])
        if package not in dependencies:
            raise ValueError(f"The new server imports {specifier}, which is not available in the packaged node_modules.")


def replace_server_dist(package, server):
    """Swap everything under apps/server/dist except client/, which --web-dir owns."""
    dist = package / "apps/server/dist"
    for child in sorted(dist.iterdir()):
        if child.name != "client":
            move_to_trash(child)
    for child in sorted(server.iterdir()):
        if child.name == "client":
            continue
        if child.is_dir():
            shutil.copytree(child, dist / child.name, symlinks=True)
        else:
            shutil.copy2(child, dist / child.name)


def server_version_report(output, package_version, build_version):
    """Parse `t3 v<semver>`; it must agree with the server package metadata, and is compared to buildVersion."""
    match = re.fullmatch(r"t3 v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?)", output.strip())
    if not match:
        raise ValueError(f"Unexpected --version output from the new server: {output!r}")
    version = match[1]
    if package_version and package_version != version:
        raise ValueError(f"The new server reports {version} but its package.json says {package_version}.")
    return version, version == build_version


def snapshot_database_for_check(runtime, destination):
    """VACUUM INTO includes committed WAL data while opening the source read-only."""
    source = runtime / "userdata/state.sqlite"
    if not source.is_file():
        raise ValueError(f"Migration check requires an existing database: {source}")
    userdata = destination / "userdata"
    userdata.mkdir(parents=True)
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as database:
        database.execute("VACUUM INTO ?", (str(userdata / "state.sqlite"),))
    settings = runtime / "userdata/settings.json"
    if settings.is_file():
        shutil.copy2(settings, userdata / settings.name)


def check_server_entry(executable, entry, scratch_root=None, runtime=None, timeout_seconds=90):
    """Migrate a populated snapshot without reactors; boot an empty home for HTTP readiness."""
    scratch = Path(tempfile.mkdtemp(prefix="t3-server-check-", dir=scratch_root or SCRATCH_ROOT))
    isolated_home = scratch / "home"
    isolated_home.mkdir()
    migration_home = scratch / "migration"
    health_home = scratch / "health"
    health_home.mkdir()
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("T3CODE_", "VITE_", "OTEL_"))}
    environment.update(HOME=str(isolated_home), T3CODE_DISABLE_AUTO_UPDATE="true",
                       ELECTRON_RUN_AS_NODE="1")
    process = None
    try:
        snapshot_database_for_check(runtime or Path.home() / RUNTIME_PATH, migration_home)
        migration_environment = dict(environment, T3CODE_HOME=str(migration_home))
        version = subprocess.run([str(executable), str(entry), "--version"], env=migration_environment,
                                 cwd=isolated_home, capture_output=True, text=True,
                                 timeout=timeout_seconds, check=False)
        if version.returncode != 0:
            raise ValueError("The new server entry failed its --version smoke check.")
        reported_version, _ = server_version_report(version.stdout, None, None)
        # This CLI uses the same Sqlite persistence/migration layer without starting provider reactors.
        migration = subprocess.run([str(executable), str(entry), "auth", "session", "list",
                                    "--base-dir", str(migration_home), "--json"],
                                   env=migration_environment, cwd=isolated_home, capture_output=True,
                                   text=True, timeout=timeout_seconds, check=False)
        if migration.returncode != 0:
            raise ValueError("The new server failed the database migration check.")
        with closing(sqlite3.connect(migration_home / "userdata/state.sqlite")) as database:
            if database.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError("The migrated database failed SQLite quick_check.")
            if not database.execute("SELECT COUNT(*) FROM effect_sql_migrations").fetchone()[0]:
                raise ValueError("The packaged server did not apply its database migrations.")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        health_environment = dict(environment, T3CODE_HOME=str(health_home))
        process = subprocess.Popen([str(executable), str(entry), "serve", "--base-dir", str(health_home),
                                    "--host", "127.0.0.1", "--port", str(port), "--no-browser"],
                                   env=health_environment, cwd=isolated_home,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + timeout_seconds
        output = b""
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while b"T3 Code server is ready." not in output:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(process.args, timeout_seconds)
                if not selector.select(remaining):
                    raise subprocess.TimeoutExpired(process.args, timeout_seconds)
                chunk = os.read(process.stdout.fileno(), 4096)
                if not chunk:
                    raise ValueError("The new server exited before HTTP readiness.")
                output = (output + chunk)[-16384:]
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=5) as response:
            descriptor = json.load(response)
            if (response.status != 200 or not descriptor.get("environmentId")
                    or descriptor.get("serverVersion") != reported_version):
                raise ValueError("The new server failed its HTTP descriptor check.")
        return version.stdout
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
            process.stdout.close()
        move_to_trash(scratch)


def asar_module():
    candidates = sorted((REPO / "node_modules/.pnpm").glob("@electron+asar@*/node_modules/@electron/asar/lib/asar.js"))
    if not candidates:
        raise ValueError("Install repository dependencies first; @electron/asar is required.")
    return candidates[0]


def asar(operation, *arguments):
    result = run(["node", "--input-type=module", "-e", ASAR_SCRIPT, str(asar_module()), operation,
                  *map(str, arguments)], capture_output=True, text=True)
    return json.loads(result.stdout) if operation == "inspect" else None


def move_to_trash(path):
    """Keep discarded preparation files recoverable; never delete user data."""
    if not path.exists():
        return None
    trash = Path.home() / ".Trash"
    trash.mkdir(exist_ok=True)
    name = (f"t3-japanese-{path.stem}-{time.time_ns()}.app" if path.suffix == ".app"
            else f"t3-japanese-{path.name}-{time.time_ns()}")
    destination = trash / name
    try:
        shutil.move(str(path), str(destination))
    except BaseException:
        if destination.exists() and not path.exists():
            shutil.move(str(destination), str(path))
        raise
    return destination


def clear_signing_attributes(app):
    # Python's os xattr functions are not available on every macOS interpreter.
    attributes = run(["xattr", "-lr", str(app)], capture_output=True, text=True).stdout
    for line in attributes.splitlines():
        match = re.match(r"^(.*): (com\.apple\.(?:FinderInfo|ResourceFork)):", line)
        if match:
            run(["xattr", "-d", match[2], match[1]], capture_output=True, text=True)


def helper_identities(app):
    result = {}
    for file in sorted((app / "Contents/Frameworks").glob("*.app/Contents/Info.plist")):
        with file.open("rb") as stream:
            info = plistlib.load(stream)
        result[str(file.relative_to(app))] = (info.get("CFBundleIdentifier"), info.get("CFBundleExecutable"))
    return result


def prepare_japanese_localization(app, info):
    """Add the matching Electron locale to the staged bundle, never to the installed app."""
    resources = app / ELECTRON_MAC_RESOURCES
    locale = resources / "ja.lproj"
    framework_changed = not (locale / "locale.pak").is_file()
    if framework_changed:
        electron = REPO / "apps/desktop/node_modules/electron/dist/Electron.app"
        source_resources = electron / ELECTRON_MAC_RESOURCES
        source = source_resources / "ja.lproj"
        if not (source / "locale.pak").is_file():
            raise ValueError("Japanese Electron locale is missing. Run `node apps/desktop/scripts/ensure-electron-runtime.mjs` before prepare.")
        with (resources / "Info.plist").open("rb") as stream:
            current_version = plistlib.load(stream).get("CFBundleVersion")
        with (source_resources / "Info.plist").open("rb") as stream:
            source_version = plistlib.load(stream).get("CFBundleVersion")
        if not current_version or source_version != current_version:
            raise ValueError(f"Electron locale version {source_version} does not match staged framework {current_version}.")
        shutil.copytree(source, locale, dirs_exist_ok=True)
    (app / "Contents/Resources/ja.lproj").mkdir(parents=True, exist_ok=True)
    info["CFBundleDevelopmentRegion"] = "ja"
    info["CFBundleLocalizations"] = list(dict.fromkeys([*info.get("CFBundleLocalizations", []), "ja"]))
    return framework_changed


def validate_japanese_localization(app, info):
    if (info.get("CFBundleDevelopmentRegion") != "ja"
            or "ja" not in info.get("CFBundleLocalizations", [])
            or not (app / "Contents/Resources/ja.lproj").is_dir()
            or not (app / ELECTRON_MAC_RESOURCES / "ja.lproj/locale.pak").is_file()):
        raise ValueError("The prepared app is missing Japanese bundle localization or Chromium locale resources.")


def verify(app, expected=None):
    info = validate_identity(app)
    if expected and expected.get("japaneseLocale"):
        validate_japanese_localization(app, info)
    # Electron 44 resolves helpers from CFBundleName before JavaScript can set a display name.
    helper_name = f"{info['CFBundleName']} Helper"
    helper = app / "Contents/Frameworks" / f"{helper_name}.app" / "Contents/MacOS" / helper_name
    if not helper.is_file():
        raise ValueError("CFBundleName no longer resolves the installed Electron helper executable.")
    run(["codesign", "--verify", "--deep", "--strict", str(app)], capture_output=True, text=True)
    archive = app / "Contents/Resources/app.asar"
    snapshot = asar("inspect", archive)
    integrity = info.get("ElectronAsarIntegrity", {}).get("Resources/app.asar", {})
    if integrity != {"algorithm": "SHA256", "hash": snapshot["integrity"]}:
        raise ValueError("The application ASAR integrity header does not match Info.plist.")
    if expected:
        assert_runtime_preserved(expected, snapshot)
        if snapshot["version"] != expected["version"]:
            raise ValueError("The prepared app version does not match latest.json.")
        if snapshot["archiveSha256"] != expected["archiveSha256"]:
            raise ValueError("The prepared archive does not match latest.json.")
    return snapshot


def prepare(args):
    source = INSTALLED_APP
    info = validate_identity(source)
    release, build = numeric_versions(args.version)
    web = args.web_dir.resolve()
    if not (web / "index.html").is_file():
        raise ValueError(f"Build the web client before preparing the app: {web}")
    server = args.server_dir.resolve() if args.server_dir else None
    server_check = validate_server_dir(server) if server else None
    if args.check_server and not server:
        raise ValueError("--check-server requires --server-dir.")
    if args.desktop_dir:
        boot = args.desktop_dir / "boot.cjs"
        assert_isolated_bootstrap(boot.read_text())
        if "t3code-japanese" not in (args.desktop_dir / "main.cjs").read_text():
            raise ValueError("Desktop artifacts must preserve the t3code-japanese Electron userData directory.")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    workspace = output / ".workspace"
    move_to_trash(workspace)
    workspace.mkdir()
    package = workspace / "archive-root"
    stage = workspace / ".staged" / f"{APP_NAME}.app"
    stage.parent.mkdir()
    before = verify(source)
    if not before["bootstrapIsolated"]:
        raise ValueError("The installed app is missing the Japanese runtime isolation bootstrap.")
    identities = helper_identities(source)
    asar("extract", source / "Contents/Resources/app.asar", package)
    metadata = package / "package.json"
    pkg = json.loads(metadata.read_text())
    if server:
        assert_imports_resolvable(server_check["bareImports"], pkg.get("dependencies", {}))
        replace_server_dist(package, server)
    client = package / "apps/server/dist/client"
    move_to_trash(client)
    shutil.copytree(web, client, symlinks=True)
    if args.desktop_dir:
        desktop = package / "apps/desktop/dist-electron"
        move_to_trash(desktop)
        shutil.copytree(args.desktop_dir, desktop, symlinks=True)
    pkg.update(version=args.version, productName=APP_NAME, description="T3 Code Japanese local edition")
    metadata.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")
    archive = workspace / "app.asar"
    asar("package", package, archive)
    after = asar("inspect", archive)
    assert_runtime_preserved(before, after, server_replaced=bool(server))
    expected = dict(after, japaneseLocale=True)
    if server:
        expected.update(serverReplaced=True, serverDigestAfter=after["serverDigest"])
    run(["ditto", "--norsrc", "--noextattr", "--noqtn", str(source), str(stage)])
    resources = stage / "Contents/Resources"
    shutil.copy2(archive, resources / "app.asar")
    unpacked = resources / "app.asar.unpacked"
    move_to_trash(unpacked)
    shutil.copytree(workspace / "app.asar.unpacked", unpacked, symlinks=True)
    framework_changed = prepare_japanese_localization(stage, info)
    # Preserve the internal bundle/executable names together with the untouched helper bundles.
    info.update(CFBundleDisplayName=APP_NAME,
                CFBundleShortVersionString=release, CFBundleVersion=build,
                ElectronAsarIntegrity={"Resources/app.asar": {"algorithm": "SHA256", "hash": after["integrity"]}})
    with (stage / "Contents/Info.plist").open("wb") as stream:
        plistlib.dump(info, stream)
    if helper_identities(stage) != identities:
        raise ValueError("The staged app changed Electron helper identities.")
    entitlements = run(["codesign", "-d", "--entitlements", ":-", str(source)], capture_output=True).stdout
    permissions = plistlib.loads(entitlements)
    if permissions.get("com.apple.security.cs.allow-jit") is not True:
        raise ValueError("The installed app is missing its required JIT entitlement.")
    entitlements_path = workspace / "entitlements.plist"
    entitlements_path.write_bytes(entitlements)
    clear_signing_attributes(stage)
    if framework_changed:
        run(["codesign", "--force", "--sign", "-", "--timestamp=none",
             str(stage / "Contents/Frameworks/Electron Framework.framework")], capture_output=True, text=True)
    run(["codesign", "--force", "--sign", "-", "--entitlements", str(entitlements_path),
         "--timestamp=none", str(stage)], capture_output=True, text=True)
    verified = verify(stage, expected)
    server_report = {}
    if server:
        server_report = dict(serverReplaced=True, serverDigestBefore=before["serverDigest"],
                             serverDigestAfter=after["serverDigest"], serverSource=str(server),
                             serverPackageVersion=server_check["packageVersion"], serverSmokeChecked=False)
        if args.check_server:
            # Run the bytes that will ship: re-extract the packaged archive, then run it with the app's own runtime.
            shipped = workspace / "shipped-archive"
            asar("extract", stage / "Contents/Resources/app.asar", shipped)
            executable = stage / "Contents/MacOS" / info["CFBundleExecutable"]
            smoke_output = check_server_entry(executable, shipped / SERVER_ENTRY)
            version, matches = server_version_report(smoke_output, server_check["packageVersion"], pkg.get("buildVersion"))
            server_report.update(serverSmokeChecked=True, serverMigrationChecked=True, serverStartupChecked=True,
                                 serverVersion=version, serverVersionMatchesBuild=matches)
            if not matches:
                print(f"Warning: the new server reports {version} but the app's buildVersion is "
                      f"{pkg.get('buildVersion')}.", file=sys.stderr)
    temporary_zip = output / ".latest.next.zip"
    move_to_trash(temporary_zip)
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(stage), str(temporary_zip)])
    run(["unzip", "-tq", str(temporary_zip)], capture_output=True, text=True)
    os.replace(temporary_zip, output / "latest.zip")
    report = dict(verified, appName=APP_NAME, bundleId=APP_ID, installPath=str(INSTALLED_APP),
                  shortVersion=release, bundleVersion=build, codesignVerified=True,
                  helperIdentitiesPreserved=True, japaneseLocale=True,
                  serverRuntimePreserved=not server, nativeModulesPreserved=True,
                  **server_report, archive=str(output / "latest.zip"), builtAt=time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    (output / "latest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    move_to_trash(stage)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def assert_app_closed():
    result = run(["/usr/bin/lsappinfo", "find", f"bundleID={APP_ID}"], capture_output=True, text=True)
    if result.stdout.strip():
        raise ValueError("Close T3 Code 日本語版 before installing. The running app and its sessions were not changed.")


def assert_installer_idle():
    assert_app_closed()
    # The launch agent can reopen the app between the idle check and the bundle swap.
    watcher = subprocess.run(
        ["launchctl", "print", f"gui/{os.getuid()}/com.keita.t3-always-on"],
        capture_output=True, text=True, check=False,
    )
    if watcher.returncode == 0:
        raise ValueError("Pause the com.keita.t3-always-on launch agent before installing; it could reopen the app during replacement.")


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def assert_database_idle(database):
    """With the app closed nothing should hold the database; lsof catches a stray server process."""
    try:
        holders = subprocess.run(["/usr/sbin/lsof", "-t", str(database)], capture_output=True, text=True,
                                 check=False).stdout.strip()
    except FileNotFoundError:
        return
    if holders:
        raise ValueError(f"A process still has {database.name} open (pid {holders.split()[0]}); close it before the backup.")


def backup_database_state(runtime=None, backup_root=None, now=None):
    """Copy state.sqlite with its -wal/-shm siblings (only consistent while closed); verify size and sha256."""
    userdata = (runtime or Path.home() / RUNTIME_PATH) / "userdata"
    database = userdata / DATABASE_FILES[0]
    if not database.is_file():
        raise ValueError(f"Refusing to swap the server without a database backup: {database} does not exist.")
    assert_database_idle(database)
    sources = [userdata / name for name in BACKUP_FILES if (userdata / name).is_file()]
    root = backup_root or BACKUP_ROOT
    root.mkdir(parents=True, exist_ok=True)
    needed = sum(source.stat().st_size for source in sources)
    if shutil.disk_usage(root).free < needed * 1.1 + (256 << 20):
        raise ValueError(f"Not enough free space in {root} to back up {needed} bytes of database state.")
    destination = root / (now or time.strftime("%Y%m%d-%H%M%S"))
    suffix = 1
    while destination.exists():
        suffix += 1
        destination = root / f"{now or time.strftime('%Y%m%d-%H%M%S')}-{suffix}"
    destination.mkdir()
    try:
        files = {}
        for source in sources:
            target = destination / source.name
            shutil.copy2(source, target)
            digest = file_sha256(source)
            if target.stat().st_size != source.stat().st_size or file_sha256(target) != digest:
                raise ValueError(f"The backup of {source.name} does not match its source.")
            files[source.name] = {"bytes": target.stat().st_size, "sha256": digest}
        # The source must not have changed while it was being copied.
        for source in sources:
            if source.stat().st_size != files[source.name]["bytes"] or file_sha256(source) != files[source.name]["sha256"]:
                raise ValueError(f"{source.name} changed during the backup; is something still writing to it?")
        (destination / "manifest.json").write_text(json.dumps(
            {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": str(userdata), "files": files},
            ensure_ascii=False, indent=2) + "\n")
    except BaseException:
        move_to_trash(destination)
        raise
    return destination


def install(args):
    # A check before any mutation protects the session that may be running this command.
    assert_installer_idle()
    output = args.output_dir.resolve()
    expected = json.loads((output / "latest.json").read_text())
    validate_identity(INSTALLED_APP)
    staging = INSTALL_STAGE
    move_to_trash(staging)
    staging.mkdir(parents=True)
    run(["ditto", "-x", "-k", "--norsrc", "--noextattr", "--noqtn", str(output / "latest.zip"), str(staging)])
    prepared = staging / f"{APP_NAME}.app"
    # ditto restores ZIP resource metadata; FinderInfo is not part of the signed content.
    clear_signing_attributes(prepared)
    verify(prepared, expected)
    assert_installer_idle()
    database_backup = None
    if expected.get("serverReplaced"):
        # Any failure here stops the install before the installed bundle is touched.
        database_backup = backup_database_state()
        print(f"Database state backed up to {database_backup}")
    # Backups can take time: the app or its watcher may have restarted meanwhile.
    assert_installer_idle()
    backup = None
    try:
        backup = move_to_trash(INSTALLED_APP)
        if database_backup and backup:
            (database_backup / "previous-app.txt").write_text(f"{backup}\n")
        shutil.move(str(prepared), str(INSTALLED_APP))
        clear_signing_attributes(INSTALLED_APP)
        verify(INSTALLED_APP, expected)
    except BaseException:
        if backup:
            move_to_trash(INSTALLED_APP)
            shutil.move(str(backup), str(INSTALLED_APP))
        raise
    print(f"Installed {expected['version']} at {INSTALLED_APP}. Previous app is recoverable at {backup}.")
    if database_backup:
        print(f"Server was replaced. To roll back, restore the previous app and the files in {database_backup} "
              "(see --help).")
    print("Application data was not moved. Launch the fixed application path when ready.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=ROLLBACK_HELP,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default=LOCAL_VERSION)
    parser.add_argument("--web-dir", type=Path, default=REPO / "apps/web/dist")
    parser.add_argument("--desktop-dir", type=Path, help="Optional built Japanese desktop artifacts; server is never rebuilt.")
    parser.add_argument("--server-dir", type=Path,
                        help="Opt in to replacing the server bundle: a built apps/server/dist (its client/ is ignored).")
    parser.add_argument("--check-server", action="store_true",
                        help="With --server-dir: migrate a VACUUM INTO snapshot and check an isolated server HTTP startup.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--install", action="store_true", help="Install existing latest.zip; refuses while the app is running.")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This local Japanese macOS update helper requires macOS.")
    if args.install and (args.server_dir or args.check_server):
        parser.error("--server-dir/--check-server belong to prepare; install reads latest.json.")
    try:
        install(args) if args.install else prepare(args)
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError, KeyboardInterrupt) as error:
        print(f"Update refused: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

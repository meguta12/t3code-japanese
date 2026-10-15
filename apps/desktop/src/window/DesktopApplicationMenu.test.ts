import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const electronDialogService = {
  pickFolder: () => Effect.succeedNone,
  pickFiles: () => Effect.succeed([]),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialog["Service"];

const desktopUpdatesService = {
  getState: Effect.die("unexpected getState"),
  isActionActive: Effect.succeed(false),
  isInstallActive: Effect.succeed(false),
  subscribe: Effect.die("unexpected subscribe"),
  emitState: Effect.void,
  disabledReason: Effect.succeedNone,
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
  installPrepared: () => Effect.die("unexpected installPrepared"),
} satisfies DesktopUpdates.DesktopUpdates["Service"];

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.succeed({} as Electron.BrowserWindow),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeedNone,
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
  options: {
    platform?: DesktopEnvironment.MakeDesktopEnvironmentInput["platform"];
    updates?: Partial<DesktopUpdates.DesktopUpdates["Service"]>;
    showMessageBox?: ElectronDialog.ElectronDialog["Service"]["showMessageBox"];
  } = {},
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
        Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
        Layer.provideMerge(
          Layer.succeed(DesktopUpdates.DesktopUpdates, {
            ...desktopUpdatesService,
            ...options.updates,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ElectronDialog.ElectronDialog, {
            ...electronDialogService,
            showMessageBox: options.showMessageBox ?? electronDialogService.showMessageBox,
          }),
        ),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(
          DesktopEnvironment.layer({
            ...environmentInput,
            platform: options.platform ?? environmentInput.platform,
          }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
        ),
      ),
    ),
  );

describe("DesktopApplicationMenu", () => {
  it.effect("retains macOS window actions with explicit Japanese submenu labels", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      yield* configureMenu(selectedAction, applicationMenuTemplate, { platform: "darwin" });
      const template = yield* Deferred.await(applicationMenuTemplate);
      const windowMenu = template.find((item) => item.role === "windowMenu");
      assert.isDefined(windowMenu);
      assert.equal(windowMenu.label, "ウィンドウ");
      assert.deepEqual(windowMenu.submenu, [
        { label: "しまう", role: "minimize" },
        { label: "拡大／縮小", role: "zoom" },
        { type: "separator" },
        { label: "すべてを手前に移動", role: "front" },
      ]);
    }),
  );

  for (const scenario of [
    "latest",
    "error",
    "unknown-error",
    "disabled",
    "disabled-setting",
  ] as const) {
    it.effect(`shows Japanese update dialogs while preserving ${scenario} diagnostic values`, () =>
      Effect.gen(function* () {
        const selectedAction = yield* Deferred.make<string>();
        const applicationMenuTemplate =
          yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
        const dialog = yield* Deferred.make<Electron.MessageBoxOptions>();
        const diagnostic =
          scenario === "disabled-setting"
            ? "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting."
            : "Done and Copy Path: /tmp/Copy Image.txt";
        const state = {
          ...createInitialDesktopUpdateState(
            "Done",
            {
              hostArch: "arm64",
              appArch: "arm64",
              runningUnderArm64Translation: false,
            },
            "latest",
          ),
          status: scenario === "latest" ? ("up-to-date" as const) : ("error" as const),
          message: scenario === "unknown-error" ? null : diagnostic,
        };
        yield* configureMenu(selectedAction, applicationMenuTemplate, {
          platform: "darwin",
          updates: {
            disabledReason: Effect.succeed(
              scenario.startsWith("disabled") ? Option.some(diagnostic) : Option.none(),
            ),
            check: () => Effect.succeed({ checked: true, state }),
          },
          showMessageBox: (options) =>
            Deferred.succeed(dialog, options).pipe(
              Effect.as({ response: 0, checkboxChecked: false }),
            ),
        });
        const template = yield* Deferred.await(applicationMenuTemplate);
        const appMenu = template[0];
        if (!Array.isArray(appMenu?.submenu)) throw new Error("Missing application menu");
        const checkUpdates = appMenu.submenu.find((item) => item.label === "更新を確認…");
        if (typeof checkUpdates?.click !== "function") throw new Error("Missing update action");
        checkUpdates.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
        const shown = yield* Deferred.await(dialog);
        if (scenario === "latest") {
          assert.equal(shown.title, "最新版です");
          assert.equal(shown.message, "T3 Code Done は現在の最新版です。");
        } else if (scenario.startsWith("disabled")) {
          assert.equal(shown.title, "更新を利用できません");
          assert.equal(shown.message, "現在、自動更新を利用できません。");
          assert.equal(
            shown.detail,
            scenario === "disabled-setting"
              ? "T3CODE_DISABLE_AUTO_UPDATEの設定により、自動更新は無効になっています。"
              : diagnostic,
          );
        } else {
          assert.equal(shown.title, "更新の確認に失敗しました");
          assert.equal(shown.message, "更新を確認できませんでした。");
          assert.equal(
            shown.detail,
            scenario === "unknown-error"
              ? "不明なエラーが発生しました。しばらくしてからもう一度お試しください。"
              : diagnostic,
          );
        }
      }),
    );
  }

  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "ファイル");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "設定…");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("owns Paste as Text and routes it through the renderer", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "編集");
      assert.isDefined(editMenu);
      if (!Array.isArray(editMenu.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "書式なしで貼り付け");
      assert.isDefined(pasteAsTextItem);
      assert.equal(pasteAsTextItem.accelerator, "CmdOrCtrl+Shift+V");
      if (typeof pasteAsTextItem.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {} as KeyboardEvent,
      );
      assert.equal(yield* Deferred.await(selectedAction), "paste-as-text");
    }),
  );

  // Chromium pastes as plain text for the accelerator on its own. Dispatching
  // the action as well injects a second paste, which doubles the pasted text.
  it.effect("leaves the accelerator to Chromium instead of injecting a paste", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "編集");
      if (!Array.isArray(editMenu?.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "書式なしで貼り付け");
      if (typeof pasteAsTextItem?.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {
          triggeredByAccelerator: true,
        } as unknown as KeyboardEvent,
      );
      assert.isFalse(yield* Deferred.isDone(selectedAction));
    }),
  );

  // Zoom must route through DesktopWindow.zoomMain instead of the Electron
  // zoom roles: the roles zoom whichever webContents has focus, which breaks
  // app zoom while an embedded preview WebContentsView holds focus.
  it.effect("routes View menu zoom to the main window instead of zoom roles", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "表示");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) => item.role?.toLowerCase().includes("zoom")),
      );

      const zoomIn = viewMenu.submenu.find((item) => item.label === "拡大");
      assert.isDefined(zoomIn);
      assert.equal(zoomIn.accelerator, "CmdOrCtrl+=");
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );
});

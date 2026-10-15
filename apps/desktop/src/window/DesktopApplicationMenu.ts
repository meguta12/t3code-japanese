import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const updateDisabledReasonLabels = new Map([
  [
    "Automatic updates are not available because no update feed is configured.",
    "更新の配信先が設定されていないため、自動更新を利用できません。",
  ],
  [
    "Automatic updates are only available in packaged production builds.",
    "自動更新は配布用にパッケージ化されたアプリでのみ利用できます。",
  ],
  [
    "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.",
    "T3CODE_DISABLE_AUTO_UPDATEの設定により、自動更新は無効になっています。",
  ],
  [
    "Automatic updates on Linux require the AppImage or the .deb package.",
    "Linuxで自動更新するには、AppImageまたは.debパッケージが必要です。",
  ],
]);

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "最新版です",
      message: `T3 Code ${updateState.currentVersion} は現在の最新版です。`,
      buttons: ["OK"],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "更新の確認に失敗しました",
      message: "更新を確認できませんでした。",
      detail:
        updateState.message ??
        "不明なエラーが発生しました。しばらくしてからもう一度お試しください。",
      buttons: ["OK"],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updates.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "更新を利用できません",
      message: "現在、自動更新を利用できません。",
      detail: updateDisabledReasonLabels.get(disabledReason.value) ?? disabledReason.value,
      buttons: ["OK"],
    });
    return;
  }

  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.ensureMain;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    // Chromium already pastes as plain text for this chord, so the accelerator
    // needs nothing from the menu: the composer and the terminal each arm
    // themselves from the same keydown. Routing it through the renderer anyway
    // lands a second, injected paste and doubles the text. Only a menu click,
    // which produces no keystroke for them to see, needs that round trip.
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) return;
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { label: "このアプリについて", role: "about" },
          {
            label: "更新を確認…",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "設定…",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { label: "サービス", role: "services" },
          { type: "separator" },
          { label: "T3 Code 日本語版を非表示", role: "hide" },
          { label: "ほかを非表示", role: "hideOthers" },
          { label: "すべて表示", role: "unhide" },
          { type: "separator" },
          { label: "T3 Code 日本語版を終了", role: "quit" },
        ],
      });
    }

    template.push(
      {
        label: "ファイル",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "設定…",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          { label: "閉じる", role: environment.platform === "darwin" ? "close" : "quit" },
        ],
      },
      {
        label: "編集",
        submenu: [
          { label: "元に戻す", role: "undo" },
          { label: "やり直す", role: "redo" },
          { type: "separator" },
          { label: "切り取り", role: "cut" },
          { label: "コピー", role: "copy" },
          { label: "貼り付け", role: "paste" },
          {
            label: "書式なしで貼り付け",
            accelerator: "CmdOrCtrl+Shift+V",
            click: pasteAsTextClick,
          },
          { label: "削除", role: "delete" },
          { type: "separator" },
          { label: "すべて選択", role: "selectAll" },
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                {
                  label: "読み上げ",
                  submenu: [
                    { label: "読み上げを開始", role: "startSpeaking" as const },
                    { label: "読み上げを停止", role: "stopSpeaking" as const },
                  ],
                },
              ]
            : []),
        ],
      },
      {
        label: "表示",
        submenu: [
          { label: "再読み込み", role: "reload" },
          { label: "キャッシュを使わず再読み込み", role: "forceReload" },
          { label: "開発者ツール", role: "toggleDevTools" },
          { type: "separator" },
          /*
            Not the zoom roles: those act on the focused webContents, so with
            an embedded preview WebContentsView focused they zoom the guest
            page and the app UI appears stuck. These always zoom the main
            window (see DesktopWindow.zoomMain).
          */
          { label: "実際のサイズ", accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: "拡大", accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: "拡大",
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          { label: "縮小", accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          { type: "separator" },
          { label: "全画面表示", role: "togglefullscreen" },
        ],
      },
      {
        label: "ウィンドウ",
        role: "windowMenu",
        ...(environment.platform === "darwin"
          ? {
              submenu: [
                { label: "しまう", role: "minimize" as const },
                { label: "拡大／縮小", role: "zoom" as const },
                { type: "separator" as const },
                { label: "すべてを手前に移動", role: "front" as const },
              ],
            }
          : {}),
      },
      {
        label: "ヘルプ",
        role: "help",
        submenu: [
          {
            label: "更新を確認…",
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);

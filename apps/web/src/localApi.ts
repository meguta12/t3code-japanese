import type { ConfirmDialogOptions, ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";
import { ja } from "./lib/ja";

let cachedApi: LocalApi | undefined;

/** Keep authored values and already formatted labels out of the menu host's translation. */
export function withVerbatimContextMenuLabel<T extends string>(item: ContextMenuItem<T>) {
  return { ...item, verbatimLabel: true };
}

function translateContextMenuItems<T extends string>(items: readonly ContextMenuItem<T>[]) {
  return items.map((item): ContextMenuItem<T> => {
    // This is display-only metadata; neither IPC nor the fallback needs it.
    const { verbatimLabel, ...menuItem } = item as ContextMenuItem<T> & {
      verbatimLabel?: boolean;
    };
    return {
      ...menuItem,
      label: verbatimLabel ? item.label : ja(item.label),
      ...(item.children ? { children: translateContextMenuItems(item.children) } : {}),
    };
  });
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
    },
    shell: {
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
      // Only the desktop shell can reach the OS; the web build (and older
      // desktop shells that predate this method) have nothing to open.
      openSystemSettings: async (pane) => {
        if (!window.desktopBridge?.openSystemSettings) {
          throw new Error("Unable to open System Settings.");
        }
        const opened = await window.desktopBridge.openSystemSettings(pane);
        if (!opened) {
          throw new Error("Unable to open System Settings.");
        }
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        const translatedItems = translateContextMenuItems(items);
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(
            translatedItems,
            position,
          ) as Promise<T | null>;
        }
        return showContextMenuFallback(translatedItems, position);
      },
      // A native desktop menu blocks keyboard input and closes on outside
      // interaction, so nothing to do there; the DOM fallback needs an explicit
      // dismiss when the state behind it goes away.
      close: async () => {
        if (!window.desktopBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

import { createContext, useContext } from "react";

/**
 * Actions on the sidebar's current thread selection. Kept apart from the
 * implementation so rows can read the context without pulling in thread commands.
 */
export interface ThreadSelectionActions {
  showSelectionMenu: (position: { x: number; y: number }) => Promise<void>;
  completeSelected: () => Promise<void>;
  reopenSelected: () => Promise<void>;
  archiveSelected: () => Promise<void>;
}

const ThreadSelectionActionsContext = createContext<ThreadSelectionActions | null>(null);
export const ThreadSelectionActionsProvider = ThreadSelectionActionsContext.Provider;

/** Null outside the folder-view sidebar, where selection has no shared actions. */
export function useOptionalThreadSelectionActions(): ThreadSelectionActions | null {
  return useContext(ThreadSelectionActionsContext);
}

export function useThreadSelectionActions(): ThreadSelectionActions {
  const actions = useContext(ThreadSelectionActionsContext);
  if (actions === null) {
    throw new Error("useThreadSelectionActions requires ThreadSelectionActionsProvider");
  }
  return actions;
}

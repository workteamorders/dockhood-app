'use client';

import { create } from 'zustand';

export type FinderView = 'grid' | 'list';

export type FinderFlags = {
  view: FinderView;
  busy: boolean;
  canBack: boolean;
  canForward: boolean;
  canCreate: boolean;
  canImport: boolean;
  canPaste: boolean;
  canCopy: boolean;
  canRename: boolean;
  canTrash: boolean;
  canRestore: boolean;
  canDelete: boolean;
  canEmptyTrash: boolean;
  canSelectAll: boolean;
  trashView: boolean;
  selectionCount: number;
  trashCount: number;
};

export type FinderActions = {
  newFolder: () => void;
  importFiles: () => void;
  copy: () => void;
  paste: () => void;
  trash: () => void;
  restore: () => void;
  deleteForever: () => void;
  emptyTrash: () => void;
  rename: () => void;
  selectAll: () => void;
  search: () => void;
  setView: (view: FinderView) => void;
  back: () => void;
  forward: () => void;
};

const EMPTY_FLAGS: FinderFlags = {
  view: 'grid',
  busy: false,
  canBack: false,
  canForward: false,
  canCreate: false,
  canImport: false,
  canPaste: false,
  canCopy: false,
  canRename: false,
  canTrash: false,
  canRestore: false,
  canDelete: false,
  canEmptyTrash: false,
  canSelectAll: false,
  trashView: false,
  selectionCount: 0,
  trashCount: 0,
};

/** Menu-bar commands for the focused Finder window. */
export const finderCommands: { current: FinderActions | null } = { current: null };

type FinderUiStore = {
  flags: FinderFlags;
  setFlags: (flags: FinderFlags) => void;
  clear: () => void;
};

export const useFinderUi = create<FinderUiStore>((set) => ({
  flags: EMPTY_FLAGS,
  setFlags: (flags) => set({ flags }),
  clear: () => set({ flags: EMPTY_FLAGS }),
}));

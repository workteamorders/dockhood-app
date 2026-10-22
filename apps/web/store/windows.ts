import { create } from 'zustand';
import type { AppId } from '@/components/apps/meta';
import { track } from '@/lib/analytics';

export type WindowState = {
  id: string;
  appId: AppId;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  /** App-specific payload, e.g. a token address for Token Detail. */
  props?: Record<string, string>;
};

export type OpenRequest = {
  appId: AppId;
  title: string;
  w: number;
  h: number;
  /** Windows with the same key are focused instead of opened twice. Defaults to appId. */
  key?: string;
  props?: Record<string, string>;
};

type WindowStore = {
  windows: WindowState[];
  activeId: string | null;
  topZ: number;
  open: (req: OpenRequest) => string;
  close: (id: string) => void;
  closeAll: () => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  toggleMaximize: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  /** e.g. Minesweeper fitting its window to the board; clamped to the screen and kept on it. */
  resize: (id: string, w: number, h: number) => void;
  /** e.g. a Token Detail opened from a link learns its ticker after loading. */
  rename: (id: string, title: string) => void;
  /** Taskbar button: restore if minimized, minimize if active, else focus. */
  toggleFromTaskbar: (id: string) => void;
};

const CASCADE = 24;

function viewport() {
  if (typeof window === 'undefined') return { vw: 1280, vh: 800 };
  const workspace = document.querySelector('[data-workspace]')?.getBoundingClientRect();
  return { vw: workspace?.width ?? window.innerWidth, vh: workspace?.height ?? window.innerHeight - 132 };
}

function topVisible(windows: WindowState[], exclude?: string): string | null {
  let best: WindowState | null = null;
  for (const w of windows) {
    if (w.id === exclude || w.minimized) continue;
    if (!best || w.z > best.z) best = w;
  }
  return best?.id ?? null;
}

export const useWindows = create<WindowStore>((set, get) => ({
  windows: [],
  activeId: null,
  topZ: 10,

  open: ({ appId, title, w, h, key, props }) => {
    const id = key ?? appId;
    const existing = get().windows.find((win) => win.id === id);
    if (existing) {
      set((s) => ({
        windows: s.windows.map((win) =>
          win.id === id ? { ...win, minimized: false, z: s.topZ + 1, props: props ?? win.props } : win,
        ),
        activeId: id,
        topZ: s.topZ + 1,
      }));
      return id;
    }

    track('app_opened', { app: appId });
    const { vw, vh } = viewport();
    const width = Math.min(w, vw - 8);
    const height = Math.min(h, vh - 8);
    const n = get().windows.length % 6;
    const x = Math.max(4, Math.min(vw - width - 4, Math.round((vw - width) / 2) + n * CASCADE));
    const y = Math.max(4, Math.min(vh - height - 4, Math.round((vh - height) / 2) + n * CASCADE));

    set((s) => ({
      windows: [
        ...s.windows,
        { id, appId, title, x, y, w: width, h: height, z: s.topZ + 1, minimized: false, maximized: false, props },
      ],
      activeId: id,
      topZ: s.topZ + 1,
    }));
    return id;
  },

  close: (id) =>
    set((s) => {
      const windows = s.windows.filter((w) => w.id !== id);
      return { windows, activeId: s.activeId === id ? topVisible(windows) : s.activeId };
    }),

  closeAll: () => set({ windows: [], activeId: null }),

  focus: (id) =>
    set((s) => {
      if (s.activeId === id) return s;
      return {
        windows: s.windows.map((w) => (w.id === id ? { ...w, z: s.topZ + 1, minimized: false } : w)),
        activeId: id,
        topZ: s.topZ + 1,
      };
    }),

  minimize: (id) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
      activeId: s.activeId === id ? topVisible(s.windows, id) : s.activeId,
    })),

  toggleMaximize: (id) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)),
    })),

  move: (id, x, y) =>
    set((s) => ({ windows: s.windows.map((w) => (w.id === id ? { ...w, x, y } : w)) })),

  resize: (id, w, h) =>
    set((s) => {
      const win = s.windows.find((x) => x.id === id);
      if (!win) return s;
      const { vw, vh } = viewport();
      const width = Math.round(Math.min(w, vw - 8));
      const height = Math.round(Math.min(h, vh - 8));
      const x = Math.max(4, Math.min(win.x, vw - width - 4));
      const y = Math.max(4, Math.min(win.y, vh - height - 4));
      if (width === win.w && height === win.h && x === win.x && y === win.y) return s;
      return { windows: s.windows.map((v) => (v.id === id ? { ...v, x, y, w: width, h: height } : v)) };
    }),

  rename: (id, title) =>
    set((s) => (s.windows.some((w) => w.id === id && w.title !== title) ? { windows: s.windows.map((w) => (w.id === id ? { ...w, title } : w)) } : s)),

  toggleFromTaskbar: (id) => {
    const { windows, activeId, minimize, focus } = get();
    const win = windows.find((w) => w.id === id);
    if (!win) return;
    if (!win.minimized && activeId === id) minimize(id);
    else focus(id);
  },
}));

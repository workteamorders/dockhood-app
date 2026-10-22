'use client';

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { StatusBar } from '@/components/xp/Controls';
import { Dialog } from '@/components/xp/Dialog';
import { Button } from '@/components/xp/Button';
import {
  FINDER_TOTAL_LIMIT,
  finderPath,
  isProtected,
  isTrashed,
  type FinderNode,
} from '@/lib/finderFiles';
import { useFinderFiles } from '@/store/finder';
import { finderCommands, useFinderUi, type FinderActions, type FinderFlags, type FinderView } from '@/store/finderUi';
import { useWindows, type WindowState } from '@/store/windows';
import styles from './Finder.module.css';

type FinderDialog =
  | { kind: 'newFolder' }
  | { kind: 'rename'; node: FinderNode }
  | { kind: 'emptyTrash' }
  | { kind: 'delete'; nodes: FinderNode[] }
  | { kind: 'preview'; node: FinderNode };

type ContextMenuState = { x: number; y: number; target: string | null };

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Something went wrong. Please retry.';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fileKind(node: FinderNode): string {
  if (node.kind === 'folder') return 'Folder';
  if (node.mime === 'text/plain') return 'Plain text';
  return `${node.mime.split('/')[1]?.toUpperCase() ?? 'File'} image`;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select, [contenteditable="true"]'));
}

function hasTextSelection(): boolean {
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}

function imageExtension(type: string): string {
  return type === 'image/jpeg' ? 'jpg' : type.split('/')[1] ?? 'png';
}

async function filesFromClipboard(items: ClipboardItem[]): Promise<File[]> {
  const files: File[] = [];
  for (const item of items) {
    const image = IMAGE_TYPES.find((type) => item.types.includes(type));
    if (image) {
      const blob = await item.getType(image);
      files.push(new File([blob], `Pasted image.${imageExtension(image)}`, { type: image }));
      continue;
    }
    if (item.types.includes('text/plain')) {
      const blob = await item.getType('text/plain');
      files.push(new File([blob], 'Pasted text.txt', { type: 'text/plain' }));
    }
  }
  return files;
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === 'left' ? 'm10 3-5 5 5 5' : 'm6 3 5 5-5 5'}/></svg>;
}

function GridIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="5" rx="1.3"/><rect x="9.5" y="1.5" width="5" height="5" rx="1.3"/><rect x="1.5" y="9.5" width="5" height="5" rx="1.3"/><rect x="9.5" y="9.5" width="5" height="5" rx="1.3"/></svg>;
}

function ListIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M5.5 3.5h9m-9 4.5h9m-9 4.5h9"/><circle cx="2" cy="3.5" r=".9" fill="currentColor" stroke="none"/><circle cx="2" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="2" cy="12.5" r=".9" fill="currentColor" stroke="none"/></svg>;
}

function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>;
}

function ImportIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v7m0 0 3-3M8 9 5 6"/><path d="M2.5 10.5v1.7a1.3 1.3 0 0 0 1.3 1.3h8.4a1.3 1.3 0 0 0 1.3-1.3v-1.7"/></svg>;
}

function SearchIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.3"/><path d="m10.3 10.3 3.2 3.2"/></svg>;
}

function MoreIcon() {
  return <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg>;
}

function TrashIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3h4v1.5m-6 0 .7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8l.7-8.2M6.5 7v4m3-4v4"/></svg>;
}

function RestoreIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6.5A5.5 5.5 0 1 1 3.6 11"/><path d="M3 2.5v4h4"/></svg>;
}

function PencilIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 11.5-.5 2 2-.5L13 4.5 11.5 3Z"/></svg>;
}

function CopyIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>;
}

function PasteIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3H4.5A1.5 1.5 0 0 0 3 4.5v8A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 11.5 3H10"/><rect x="6" y="1.8" width="4" height="3" rx="1"/></svg>;
}

function FolderGlyph({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"><path d="M4 13a4 4 0 0 1 4-4h11l4 5h17a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="#4a9fd3"/><path d="M4 19h40v20a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="#83cdf0"/><path d="M4 19h40v5H4Z" fill="#b7e5f8"/><path d="M4 17.5h40" stroke="#fff" strokeOpacity=".55"/></svg>;
}

function TextGlyph({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"><path d="M11 4h19l8 8v32H11Z" fill="#fdfaf0"/><path d="M30 4v8h8" fill="#e6ddc9"/><path d="M11 4h19l8 8v32H11Z" fill="none" stroke="#c9bda6"/><path d="M17 20h15M17 26h15M17 32h11" stroke="#8eabc0" strokeWidth="2" strokeLinecap="round"/></svg>;
}

function ImageGlyph({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="7" width="32" height="34" rx="3" fill="#eef7fb" stroke="#b6cdd9"/><circle cx="18" cy="18" r="4" fill="#f3bf68"/><path d="m11 36 9-11 7 7 4-5 6 9Z" fill="#71bfa4"/><path d="m11 36 9-11 7 7 4-5" fill="none" stroke="#4b9b81" strokeWidth="1.4"/></svg>;
}

function Thumb({ node, size }: { node: FinderNode; size: number }) {
  const url = useMemo(() => node.kind === 'file' && node.blob && node.mime.startsWith('image/')
    ? URL.createObjectURL(node.blob)
    : null, [node]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  // eslint-disable-next-line @next/next/no-img-element -- local IndexedDB blob preview
  if (url) return <img className={styles.thumbImage} src={url} alt="" draggable={false} loading="lazy" style={{ width: size, height: size }}/>;
  if (node.kind === 'folder') return <FolderGlyph size={size}/>;
  return node.mime.startsWith('image/') ? <ImageGlyph size={size}/> : <TextGlyph size={size}/>;
}

export function Finder({ win }: { win: WindowState }) {
  const {
    nodes, ready, busy, error, clipboard,
    initialize, createFolder, rename, addFiles, copy, paste, trash, restore, remove, emptyTrash,
  } = useFinderFiles();
  const [folderId, setFolderId] = useState('home');
  const [history, setHistory] = useState(['home']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<FinderView>('grid');
  const [dialog, setDialog] = useState<FinderDialog | null>(null);
  const [context, setContext] = useState<ContextMenuState | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const trashView = folderId === 'trash';
  const rawFolder = byId.get(folderId);
  const fallbackHome = !trashView && (!rawFolder || isTrashed(rawFolder, nodes));
  const viewFolderId = fallbackHome ? 'home' : folderId;
  const folder = byId.get(viewFolderId);
  const selectedNodes = useMemo(() => selected.map((id) => byId.get(id)).filter((node): node is FinderNode => !!node), [selected, byId]);
  const items = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return nodes
      .filter((node) => trashView ? node.trashedAt !== null : node.parentId === viewFolderId && !isTrashed(node, nodes))
      .filter((node) => !needle || node.name.toLocaleLowerCase().includes(needle))
      .sort((left, right) => left.kind === right.kind
        ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        : left.kind === 'folder' ? -1 : 1);
  }, [nodes, viewFolderId, trashView, search]);
  const path = useMemo(() => trashView ? [] : finderPath(nodes, viewFolderId), [nodes, viewFolderId, trashView]);
  const used = useMemo(() => nodes.reduce((sum, node) => sum + node.size, 0), [nodes]);
  const trashRoots = useMemo(() => nodes.filter((node) => node.trashedAt !== null), [nodes]);
  const trashedTotal = useMemo(() => nodes.filter((node) => isTrashed(node, nodes)).length, [nodes]);

  const canBack = historyIndex > 0;
  const canForward = historyIndex < history.length - 1;
  const canModifySelection = selectedNodes.length > 0 && selectedNodes.every((node) => !isProtected(node.id) && !isTrashed(node, nodes));
  const flags = useMemo<FinderFlags>(() => ({
    view,
    busy,
    canBack,
    canForward,
    canCreate: ready && !trashView && !busy,
    canImport: ready && !trashView && !busy,
    canPaste: ready && !trashView && !busy,
    canCopy: ready && !trashView && canModifySelection && !busy,
    canRename: ready && !trashView && !busy && selectedNodes.length === 1 && !isProtected(selectedNodes[0].id) && !isTrashed(selectedNodes[0], nodes),
    canTrash: ready && !trashView && canModifySelection && !busy,
    canRestore: ready && trashView && selectedNodes.length > 0 && !busy,
    canDelete: ready && trashView && selectedNodes.length > 0 && !busy,
    canEmptyTrash: ready && trashView && trashRoots.length > 0 && !busy,
    canSelectAll: ready && items.length > 0,
    trashView,
    selectionCount: selectedNodes.length,
    trashCount: trashRoots.length,
  }), [view, busy, canBack, canForward, ready, trashView, canModifySelection, selectedNodes, nodes, trashRoots.length, items.length]);

  const navigate = (id: string) => {
    setFolderId(id);
    setSelected([]);
    setAnchor(null);
    setSearch('');
    setContext(null);
    const base = history.slice(0, historyIndex + 1);
    if (base[base.length - 1] !== id) {
      const next = [...base, id].slice(-40);
      setHistory(next);
      setHistoryIndex(next.length - 1);
    }
  };

  const goBack = () => {
    if (!canBack) return;
    const index = historyIndex - 1;
    setHistoryIndex(index);
    setFolderId(history[index]);
    setSelected([]);
    setAnchor(null);
    setSearch('');
    setContext(null);
  };

  const goForward = () => {
    if (!canForward) return;
    const index = historyIndex + 1;
    setHistoryIndex(index);
    setFolderId(history[index]);
    setSelected([]);
    setAnchor(null);
    setSearch('');
    setContext(null);
  };

  const openDialog = (next: FinderDialog) => setDialog(next);
  const closeDialog = () => {
    setDialog(null);
    useFinderFiles.setState({ error: null });
  };

  const openNode = (node: FinderNode) => {
    if (trashView) return;
    if (node.kind === 'folder') navigate(node.id);
    else openDialog({ kind: 'preview', node });
  };

  const copySelection = () => {
    if (!flags.canCopy) return;
    try { copy(selected); } catch { /* The store surfaces the reason. */ }
  };

  const pasteInternal = async () => {
    if (!flags.canPaste || clipboard.length === 0) return;
    try {
      const ids = await paste(viewFolderId);
      setSelected(ids);
      setAnchor(ids[ids.length - 1] ?? null);
    } catch { /* The store surfaces the reason. */ }
  };

  const pasteSystem = async () => {
    if (!flags.canPaste) return;
    try {
      if (!navigator.clipboard?.read) throw new Error('Clipboard access is unavailable in this browser. Press ⌘V to paste clipboard text or an image.');
      const files = await filesFromClipboard(await navigator.clipboard.read());
      if (files.length === 0) throw new Error('The clipboard does not contain text or a supported image.');
      const ids = await addFiles(viewFolderId, files);
      setSelected(ids);
      setAnchor(ids[ids.length - 1] ?? null);
    } catch (reason) {
      useFinderFiles.setState({ error: errorMessage(reason) });
    }
  };

  const pasteAction = () => {
    if (clipboard.length > 0) void pasteInternal();
    else void pasteSystem();
  };

  const trashSelection = async () => {
    if (!flags.canTrash) return;
    try {
      await trash(selected);
      setSelected([]);
      setAnchor(null);
    } catch { /* The store surfaces the reason. */ }
  };

  const restoreSelection = async () => {
    if (!flags.canRestore) return;
    try {
      await restore(selected);
      setSelected([]);
      setAnchor(null);
    } catch { /* The store surfaces the reason. */ }
  };

  const requestDelete = () => {
    if (!flags.canDelete) return;
    openDialog({ kind: 'delete', nodes: selectedNodes });
  };

  const requestRename = () => {
    if (selectedNodes.length !== 1 || !flags.canRename) return;
    openDialog({ kind: 'rename', node: selectedNodes[0] });
  };

  const requestNewFolder = () => {
    if (!flags.canCreate) return;
    openDialog({ kind: 'newFolder' });
  };

  const triggerImport = () => {
    if (!flags.canImport) return;
    inputRef.current?.click();
  };

  const requestEmptyTrash = () => {
    if (!flags.canEmptyTrash) return;
    openDialog({ kind: 'emptyTrash' });
  };

  const selectAll = () => {
    if (!flags.canSelectAll) return;
    setSelected(items.map((node) => node.id));
    setAnchor(items[0]?.id ?? null);
  };

  const setFinderView = (next: FinderView) => setView(next);

  const submitName = async (name: string) => {
    if (!dialog) return;
    if (dialog.kind === 'newFolder') {
      const id = await createFolder(viewFolderId, name);
      setSelected([id]);
      setAnchor(id);
    } else if (dialog.kind === 'rename') {
      await rename(dialog.node.id, name);
      setSelected([dialog.node.id]);
      setAnchor(dialog.node.id);
    }
    setDialog(null);
  };

  const confirmEmptyTrash = async () => {
    await emptyTrash();
    setSelected([]);
    setAnchor(null);
    setDialog(null);
  };

  const confirmDelete = async (targets: FinderNode[]) => {
    await remove(targets.map((node) => node.id));
    setSelected([]);
    setAnchor(null);
    setDialog(null);
  };

  const selectItem = (event: ReactMouseEvent, node: FinderNode) => {
    if (event.shiftKey && anchor) {
      const from = items.findIndex((item) => item.id === anchor);
      const to = items.findIndex((item) => item.id === node.id);
      if (from >= 0 && to >= 0) {
        setSelected(items.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.id));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]);
      setAnchor(node.id);
      return;
    }
    setSelected([node.id]);
    setAnchor(node.id);
  };

  const openContext = (event: ReactMouseEvent, node?: FinderNode) => {
    event.preventDefault();
    event.stopPropagation();
    if (node) {
      if (!selected.includes(node.id)) {
        setSelected([node.id]);
        setAnchor(node.id);
      }
    } else {
      setSelected([]);
      setAnchor(null);
    }
    setContextAt(event.clientX, event.clientY, node?.id ?? null);
  };

  const setContextAt = (x: number, y: number, target: string | null) => {
    const width = 216;
    const height = 280;
    setContext({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      target,
    });
  };

  const openActionMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setContextAt(rect.right - 216, rect.bottom + 6, null);
  };

  const applyView = (next: FinderView) => {
    setView(next);
    setContext(null);
  };

  const focusSearch = () => {
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  };

  const actions: FinderActions = {
    newFolder: requestNewFolder,
    importFiles: triggerImport,
    copy: copySelection,
    paste: pasteAction,
    trash: () => { void trashSelection(); },
    restore: () => { void restoreSelection(); },
    deleteForever: requestDelete,
    emptyTrash: requestEmptyTrash,
    rename: requestRename,
    selectAll,
    search: focusSearch,
    setView: applyView,
    back: goBack,
    forward: goForward,
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (useWindows.getState().activeId !== win.id) return;
    if (document.querySelector('[data-dockhood-dialog]')) return;
    if (isEditable(event.target)) return;
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape') {
      if (context) { setContext(null); event.preventDefault(); return; }
      if (search) { setSearch(''); event.preventDefault(); return; }
      setSelected([]);
      setAnchor(null);
      return;
    }
    if (mod && key === 'a') {
      if (!flags.canSelectAll) return;
      event.preventDefault();
      selectAll();
      return;
    }
    if (mod && key === 'c') {
      if (!flags.canCopy || hasTextSelection()) return;
      event.preventDefault();
      copySelection();
      return;
    }
    if (mod && key === 'f') {
      event.preventDefault();
      focusSearch();
      return;
    }
    if (mod && event.shiftKey && key === 'n') {
      if (!flags.canCreate) return;
      event.preventDefault();
      requestNewFolder();
      return;
    }
    if (event.key === 'Enter') {
      if (selected.length !== 1) return;
      const node = byId.get(selected[0]);
      if (!node) return;
      event.preventDefault();
      openNode(node);
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && mod) {
      if (trashView) {
        if (!flags.canDelete) return;
        event.preventDefault();
        requestDelete();
      } else {
        if (!flags.canTrash) return;
        event.preventDefault();
        void trashSelection();
      }
      return;
    }
    if (event.key === 'ArrowUp' && mod) {
      if (trashView) return;
      const currentPath = finderPath(nodes, viewFolderId);
      if (currentPath.length < 2) return;
      event.preventDefault();
      navigate(currentPath[currentPath.length - 2].id);
    }
  });

  const onPaste = useEffectEvent((event: ClipboardEvent) => {
    if (useWindows.getState().activeId !== win.id) return;
    if (document.querySelector('[data-dockhood-dialog]')) return;
    if (isEditable(event.target) || hasTextSelection()) return;
    if (trashView || !ready || busy) return;
    const files = [...(event.clipboardData?.files ?? [])];
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (files.length === 0 && !text) {
      if (clipboard.length === 0) return;
      event.preventDefault();
      void pasteInternal();
      return;
    }
    event.preventDefault();
    const payload = files.length > 0 ? files : [new File([text], 'Pasted text.txt', { type: 'text/plain' })];
    void addFiles(viewFolderId, payload).then((ids) => {
      setSelected(ids);
      setAnchor(ids[ids.length - 1] ?? null);
    }).catch(() => {});
  });

  const onFiles = async (files: File[]) => {
    if (!flags.canImport || files.length === 0) return;
    try {
      const ids = await addFiles(viewFolderId, files);
      setSelected(ids);
      setAnchor(ids[ids.length - 1] ?? null);
    } catch { /* The store surfaces the reason. */ }
  };

  useEffect(() => {
    void initialize().catch(() => {});
  }, [initialize]);

  useEffect(() => {
    useFinderUi.getState().setFlags(flags);
  }, [flags]);

  useEffect(() => {
    finderCommands.current = actions;
  });

  useEffect(() => () => {
    finderCommands.current = null;
    useFinderUi.getState().clear();
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, []);

  useEffect(() => {
    const listener = (event: ClipboardEvent) => onPaste(event);
    document.addEventListener('paste', listener);
    return () => document.removeEventListener('paste', listener);
  }, []);

  useEffect(() => {
    if (!context) return;
    const dismiss = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest('[data-finder-menu], [data-finder-actions]')) return;
      setContext(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setContext(null); };
    const close = () => setContext(null);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [context]);

  const contextNode = context?.target ? byId.get(context.target) : undefined;
  const folderName = trashView ? 'Trash' : folder?.name ?? 'Finder';
  const dropActive = dragging && !trashView;

  return (
    <div
      className={`${styles.finder} ${dropActive ? styles.dropActive : ''}`}
      aria-busy={busy}
      onDragEnter={(event: DragEvent) => {
        event.preventDefault();
        dragDepth.current += 1;
        if (!trashView) setDragging(true);
      }}
      onDragOver={(event: DragEvent) => { event.preventDefault(); if (!trashView) setDragging(true); }}
      onDragLeave={(event: DragEvent) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (trashView) {
          useFinderFiles.setState({ error: 'Leave Trash before importing files.' });
          return;
        }
        void onFiles([...event.dataTransfer.files]);
      }}
    >
      <aside className={styles.sidebar} aria-label="Finder locations">
        <p className={styles.sidebarHeading}>Favorites</p>
        {[
          { id: 'home', label: 'Home' },
          { id: 'desktop', label: 'Desktop' },
          { id: 'documents', label: 'Documents' },
          { id: 'images', label: 'Images' },
        ].map((location) => (
          <button
            key={location.id}
            type="button"
            className={`${styles.location} ${folderId === location.id ? styles.locationActive : ''}`}
            aria-current={folderId === location.id ? 'page' : undefined}
            onClick={() => navigate(location.id)}
          >
            <FolderGlyph size={18}/><span>{location.label}</span>
          </button>
        ))}
        <p className={styles.sidebarHeading}>Locations</p>
        <button
          type="button"
          className={`${styles.location} ${trashView ? styles.locationActive : ''}`}
          aria-current={trashView ? 'page' : undefined}
          onClick={() => navigate('trash')}
        >
          <TrashIcon size={17}/><span>Trash</span>
          {trashRoots.length > 0 && <span className={styles.badge}>{trashRoots.length}</span>}
        </button>
        <div className={styles.storage}>
          <div className={styles.storageLabel}><span>Local storage</span><span>{formatBytes(used)}</span></div>
          <div className={styles.storageTrack}><span style={{ width: `${Math.min(100, (used / FINDER_TOTAL_LIMIT) * 100)}%` }}/></div>
          <p>{formatBytes(FINDER_TOTAL_LIMIT)} limit · saved in this browser</p>
        </div>
      </aside>

      <section className={styles.main} aria-label={`${folderName} contents`}>
        <div className={styles.toolbar}>
          <div className={styles.navButtons}>
            <button type="button" className={styles.iconButton} aria-label="Back" title="Back" disabled={!canBack} onClick={goBack}><Chevron direction="left"/></button>
            <button type="button" className={styles.iconButton} aria-label="Forward" title="Forward" disabled={!canForward} onClick={goForward}><Chevron direction="right"/></button>
          </div>
          <nav className={styles.breadcrumb} aria-label="Folder path">
            {trashView ? <span className={styles.crumbCurrent}>Trash</span> : path.length === 0 ? <span className={styles.crumbCurrent}>Finder</span> : path.map((node, index) => (
              <span key={node.id} className={styles.crumbGroup}>
                {index > 0 && <span className={styles.crumbSeparator} aria-hidden="true">›</span>}
                {index === path.length - 1
                  ? <span className={styles.crumbCurrent}>{node.name}</span>
                  : <button type="button" className={styles.crumb} onClick={() => navigate(node.id)}>{node.name}</button>}
              </span>
            ))}
          </nav>
          <label className={styles.search}>
            <SearchIcon/>
            <input
              ref={searchRef}
              type="search"
              value={search}
              placeholder="Search"
              aria-label="Search this folder"
              onChange={(event) => { setSearch(event.target.value); setSelected([]); setAnchor(null); }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setSearch('');
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
          <div className={styles.viewToggle} role="group" aria-label="View as">
            <button type="button" className={`${styles.viewButton} ${view === 'grid' ? styles.viewActive : ''}`} aria-label="View as icons" aria-pressed={view === 'grid'} onClick={() => setFinderView('grid')}><GridIcon/></button>
            <button type="button" className={`${styles.viewButton} ${view === 'list' ? styles.viewActive : ''}`} aria-label="View as list" aria-pressed={view === 'list'} onClick={() => setFinderView('list')}><ListIcon/></button>
          </div>
          <div className={styles.toolbarActions}>
            <button type="button" className={styles.iconButton} aria-label="New folder" title="New folder (⌘⇧N)" disabled={!flags.canCreate} onClick={requestNewFolder}><PlusIcon/></button>
            <button type="button" className={styles.iconButton} aria-label="Import files" title="Import files" disabled={!flags.canImport} onClick={triggerImport}><ImportIcon/></button>
            <button type="button" className={`${styles.iconButton} ${styles.optionalAction}`} aria-label="Copy" title="Copy" disabled={!flags.canCopy} onClick={copySelection}><CopyIcon/></button>
            <button type="button" className={`${styles.iconButton} ${styles.optionalAction}`} aria-label="Paste" title="Paste" disabled={!flags.canPaste} onClick={pasteAction}><PasteIcon/></button>
            <button type="button" className={`${styles.iconButton} ${styles.optionalAction}`} aria-label={trashView ? 'Delete immediately' : 'Move to Trash'} title={trashView ? 'Delete immediately' : 'Move to Trash'} disabled={trashView ? !flags.canDelete : !flags.canTrash} onClick={trashView ? requestDelete : () => { void trashSelection(); }}><TrashIcon/></button>
            <button type="button" className={styles.iconButton} aria-label="More actions" title="More actions" data-finder-actions onClick={openActionMenu}><MoreIcon/></button>
          </div>
          <input
            ref={inputRef}
            type="file"
            className={styles.hiddenInput}
            multiple
            accept=".txt,.png,.jpg,.jpeg,.webp,.gif,text/plain,image/png,image/jpeg,image/webp,image/gif"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void onFiles(files);
            }}
          />
        </div>

        {busy && <div className={styles.busyBar} aria-hidden="true"/>}
        {ready && error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => useFinderFiles.setState({ error: null })}>×</button>
          </div>
        )}

        <div
          className={styles.content}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelected([]);
              setAnchor(null);
            }
          }}
          onContextMenu={(event) => openContext(event)}
        >
          {!ready ? (
            <div className={styles.state} role="status">
              {error ? (
                <>
                  <TrashIcon size={34}/>
                  <p>{error}</p>
                  <Button onClick={() => { void initialize().catch(() => {}); }}>Retry</Button>
                </>
              ) : (
                <>
                  <span className={styles.spinner} aria-hidden="true"/>
                  <p>Opening Finder…</p>
                </>
              )}
            </div>
          ) : items.length === 0 ? (
            <div className={styles.state}>
              {trashView ? <TrashIcon size={38}/> : <FolderGlyph size={52}/>}
              <p>{search ? `No items match “${search}”.` : trashView ? 'Trash is empty.' : 'This folder is empty.'}</p>
              {!search && !trashView && <p className={styles.stateHint}>Drag files here, or use Import to add text and images.</p>}
            </div>
          ) : view === 'grid' ? (
            <div className={styles.grid} role="listbox" aria-label={`${folderName} items`} aria-multiselectable="true" onPointerDown={(event) => { if (event.target === event.currentTarget) { setSelected([]); setAnchor(null); } }}>
              {items.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={selected.includes(node.id)}
                  className={`${styles.card} ${selected.includes(node.id) ? styles.selected : ''}`}
                  onClick={(event) => selectItem(event, node)}
                  onDoubleClick={() => openNode(node)}
                  onContextMenu={(event) => openContext(event, node)}
                >
                  <span className={styles.cardThumb}><Thumb node={node} size={52}/></span>
                  <span className={styles.cardName}>{node.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.list} role="listbox" aria-label={`${folderName} items`} aria-multiselectable="true" onPointerDown={(event) => { if (event.target === event.currentTarget) { setSelected([]); setAnchor(null); } }}>
              <div className={styles.listHeader} aria-hidden="true"><span>Name</span><span>Kind</span><span>Size</span><span>Modified</span></div>
              {items.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={selected.includes(node.id)}
                  className={`${styles.row} ${selected.includes(node.id) ? styles.selected : ''}`}
                  onClick={(event) => selectItem(event, node)}
                  onDoubleClick={() => openNode(node)}
                  onContextMenu={(event) => openContext(event, node)}
                >
                  <span className={styles.rowName}><Thumb node={node} size={20}/><span>{node.name}</span></span>
                  <span className={styles.rowMeta}>{fileKind(node)}</span>
                  <span className={styles.rowMeta}>{node.kind === 'folder' ? '—' : formatBytes(node.size)}</span>
                  <span className={styles.rowMeta}>{formatDate(node.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
          {dropActive && <div className={styles.dropHint} aria-hidden="true"><ImportIcon/><span>Drop to import into {folderName}</span></div>}
        </div>

        <StatusBar cells={[
          `${items.length} ${items.length === 1 ? 'item' : 'items'}${selected.length > 0 ? ` · ${selected.length} selected` : ''}`,
          trashView ? `${trashRoots.length} in Trash` : `${formatBytes(used)} local`,
          folderName,
        ]}/>
      </section>

      {context && createPortal(
        <div
          className={styles.context}
          data-finder-menu
          role="menu"
          style={{ left: context.x, top: context.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextNode ? (
            trashView ? (
              <>
                <button type="button" role="menuitem" onClick={() => { setContext(null); void restoreSelection(); }}><RestoreIcon/>Put Back</button>
                <hr/>
                <button type="button" role="menuitem" className={styles.danger} onClick={() => { setContext(null); requestDelete(); }}><TrashIcon size={15}/>Delete Immediately…</button>
              </>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={() => { setContext(null); openNode(contextNode); }}>{contextNode.kind === 'folder' ? <FolderGlyph size={15}/> : <TextGlyph size={15}/>}{contextNode.kind === 'folder' ? 'Open' : 'Quick Look'}</button>
                <button type="button" role="menuitem" disabled={!flags.canRename} onClick={() => { setContext(null); requestRename(); }}><PencilIcon/>Rename</button>
                <button type="button" role="menuitem" disabled={!flags.canCopy} onClick={() => { setContext(null); copySelection(); }}><CopyIcon/>Copy</button>
                <hr/>
                <button type="button" role="menuitem" className={styles.danger} disabled={!flags.canTrash} onClick={() => { setContext(null); void trashSelection(); }}><TrashIcon size={15}/>Move to Trash</button>
              </>
            )
          ) : trashView ? (
            <>
              {selected.length > 0 && <>
                <button type="button" role="menuitem" onClick={() => { setContext(null); void restoreSelection(); }}><RestoreIcon/>Put Back</button>
                <button type="button" role="menuitem" className={styles.danger} onClick={() => { setContext(null); requestDelete(); }}><TrashIcon size={15}/>Delete Immediately…</button>
                <hr/>
              </>}
              <button type="button" role="menuitem" className={styles.danger} disabled={!flags.canEmptyTrash} onClick={() => { setContext(null); requestEmptyTrash(); }}><TrashIcon size={15}/>Empty Trash…</button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" disabled={!flags.canCreate} onClick={() => { setContext(null); requestNewFolder(); }}><PlusIcon/>New Folder</button>
              <button type="button" role="menuitem" disabled={!flags.canImport} onClick={() => { setContext(null); triggerImport(); }}><ImportIcon/>Import Files…</button>
              <button type="button" role="menuitem" disabled={!flags.canPaste} onClick={() => { setContext(null); pasteAction(); }}><PasteIcon/>Paste</button>
              <hr/>
              <button type="button" role="menuitem" disabled={!flags.canSelectAll} onClick={() => { setContext(null); selectAll(); }}>Select All</button>
              {selectedNodes.length === 1 && (
                <button type="button" role="menuitem" disabled={!flags.canRename} onClick={() => { setContext(null); requestRename(); }}><PencilIcon/>Rename</button>
              )}
              {selected.length > 0 && <>
                <button type="button" role="menuitem" disabled={!flags.canCopy} onClick={() => { setContext(null); copySelection(); }}><CopyIcon/>Copy</button>
                <button type="button" role="menuitem" className={styles.danger} disabled={!flags.canTrash} onClick={() => { setContext(null); void trashSelection(); }}><TrashIcon size={15}/>Move to Trash</button>
              </>}
            </>
          )}
        </div>,
        document.body,
      )}

      {dialog?.kind === 'newFolder' && (
        <NameDialog
          title="New Folder"
          initial="Untitled Folder"
          submitLabel="Create"
          busy={busy}
          onClose={closeDialog}
          onSubmit={submitName}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title="Rename"
          initial={dialog.node.name}
          submitLabel="Rename"
          busy={busy}
          selectStem={dialog.node.kind === 'file'}
          onClose={closeDialog}
          onSubmit={submitName}
        />
      )}
      {dialog?.kind === 'emptyTrash' && (
        <ConfirmDialog
          title="Empty Trash?"
          confirmLabel="Empty Trash"
          danger
          busy={busy}
          onClose={closeDialog}
          onConfirm={confirmEmptyTrash}
        >
          Permanently delete {trashedTotal} {trashedTotal === 1 ? 'item' : 'items'}? This cannot be undone.
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete Immediately?"
          confirmLabel="Delete"
          danger
          busy={busy}
          onClose={closeDialog}
          onConfirm={() => confirmDelete(dialog.nodes)}
        >
          Permanently delete {dialog.nodes.length} {dialog.nodes.length === 1 ? 'item' : 'items'}? This cannot be undone.
        </ConfirmDialog>
      )}
      {dialog?.kind === 'preview' && <PreviewDialog node={dialog.node} onClose={closeDialog}/>}
    </div>
  );
}

function NameDialog({
  title, initial, submitLabel, busy, selectStem, onClose, onSubmit,
}: {
  title: string;
  initial: string;
  submitLabel: string;
  busy: boolean;
  selectStem?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const formId = useId();
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    try {
      await onSubmit(value);
    } catch (reason) {
      setProblem(errorMessage(reason));
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={380}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" disabled={busy}>{submitLabel}</Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <label className={styles.field}>
          <span>Name</span>
          <input
            data-autofocus
            type="text"
            value={value}
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => {
              const dot = selectStem ? initial.lastIndexOf('.') : -1;
              event.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
            }}
          />
        </label>
        {problem && <p className={styles.formError} role="alert">{problem}</p>}
      </form>
    </Dialog>
  );
}

function ConfirmDialog({
  title, children, confirmLabel, danger, busy, onClose, onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const confirm = async () => {
    setProblem(null);
    setWorking(true);
    try {
      await onConfirm();
    } catch (reason) {
      setProblem(errorMessage(reason));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={400}
      footer={
        <>
          <Button onClick={onClose} disabled={working}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => { void confirm(); }} disabled={busy || working}>{confirmLabel}</Button>
        </>
      }
    >
      <p className={styles.confirmText}>{children}</p>
      {problem && <p className={styles.formError} role="alert">{problem}</p>}
    </Dialog>
  );
}

function PreviewDialog({ node, onClose }: { node: FinderNode; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const supported = node.kind === 'file' && !!node.blob && (node.mime === 'text/plain' || node.mime.startsWith('image/'));
  const image = useMemo(() => supported && node.blob && node.mime.startsWith('image/') ? URL.createObjectURL(node.blob) : null, [supported, node]);

  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);

  useEffect(() => {
    if (!supported || node.mime !== 'text/plain' || !node.blob) return;
    let active = true;
    const blob = node.blob;
    blob.text().then((value) => {
      if (!active) return;
      setTruncated(value.length > 120_000);
      setText(value.slice(0, 120_000));
    }).catch(() => { if (active) setProblem('The text file could not be read.'); });
    return () => { active = false; };
  }, [supported, node]);

  return (
    <Dialog title={node.name} onClose={onClose} width={640} footer={<Button onClick={onClose}>Done</Button>}>
      {!supported ? <p className={styles.formError} role="alert">This item cannot be previewed.</p> : problem ? <p className={styles.formError} role="alert">{problem}</p> : image ? (
        // eslint-disable-next-line @next/next/no-img-element -- local IndexedDB blob preview
        <img className={styles.previewImage} src={image} alt={node.name}/>
      ) : text !== null ? (
        <>
          <pre className={styles.previewText}>{text}</pre>
          {truncated && <p className={styles.previewNote}>Preview limited to the first 120,000 characters.</p>}
        </>
      ) : (
        <div className={styles.state} role="status"><span className={styles.spinner} aria-hidden="true"/><p>Loading preview…</p></div>
      )}
    </Dialog>
  );
}

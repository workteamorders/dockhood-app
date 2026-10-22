'use client';

import { create } from 'zustand';
import {
  applyFinderCommand, finderCopyRoots, seedFinderNodes, validateFinderImports, validateFinderNodes,
  type FinderCommand, type FinderNode,
} from '@/lib/finderFiles';

type FinderStore = {
  nodes: FinderNode[];
  ready: boolean;
  busy: boolean;
  error: string | null;
  clipboard: string[];
  initialize: () => Promise<void>;
  createFolder: (parentId: string, name: string) => Promise<string>;
  rename: (id: string, name: string) => Promise<void>;
  addFiles: (parentId: string, files: File[]) => Promise<string[]>;
  copy: (ids: string[]) => void;
  paste: (parentId: string) => Promise<string[]>;
  trash: (ids: string[]) => Promise<void>;
  restore: (ids: string[]) => Promise<void>;
  remove: (ids: string[]) => Promise<void>;
  emptyTrash: () => Promise<void>;
};

const DATABASE = 'dockhood-finder';
const VERSION = 1;
const STORE = 'filesystem';
const KEY = 'root';
let connection: Promise<IDBDatabase> | undefined;
let initialization: Promise<void> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let listening = false;
let channel: BroadcastChannel | undefined;

function storageError(reason: unknown): Error {
  const name = reason && typeof reason === 'object' && 'name' in reason ? reason.name : '';
  if (name === 'QuotaExceededError') return new Error('Browser storage is full. No changes were saved. Empty Trash or free browser storage and retry.');
  if (name === 'SecurityError' || name === 'NotAllowedError') return new Error('Browser storage access was denied. Allow site storage and retry Finder.');
  if (reason instanceof Error) return reason;
  return new Error('Finder could not access browser storage. No changes were saved. Please retry.');
}

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable. Enable browser site storage and retry Finder.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    let abandoned = false;
    request.onupgradeneeded = (event) => {
      if (abandoned) { request.transaction?.abort(); return; }
      if (event.oldVersion !== 0) {
        request.transaction?.abort();
        return;
      }
      const store = request.result.createObjectStore(STORE);
      store.put({ version: VERSION, nodes: seedFinderNodes() }, KEY);
    };
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('Finder storage is blocked by another tab. Close older Dockhood tabs and retry.'));
    };
    request.onerror = () => reject(storageError(request.error));
    request.onsuccess = () => {
      const db = request.result;
      if (abandoned) { db.close(); return; }
      db.onversionchange = () => {
        db.close();
        connection = undefined;
        initialization = undefined;
        useFinderFiles.setState({ ready: false, error: 'Finder storage changed in another tab. Please retry Finder.' });
      };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
  });
  connection = opening;
  void opening.catch(() => { if (connection === opening) connection = undefined; });
  return opening;
}

async function transaction(command?: FinderCommand): Promise<{ nodes: FinderNode[]; ids: string[] }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let result: { nodes: FinderNode[]; ids: string[] };
    let failure: Error | undefined;
    const tx = db.transaction(STORE, command ? 'readwrite' : 'readonly');
    const store = tx.objectStore(STORE);
    const request = store.get(KEY);
    request.onsuccess = () => {
      try {
        const record: unknown = request.result;
        if (!record || typeof record !== 'object' || !('version' in record) || record.version !== VERSION || !('nodes' in record)) {
          throw new Error('Finder storage is corrupt or unsupported. Your saved data has not been overwritten.');
        }
        validateFinderNodes(record.nodes);
        result = command ? applyFinderCommand(record.nodes, command) : { nodes: record.nodes, ids: [] };
        if (command) {
          validateFinderNodes(result.nodes);
          store.put({ version: VERSION, nodes: result.nodes }, KEY);
        }
      } catch (reason) {
        failure = storageError(reason);
        tx.abort();
      }
    };
    // A successful request is not a durable save: only publish after transaction completion.
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? storageError(tx.error));
    tx.onerror = () => { failure ??= storageError(tx.error); };
  });
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  pending++;
  useFinderFiles.setState({ busy: true });
  const task = queue.then(async () => {
    useFinderFiles.setState({ error: null });
    try { return await work(); }
    catch (reason) {
      const error = storageError(reason);
      useFinderFiles.setState({ error: error.message });
      throw error;
    } finally {
      pending--;
      useFinderFiles.setState({ busy: pending > 0 });
    }
  });
  queue = task.catch(() => {});
  return task;
}

function listenForChanges() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const refresh = () => {
    if (!useFinderFiles.getState().ready) return;
    void enqueue(async () => {
      const { nodes } = await transaction();
      useFinderFiles.setState({ nodes });
    }).catch(() => {});
  };
  window.addEventListener('focus', refresh);
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(DATABASE);
      channel.onmessage = refresh;
    }
  } catch { /* Focus refresh still works when browser policy disables BroadcastChannel. */ }
}

function mutate(command: FinderCommand): Promise<string[]> {
  return enqueue(async () => {
    if (!useFinderFiles.getState().ready) throw new Error('Finder is not ready. Initialize browser storage and retry.');
    if (command.type === 'addFiles') await validateFinderImports(command.files);
    const { nodes, ids } = await transaction(command);
    useFinderFiles.setState({ nodes });
    try { channel?.postMessage('changed'); } catch { /* Persistence has already succeeded. */ }
    return ids;
  });
}

export const useFinderFiles = create<FinderStore>((set, get) => ({
  nodes: [], ready: false, busy: false, error: null, clipboard: [],
  initialize: () => {
    if (initialization) return initialization;
    const attempt = enqueue(async () => {
      const { nodes } = await transaction();
      set({ nodes, ready: true });
      listenForChanges();
    });
    initialization = attempt;
    void attempt.catch(() => { if (initialization === attempt) initialization = undefined; });
    return attempt;
  },
  createFolder: async (parentId, name) => (await mutate({ type: 'createFolder', parentId, name }))[0],
  rename: async (id, name) => { await mutate({ type: 'rename', id, name }); },
  addFiles: (parentId, files) => mutate({ type: 'addFiles', parentId, files: [...files] }),
  copy: (ids) => {
    try {
      if (!get().ready) throw new Error('Finder is not ready. Initialize browser storage and retry.');
      const roots = finderCopyRoots(get().nodes, ids);
      set({ clipboard: roots.map((node) => node.id), error: null });
    } catch (reason) {
      const error = storageError(reason);
      set({ error: error.message });
      throw error;
    }
  },
  paste: (parentId) => mutate({ type: 'paste', parentId, ids: [...get().clipboard] }),
  trash: async (ids) => { await mutate({ type: 'trash', ids: [...ids] }); },
  restore: async (ids) => { await mutate({ type: 'restore', ids: [...ids] }); },
  remove: async (ids) => { await mutate({ type: 'remove', ids: [...ids] }); },
  emptyTrash: async () => { await mutate({ type: 'emptyTrash' }); },
}));

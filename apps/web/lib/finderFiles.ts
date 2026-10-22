export type FinderNode = {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'folder' | 'file';
  mime: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  originalParentId?: string | null;
  blob: Blob | null;
};

export const FINDER_FILE_LIMIT = 5 * 1024 * 1024;
export const FINDER_TOTAL_LIMIT = 25 * 1024 * 1024;
const SYSTEM_FOLDERS = ['home', 'desktop', 'documents', 'images'];
const FILE_TYPES = new Set(['text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function isProtected(id: string): boolean {
  return SYSTEM_FOLDERS.includes(id);
}

export function isTrashed(node: FinderNode, nodes: FinderNode[]): boolean {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current: FinderNode | undefined = node;
  while (current && !seen.has(current.id)) {
    if (current.trashedAt !== null) return true;
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return false;
}

export function finderPath(nodes: FinderNode[], id: string): FinderNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: FinderNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    path.push(current);
    if (current.id === 'home') return path.reverse();
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return [];
}

export function finderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.length > 120 || /[/\\\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new Error('Use a name of 1-120 characters without slashes, control characters, "." or "..".');
  }
  return trimmed;
}

function uniqueName(nodes: FinderNode[], parentId: string, name: string, kind: FinderNode['kind'], exclude?: string): string {
  const names = new Set(nodes.filter((node) => node.parentId === parentId && node.id !== exclude && node.trashedAt === null).map((node) => node.name));
  if (!names.has(name)) return name;
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 1; ; index++) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`;
    const ext = extension.slice(0, 120 - suffix.length - 1);
    const candidate = `${stem.slice(0, 120 - suffix.length - ext.length)}${suffix}${ext}`;
    if (!names.has(candidate)) return candidate;
  }
}

export function seedFinderNodes(now = Date.now()): FinderNode[] {
  const nodes: FinderNode[] = SYSTEM_FOLDERS.map((id) => ({
    id, parentId: id === 'home' ? null : 'home', name: id[0].toUpperCase() + id.slice(1),
    kind: 'folder', mime: '', size: 0, createdAt: now, updatedAt: now, trashedAt: null, blob: null,
  }));
  const blob = new Blob([
    'Welcome to your Dockhood files!\n\nCreate folders and import text or images to make this space your own.\n' +
    'Files stay locally in this browser using IndexedDB. Nothing is uploaded to a server.\n' +
    'Clearing site data or using another browser will not preserve these files. Keep backups of important files.\n\n' +
    'Supported imports: plain text, PNG, JPEG, WebP and GIF. Maximum 5 MiB per file and 25 MiB total, including Trash.\n',
  ], { type: 'text/plain' });
  nodes.push({
    id: 'welcome', parentId: 'documents', name: 'Welcome.txt', kind: 'file', mime: blob.type,
    size: blob.size, createdAt: now, updatedAt: now, trashedAt: null, blob,
  });
  return nodes;
}

// Reject invalid persisted data rather than replacing a user's files with a fresh seed.
export function validateFinderNodes(value: unknown): asserts value is FinderNode[] {
  const corrupt = () => { throw new Error('Finder storage is corrupt or unsupported. Your saved data has not been overwritten.'); };
  if (!Array.isArray(value)) return corrupt();
  const nodes = value as FinderNode[];
  const ids = new Set<string>();
  const siblings = new Set<string>();
  let total = 0;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id || ids.has(node.id) || node.id === 'trash' ||
      (node.parentId !== null && typeof node.parentId !== 'string') || typeof node.name !== 'string' ||
      !['folder', 'file'].includes(node.kind) || typeof node.mime !== 'string' ||
      !Number.isSafeInteger(node.size) || node.size < 0 ||
      !Number.isFinite(node.createdAt) || node.createdAt < 0 || !Number.isFinite(node.updatedAt) || node.updatedAt < 0 ||
      (node.trashedAt !== null && (!Number.isFinite(node.trashedAt) || node.trashedAt < 0)) ||
      (node.originalParentId !== undefined && node.originalParentId !== null && typeof node.originalParentId !== 'string')) return corrupt();
    try { if (finderName(node.name) !== node.name) return corrupt(); } catch { return corrupt(); }
    if (node.kind === 'folder') {
      if (node.blob !== null || node.size !== 0 || node.mime !== '') return corrupt();
    } else {
      if (!(node.blob instanceof Blob) || node.size !== node.blob.size || node.mime !== node.blob.type ||
        !FILE_TYPES.has(node.mime) || node.size > FINDER_FILE_LIMIT) return corrupt();
      total += node.size;
    }
    ids.add(node.id);
    if (node.trashedAt === null) {
      const key = JSON.stringify([node.parentId, node.name]);
      if (siblings.has(key)) return corrupt();
      siblings.add(key);
    } else if (node.originalParentId === undefined) return corrupt();
  }
  if (total > FINDER_TOTAL_LIMIT) return corrupt();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const id of SYSTEM_FOLDERS) {
    const node = byId.get(id);
    if (!node || node.kind !== 'folder' || node.parentId !== (id === 'home' ? null : 'home') || node.trashedAt !== null) return corrupt();
  }
  for (const node of nodes) {
    if (node.id !== 'home' && (!node.parentId || byId.get(node.parentId)?.kind !== 'folder')) return corrupt();
    if (finderPath(nodes, node.id).length === 0) return corrupt();
  }
}

export async function validateFinderImports(files: File[]): Promise<void> {
  let total = 0;
  for (const file of files) {
    finderName(file.name);
    if (!FILE_TYPES.has(file.type)) {
      throw new Error(`"${file.name}": only plain text, PNG, JPEG, WebP and GIF files are supported. SVG, HTML and binary files are not allowed.`);
    }
    if (file.size > FINDER_FILE_LIMIT) throw new Error(`"${file.name}" exceeds the 5 MiB per-file limit.`);
    total += file.size;
  }
  if (total > FINDER_TOTAL_LIMIT) throw new Error('These files exceed the 25 MiB total limit, including Trash.');
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (file.type === 'text/plain') {
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`"${file.name}" is not valid UTF-8 plain text. Binary files are not allowed.`); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text) || /<\s*(?:!doctype\s+html|html|head|body|script|svg|iframe|object|embed)\b/i.test(text)) {
        throw new Error(`"${file.name}" contains binary, HTML or SVG content. Import plain text only.`);
      }
    } else {
      const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
      const valid = file.type === 'image/png' ? starts(137, 80, 78, 71, 13, 10, 26, 10) :
        file.type === 'image/jpeg' ? starts(255, 216, 255) :
          file.type === 'image/gif' ? starts(71, 73, 70, 56) && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97 :
            starts(82, 73, 70, 70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
      if (!valid) throw new Error(`"${file.name}" does not match its image type. SVG, HTML and binary files are not allowed.`);
    }
  }
}

function requiredNode(nodes: FinderNode[], id: string): FinderNode {
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error('An item is no longer available. Select the files again.');
  return node;
}

export function finderCopyRoots(nodes: FinderNode[], ids: string[]): FinderNode[] {
  if (ids.length === 0) throw new Error('Select at least one item to copy.');
  for (const id of ids) {
    const node = requiredNode(nodes, id);
    if (isProtected(id)) throw new Error('System folders cannot be copied, renamed, trashed or deleted.');
    if (isTrashed(node, nodes)) throw new Error('A copied item is in Trash or no longer available. Select the files again.');
  }
  return selectedRoots(nodes, ids);
}

function selectedRoots(nodes: FinderNode[], ids: string[]): FinderNode[] {
  const selected = new Set(ids);
  return [...selected].map((id) => requiredNode(nodes, id)).filter((node) =>
    !finderPath(nodes, node.id).slice(0, -1).some((ancestor) => selected.has(ancestor.id)));
}

export type FinderCommand =
  | { type: 'createFolder'; parentId: string; name: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'addFiles'; parentId: string; files: File[] }
  | { type: 'paste'; parentId: string; ids: string[] }
  | { type: 'trash' | 'restore' | 'remove'; ids: string[] }
  | { type: 'emptyTrash' };

export function applyFinderCommand(source: FinderNode[], command: FinderCommand, now = Date.now()): { nodes: FinderNode[]; ids: string[] } {
  let nodes = source.map((node) => ({ ...node }));
  const ids: string[] = [];
  const newId = () => {
    let id: string;
    do { id = crypto.randomUUID(); } while (nodes.some((node) => node.id === id));
    return id;
  };
  const destination = (id: string) => {
    const node = requiredNode(nodes, id);
    if (node.kind !== 'folder' || isTrashed(node, nodes)) throw new Error('Choose an available folder outside Trash.');
    return node;
  };
  const mutable = (id: string) => {
    const node = requiredNode(nodes, id);
    if (isProtected(id)) throw new Error('System folders cannot be copied, renamed, trashed or deleted.');
    return node;
  };
  if (command.type === 'createFolder' || command.type === 'addFiles') {
    destination(command.parentId);
    const entries = command.type === 'createFolder' ? [{ name: command.name, blob: null }] :
      command.files.map((file) => ({ name: file.name, blob: file as Blob }));
    for (const entry of entries) {
      const kind = entry.blob === null ? 'folder' : 'file';
      const requested = finderName(entry.name);
      let name: string;
      if (command.type === 'createFolder') {
        if (nodes.some((node) => node.parentId === command.parentId && node.trashedAt === null && node.name === requested)) {
          throw new Error(`An item named "${requested}" already exists in this folder.`);
        }
        name = requested;
      } else {
        name = uniqueName(nodes, command.parentId, requested, kind);
      }
      const id = newId();
      nodes.push({
        id, parentId: command.parentId, name, kind,
        mime: entry.blob?.type ?? '', size: entry.blob?.size ?? 0, createdAt: now, updatedAt: now,
        trashedAt: null, blob: entry.blob,
      });
      ids.push(id);
    }
  } else if (command.type === 'rename') {
    const node = mutable(command.id);
    if (isTrashed(node, nodes)) throw new Error('Restore this item before renaming it.');
    const requested = finderName(command.name);
    if (nodes.some((item) => item.id !== node.id && item.parentId === node.parentId && item.trashedAt === null && item.name === requested)) {
      throw new Error(`An item named "${requested}" already exists in this folder.`);
    }
    node.name = requested;
    node.updatedAt = now;
  } else if (command.type === 'paste') {
    destination(command.parentId);
    const roots = finderCopyRoots(nodes, command.ids);
    for (const root of roots) {
      if (finderPath(nodes, command.parentId).some((node) => node.id === root.id)) {
        throw new Error('A folder cannot be copied into itself or one of its descendants.');
      }
    }
    const originals = nodes.slice();
    for (const root of roots) {
      const members = originals.filter((node) => !isTrashed(node, originals) && finderPath(originals, node.id).some((ancestor) => ancestor.id === root.id));
      const clones = new Map(members.map((node) => [node.id, newId()]));
      for (const member of members) {
        const id = clones.get(member.id)!;
        const data = { ...member };
        delete data.originalParentId;
        nodes.push({
          ...data, id, parentId: member.id === root.id ? command.parentId : clones.get(member.parentId!)!,
          name: member.id === root.id ? uniqueName(nodes, command.parentId, member.name, member.kind) : member.name,
          createdAt: now, updatedAt: now, trashedAt: null,
        });
      }
      ids.push(clones.get(root.id)!);
    }
  } else if (command.type === 'emptyTrash') {
    nodes = nodes.filter((node) => !isTrashed(node, source));
  } else {
    for (const id of command.ids) mutable(id);
    if (command.type === 'trash') {
      for (const node of selectedRoots(nodes, command.ids)) {
        if (isTrashed(node, nodes)) throw new Error('This item is already in Trash.');
        node.originalParentId = node.parentId;
        node.trashedAt = now;
        node.updatedAt = now;
      }
    } else if (command.type === 'restore') {
      const roots = command.ids.map((id) => {
        const node = requiredNode(nodes, id);
        if (!isTrashed(node, nodes)) throw new Error('Only items in Trash can be restored.');
        return finderPath(nodes, id).find((ancestor) => ancestor.trashedAt !== null)!.id;
      });
      for (const node of selectedRoots(nodes, roots)) {
        const parent = nodes.find((item) => item.id === node.originalParentId);
        const parentId = parent?.kind === 'folder' && !isTrashed(parent, nodes) &&
          !finderPath(nodes, parent.id).some((ancestor) => ancestor.id === node.id) ? parent.id : 'home';
        node.name = uniqueName(nodes, parentId, node.name, node.kind, node.id);
        node.parentId = parentId;
        node.trashedAt = null;
        node.updatedAt = now;
        delete node.originalParentId;
      }
    } else {
      const roots = selectedRoots(nodes, command.ids);
      for (const node of roots) {
        if (!isTrashed(node, nodes)) throw new Error('Only items in Trash can be permanently deleted.');
      }
      const removed = new Set(roots.map((node) => node.id));
      nodes = nodes.filter((node) => !finderPath(nodes, node.id).some((ancestor) => removed.has(ancestor.id)));
    }
  }
  const total = nodes.reduce((sum, node) => sum + node.size, 0);
  if (nodes.some((node) => node.size > FINDER_FILE_LIMIT)) throw new Error('A file exceeds the 5 MiB per-file limit.');
  if (total > FINDER_TOTAL_LIMIT) throw new Error('Finder is limited to 25 MiB, including Trash. Permanently delete unwanted files to free space.');
  return { nodes, ids };
}

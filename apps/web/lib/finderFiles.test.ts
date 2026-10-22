import { describe, expect, it } from 'vitest';
import {
  FINDER_FILE_LIMIT,
  FINDER_TOTAL_LIMIT,
  applyFinderCommand,
  finderCopyRoots,
  finderName,
  finderPath,
  isTrashed,
  seedFinderNodes,
  validateFinderImports,
  validateFinderNodes,
  type FinderCommand,
  type FinderNode,
} from './finderFiles';

const NOW = 1_700_000_000_000;

function text(name: string, content = 'hello'): File {
  return new File([content], name, { type: 'text/plain' });
}

function run(nodes: FinderNode[], command: FinderCommand, now = NOW) {
  return applyFinderCommand(nodes, command, now);
}

function children(nodes: FinderNode[], parentId: string, includeTrashed = false): FinderNode[] {
  return nodes.filter((node) => node.parentId === parentId && (includeTrashed || !isTrashed(node, nodes)));
}

describe('finder filesystem', () => {
  it('seeds a valid home with the protected locations and a welcome file', () => {
    const nodes = seedFinderNodes(NOW);
    expect(() => validateFinderNodes(nodes)).not.toThrow();
    expect(finderPath(nodes, 'welcome').map((node) => node.name)).toEqual(['Home', 'Documents', 'Welcome.txt']);
    expect(nodes.find((node) => node.id === 'home')?.parentId).toBeNull();
    expect(nodes.find((node) => node.id === 'documents')?.parentId).toBe('home');
    expect(nodes.find((node) => node.id === 'welcome')?.blob instanceof Blob).toBe(true);
  });

  it('trims names and rejects slashes, controls, dots and overlong names', () => {
    expect(finderName('  Note.txt ')).toBe('Note.txt');
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'bad\u0000name', 'x'.repeat(121)]) {
      expect(() => finderName(name)).toThrow();
    }
  });

  it('creates folders and rejects duplicate names instead of overwriting', () => {
    const first = run(seedFinderNodes(NOW), { type: 'createFolder', parentId: 'documents', name: 'Notes' });
    expect(children(first.nodes, 'documents').map((node) => node.name)).toContain('Notes');
    expect(() => run(first.nodes, { type: 'createFolder', parentId: 'documents', name: 'Notes' }, NOW + 1)).toThrow(/already exists/);
    expect(() => run(first.nodes, { type: 'rename', id: first.ids[0], name: 'Welcome.txt' })).toThrow(/already exists/);
    expect(() => validateFinderNodes(first.nodes)).not.toThrow();
  });

  it('suffixes duplicate names when importing files', () => {
    const added = run(seedFinderNodes(NOW), { type: 'addFiles', parentId: 'documents', files: [text('Note.txt'), text('Note.txt')] });
    expect(children(added.nodes, 'documents').map((node) => node.name)).toContain('Note copy.txt');
    expect(() => validateFinderNodes(added.nodes)).not.toThrow();
  });

  it('adds files and pastes copies into the chosen folder', () => {
    const added = run(seedFinderNodes(NOW), { type: 'addFiles', parentId: 'documents', files: [text('Note.txt', 'first')] });
    const note = added.nodes.find((node) => node.id === added.ids[0])!;
    const pasted = run(added.nodes, { type: 'paste', parentId: 'documents', ids: [note.id] }, NOW + 2);
    const copy = pasted.nodes.find((node) => node.id === pasted.ids[0])!;
    expect(copy.name).toBe('Note copy.txt');
    expect(copy.id).not.toBe(note.id);
    expect(copy.blob).toBe(note.blob);
    expect(pasted.nodes.filter((node) => node.parentId === 'documents' && node.kind === 'file').map((node) => node.name).sort()).toEqual(['Note copy.txt', 'Note.txt', 'Welcome.txt']);
  });

  it('prunes nested selections and refuses to paste a folder into its descendant', () => {
    const created = run(seedFinderNodes(NOW), { type: 'createFolder', parentId: 'documents', name: 'Project' });
    const folderId = created.ids[0];
    const added = run(created.nodes, { type: 'addFiles', parentId: folderId, files: [text('Inside.txt')] });
    const childId = added.ids[0];
    expect(finderCopyRoots(added.nodes, [folderId, childId]).map((node) => node.id)).toEqual([folderId]);
    expect(() => run(added.nodes, { type: 'paste', parentId: folderId, ids: [folderId] })).toThrow(/cannot be copied into itself/);
    const pasted = run(added.nodes, { type: 'paste', parentId: 'home', ids: [folderId, childId] });
    expect(pasted.ids).toHaveLength(1);
    expect(pasted.nodes.find((node) => node.id === pasted.ids[0])?.name).toBe('Project');
    expect(pasted.nodes.some((node) => node.parentId === pasted.ids[0] && node.name === 'Inside.txt')).toBe(true);
  });

  it('protects system folders from copying and trashing', () => {
    const nodes = seedFinderNodes(NOW);
    expect(() => finderCopyRoots(nodes, ['documents'])).toThrow(/System folders/);
    expect(() => run(nodes, { type: 'trash', ids: ['documents'] })).toThrow(/System folders/);
    expect(() => run(nodes, { type: 'rename', id: 'home', name: 'Other' })).toThrow(/System folders/);
  });

  it('trashes roots, restores them with their descendants and avoids name collisions', () => {
    const created = run(seedFinderNodes(NOW), { type: 'createFolder', parentId: 'documents', name: 'Draft' });
    const folderId = created.ids[0];
    const added = run(created.nodes, { type: 'addFiles', parentId: folderId, files: [text('Plan.txt')] });
    const childId = added.ids[0];
    const trashed = run(added.nodes, { type: 'trash', ids: [folderId] }, NOW + 3);
    const folder = trashed.nodes.find((node) => node.id === folderId)!;
    const child = trashed.nodes.find((node) => node.id === childId)!;
    expect(folder.trashedAt).toBe(NOW + 3);
    expect(folder.originalParentId).toBe('documents');
    expect(child.trashedAt).toBeNull();
    expect(isTrashed(child, trashed.nodes)).toBe(true);
    expect(() => run(trashed.nodes, { type: 'trash', ids: [childId] })).toThrow(/already in Trash/);

    const restored = run(trashed.nodes, { type: 'restore', ids: [childId] }, NOW + 4);
    const restoredFolder = restored.nodes.find((node) => node.id === folderId)!;
    expect(restoredFolder.trashedAt).toBeNull();
    expect(restoredFolder.originalParentId).toBeUndefined();
    expect(isTrashed(restored.nodes.find((node) => node.id === childId)!, restored.nodes)).toBe(false);
    expect(finderPath(restored.nodes, childId).map((node) => node.name)).toEqual(['Home', 'Documents', 'Draft', 'Plan.txt']);

    const trashedAgain = run(restored.nodes, { type: 'trash', ids: [folderId] });
    const replacement = run(trashedAgain.nodes, { type: 'createFolder', parentId: 'documents', name: 'Draft' });
    const renamed = run(replacement.nodes, { type: 'restore', ids: [folderId] });
    expect(renamed.nodes.find((node) => node.id === folderId)?.name).toBe('Draft copy');
  });

  it('only permanently deletes items that are already in Trash', () => {
    const created = run(seedFinderNodes(NOW), { type: 'createFolder', parentId: 'documents', name: 'Gone' });
    const folderId = created.ids[0];
    const added = run(created.nodes, { type: 'addFiles', parentId: folderId, files: [text('Child.txt')] });
    const childId = added.ids[0];
    expect(() => run(added.nodes, { type: 'remove', ids: [folderId] })).toThrow(/Only items in Trash/);
    const trashed = run(added.nodes, { type: 'trash', ids: [folderId] });
    const removed = run(trashed.nodes, { type: 'remove', ids: [folderId] });
    expect(removed.nodes.some((node) => node.id === folderId || node.id === childId)).toBe(false);
    expect(removed.nodes.some((node) => node.id === 'documents')).toBe(true);

    const trashAgain = run(added.nodes, { type: 'trash', ids: [folderId] });
    const emptied = run(trashAgain.nodes, { type: 'emptyTrash' });
    expect(emptied.nodes.some((node) => node.id === folderId || node.id === childId)).toBe(false);
    expect(emptied.nodes.some((node) => node.id === 'welcome')).toBe(true);
  });

  it('rejects files above the per-file limit and folders above the total budget', () => {
    const oversized = new File([new Uint8Array(FINDER_FILE_LIMIT + 1)], 'big.txt', { type: 'text/plain' });
    expect(() => run(seedFinderNodes(NOW), { type: 'addFiles', parentId: 'documents', files: [oversized] })).toThrow(/5 MiB/);
    const images = Array.from({ length: 5 }, (_, index) => new File([new Uint8Array(FINDER_FILE_LIMIT)], `image-${index}.png`, { type: 'image/png' }));
    expect(FINDER_FILE_LIMIT * images.length).toBeGreaterThanOrEqual(FINDER_TOTAL_LIMIT);
    expect(() => run(seedFinderNodes(NOW), { type: 'addFiles', parentId: 'images', files: images })).toThrow(/25 MiB/);
  });

  it('validates imported text and image signatures', async () => {
    await expect(validateFinderImports([text('Note.txt', 'plain text')])).resolves.toBeUndefined();
    await expect(validateFinderImports([new File(['<script>alert(1)</script>'], 'page.txt', { type: 'text/plain' })])).rejects.toThrow(/HTML or SVG/);
    await expect(validateFinderImports([new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' })])).rejects.toThrow(/only plain text/);
    await expect(validateFinderImports([new File(['not a png'], 'fake.png', { type: 'image/png' })])).rejects.toThrow(/does not match/);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await expect(validateFinderImports([new File([png], 'real.png', { type: 'image/png' })])).resolves.toBeUndefined();
  });

  it('refuses corrupt snapshots instead of replacing them', () => {
    const missingHome = seedFinderNodes(NOW).filter((node) => node.id !== 'home');
    expect(() => validateFinderNodes(missingHome)).toThrow(/corrupt/);
    const duplicate = seedFinderNodes(NOW);
    duplicate.push({
      id: 'duplicate', parentId: 'documents', name: 'Welcome.txt', kind: 'folder', mime: '', size: 0,
      createdAt: NOW, updatedAt: NOW, trashedAt: null, blob: null,
    });
    expect(() => validateFinderNodes(duplicate)).toThrow(/corrupt/);
    const badTrash = seedFinderNodes(NOW);
    badTrash.find((node) => node.id === 'welcome')!.trashedAt = NOW;
    expect(() => validateFinderNodes(badTrash)).toThrow(/corrupt/);
  });
});

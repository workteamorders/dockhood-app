import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindows } from './windows';

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

let width = 1280;
let height = 768;

beforeEach(() => {
  width = 1280;
  height = 768;
  vi.stubGlobal('window', { innerWidth: width, innerHeight: 900 });
  vi.stubGlobal('document', { querySelector: () => ({ getBoundingClientRect: () => ({ width, height }) }) });
  useWindows.setState({ windows: [], activeId: null, topZ: 10 });
});

afterEach(() => vi.unstubAllGlobals());

describe('desktop window bounds', () => {
  it('centers a new window within the workspace, excluding the menu bar and Dock', () => {
    useWindows.getState().open({ appId: 'welcome', title: 'Welcome to Dockhood', w: 660, h: 600 });
    expect(useWindows.getState().windows[0]).toMatchObject({ x: 310, y: 84, w: 660, h: 600 });
  });

  it('keeps an existing window reachable after the workspace shrinks', () => {
    const id = useWindows.getState().open({ appId: 'welcome', title: 'Welcome to Dockhood', w: 660, h: 600 });
    width = 756;
    height = 337;
    useWindows.getState().resize(id, 660, 600);
    const win = useWindows.getState().windows[0];
    expect(win.w).toBe(660);
    expect(win.h).toBe(329);
    expect(win.x + win.w).toBeLessThanOrEqual(width - 4);
    expect(win.y + win.h).toBeLessThanOrEqual(height - 4);
  });

  it('corrects position even when dimensions are unchanged and restores a minimized window', () => {
    const id = useWindows.getState().open({ appId: 'explore', title: 'Explore', w: 660, h: 600 });
    useWindows.getState().move(id, 1000, 1000);
    useWindows.getState().resize(id, 660, 600);
    expect(useWindows.getState().windows[0]).toMatchObject({ x: 616, y: 164, w: 660, h: 600 });
    useWindows.getState().minimize(id);
    expect(useWindows.getState().activeId).toBeNull();
    useWindows.getState().toggleFromTaskbar(id);
    expect(useWindows.getState().activeId).toBe(id);
    expect(useWindows.getState().windows[0].minimized).toBe(false);
  });
});

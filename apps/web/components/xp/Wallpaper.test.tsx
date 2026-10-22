import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wallpaper } from './Wallpaper';

const hooks = vi.hoisted(() => ({
  root: null as unknown,
  effects: [] as (() => void | (() => void))[],
}));

// Exercise the effect lifecycle without adding a DOM environment dependency.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useRef: () => ({ current: hooks.root }),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));

class Surface extends EventTarget {
  parentElement: Surface | null = null;
  isConnected = true;
  inert = false;
  dataset: Record<string, string> = {};
  properties = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    removeProperty: (name: string) => this.properties.delete(name),
  };
  closest(selector: string): Surface | null {
    if (selector === '[data-desktop]') return this.parentElement;
    return this.inert ? this : this.parentElement?.closest(selector) ?? null;
  }
  contains(node: unknown): boolean {
    return node === this || node instanceof Surface && this.contains(node.parentElement);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 }; }
}

class Media extends EventTarget {
  matches = false;
  change(matches: boolean) { this.matches = matches; this.dispatchEvent(new Event('change')); }
}

let browser: EventTarget & { requestAnimationFrame: ReturnType<typeof vi.fn>; cancelAnimationFrame: ReturnType<typeof vi.fn> };
let page: EventTarget & { hidden: boolean };
let reduced: Media;
let coarse: Media;
let frames: Map<number, FrameRequestCallback>;
let observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[];
let cleanups: (() => void)[];

function mount(interactive = true) {
  const desktop = new Surface();
  const root = new Surface();
  root.parentElement = desktop;
  hooks.root = root;
  hooks.effects = [];
  const html = renderToStaticMarkup(<Wallpaper interactive={interactive} />);
  const cleanup = hooks.effects[0]() ?? (() => {});
  cleanups.push(cleanup);
  return { root, desktop, html, cleanup };
}

function step(time: number) {
  const pending = [...frames];
  frames.clear();
  for (const [, callback] of pending) callback(time);
}

function pointer(type: string, target: Surface, relatedTarget: Surface | null = null) {
  const event = new Event(type);
  Object.defineProperties(event, {
    target: { value: target }, relatedTarget: { value: relatedTarget },
    pointerType: { value: 'mouse' }, clientX: { value: 1120 }, clientY: { value: 180 },
  });
  browser.dispatchEvent(event);
}

beforeEach(() => {
  frames = new Map();
  observers = [];
  cleanups = [];
  reduced = new Media();
  coarse = new Media();
  page = Object.assign(new EventTarget(), { hidden: false });
  let nextFrame = 0;
  browser = Object.assign(new EventTarget(), {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }),
    cancelAnimationFrame: vi.fn((id: number) => { frames.delete(id); }),
    matchMedia: (query: string) => query.includes('reduced-motion') ? reduced : coarse,
  });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', page);
  vi.stubGlobal('Node', Surface);
  vi.stubGlobal('Element', Surface);
  vi.stubGlobal('MutationObserver', class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(notify: () => void) { observers.push({ notify, disconnect: this.disconnect }); }
  });
});

afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  vi.unstubAllGlobals();
});

describe('Liquid Sunset wallpaper', () => {
  it('renders decorative static SVG by default, with unique paint IDs and no masking WebP', () => {
    hooks.effects = [];
    const html = renderToStaticMarkup(<><Wallpaper /><Wallpaper /></>);
    for (const effect of hooks.effects) effect();
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const paints = [...html.matchAll(/url\(#([^\)]+)\)/g)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(paints.every((id) => ids.includes(id))).toBe(true);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain('wallpaper.webp');
    expect(browser.requestAnimationFrame).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
  });

  it.each(['reduced', 'coarse', 'hidden'] as const)('does not schedule at startup when %s', (condition) => {
    if (condition === 'reduced') reduced.matches = true;
    if (condition === 'coarse') coarse.matches = true;
    if (condition === 'hidden') page.hidden = true;
    mount();
    expect(frames.size).toBe(0);
  });

  it('cancels and resets on dynamic media changes, visibility and inert desktop changes', () => {
    const { root, desktop } = mount();
    step(0);
    step(1000);
    expect(root.properties.size).toBeGreaterThan(0);
    reduced.change(true);
    expect(browser.cancelAnimationFrame).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(root.properties.size).toBe(0);
    expect(root.dataset.moving).toBeUndefined();
    reduced.change(false);
    expect(frames.size).toBe(1);
    coarse.change(true);
    expect(frames.size).toBe(0);
    coarse.change(false);
    page.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(1);
    desktop.inert = true;
    observers[0].notify();
    expect(frames.size).toBe(0);
    desktop.inert = false;
    observers[0].notify();
    expect(frames.size).toBe(1);
  });

  it('follows desktop pointers through CSS variables and settles to neutral on exit or portal events', () => {
    const { root } = mount();
    step(0);
    pointer('pointermove', root);
    step(64);
    expect(parseFloat(root.properties.get('--pointer-x')!)).toBeGreaterThan(0);
    expect(parseFloat(root.properties.get('--glow-opacity')!)).toBeGreaterThan(0);
    const outside = new Surface();
    pointer('pointermove', outside);
    for (let time = 128; time <= 2560; time += 64) step(time);
    expect(parseFloat(root.properties.get('--pointer-x')!)).toBeCloseTo(0, 3);
    expect(root.properties.get('--glow-opacity')).toBe('0.000');
    pointer('pointermove', root);
    step(2624);
    pointer('pointerout', root);
    for (let time = 2688; time <= 5120; time += 64) step(time);
    expect(parseFloat(root.properties.get('--pointer-y')!)).toBeCloseTo(0, 3);
  });

  it('keeps one owner, hands off on unmount, and preserves the remaining visibility listener', () => {
    const first = mount();
    const second = mount();
    expect(frames.size).toBe(1);
    expect(first.root.dataset.moving).toBe('');
    expect(second.root.dataset.moving).toBeUndefined();
    first.cleanup();
    cleanups.splice(cleanups.indexOf(first.cleanup), 1);
    expect(frames.size).toBe(1);
    expect(second.root.dataset.moving).toBe('');
    page.hidden = true;
    page.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
  });

  it('cancels RAF and detaches observers/listeners when disabled or unmounted', () => {
    const active = mount();
    active.cleanup();
    cleanups.splice(cleanups.indexOf(active.cleanup), 1);
    mount(false);
    expect(frames.size).toBe(0);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    const requests = browser.requestAnimationFrame.mock.calls.length;
    reduced.change(false);
    page.dispatchEvent(new Event('visibilitychange'));
    pointer('pointermove', active.root);
    expect(browser.requestAnimationFrame).toHaveBeenCalledTimes(requests);
    expect(active.root.properties.size).toBe(0);
  });
});

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@tanstack/react-query';
import { fetchTokens, type TokenItem } from '@/lib/api';
import { DesktopWidgets } from './DesktopWidgets';

const state = vi.hoisted(() => ({
  wide: true,
  query: { data: undefined as { items: TokenItem[] } | undefined, isPending: false, isFetching: false, isError: false, dataUpdatedAt: 0, refetch: vi.fn() },
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot.name === 'wideSnapshot' ? state.wide : new Date('2026-10-22T08:30:00Z').getTime(),
}));
vi.mock('react-dom', () => ({ createPortal: (children: ReactNode) => children }));
vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn(() => state.query) }));
vi.mock('@/components/xp/Dialog', () => ({ useModalFocus: vi.fn() }));
vi.mock('@/lib/api', () => ({ fetchTokens: vi.fn() }));
vi.mock('@/lib/hoodToken', () => ({ displayTicker: (_address: string, symbol: string) => symbol }));
vi.mock('@/lib/openApp', () => ({ openApp: vi.fn(), openToken: vi.fn() }));

const token: TokenItem = {
  token: '0x1111111111111111111111111111111111111111', curve: '', name: 'Sunrise', symbol: 'SUN', logo: '',
  pair: { address: '', symbol: 'ETH', decimals: 18 }, hood: true, formal: false, phase: 0,
  statement: null, blurb: null, rigorScore: null, price: 0.25, marketCap: null, progress: null,
  volume24h: null, trades24h: null, launchedAt: '', stateUpdatedAt: null,
};
const onClose = vi.fn();
const render = (props: Partial<Parameters<typeof DesktopWidgets>[0]> = {}) => renderToStaticMarkup(<DesktopWidgets open={false} onClose={onClose} {...props} />);

beforeEach(() => {
  vi.clearAllMocks();
  state.wide = true;
  Object.assign(state.query, { data: undefined, isPending: false, isFetching: false, isError: false, dataUpdatedAt: 0 });
  vi.stubGlobal('document', { body: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('desktop widgets', () => {
  it('renders local time and actual pair-denominated token prices without fabricated statistics', () => {
    state.query.data = { items: [token] };
    const html = render();
    expect(html).toContain('Local time and date');
    expect(html).toContain('Market watch');
    expect(html).toContain('0.25 ETH');
    expect(html).toContain('SUN');
    expect(html).not.toContain('USD');
    expect(html).not.toContain('gainers');
  });

  it('does not mount or poll hidden widgets on small screens or behind a maximized window', () => {
    state.wide = false;
    expect(render()).toBe('');
    state.wide = true;
    expect(render({ covered: true })).toBe('');
    expect(useQuery).not.toHaveBeenCalled();
  });

  it('opens an accessible widget dialog on small screens even when the desktop is covered', () => {
    state.wide = false;
    const html = render({ open: true, covered: true });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Close widgets');
    expect(html).toContain('Market watch');
  });

  it('distinguishes loading, empty, failed and unavailable prices', () => {
    state.query.isPending = true;
    expect(render()).toContain('Loading latest tokens');
    state.query.isPending = false;
    state.query.data = { items: [] };
    expect(render()).toContain('No tokens indexed yet');
    state.query.data = undefined;
    state.query.isError = true;
    expect(render()).toContain('Market data is unavailable');
    state.query.data = { items: [{ ...token, price: null }] };
    expect(render()).toContain('Unavailable');
    expect(render()).not.toContain('0 ETH');
  });

  it('preserves cached tokens when background refresh fails', () => {
    state.query.data = { items: [token] };
    state.query.isError = true;
    const html = render();
    expect(html).toContain('SUN');
    expect(html).toContain('Showing last update');
    expect(html).not.toContain('Taking a little breather');
  });

  it('uses an isolated page cache and refreshes at 30s without background polling', async () => {
    render();
    const options = vi.mocked(useQuery).mock.calls[0][0];
    expect(options).toMatchObject({ queryKey: ['desktop-market', 'all', 'latest', 3], refetchInterval: 30_000, refetchIntervalInBackground: false });
    await (options.queryFn as () => unknown)();
    expect(fetchTokens).toHaveBeenCalledWith({ tab: 'all', sort: 'latest', limit: 3, offset: 0 });
  });

});

'use client';

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Address } from 'viem';
import { Button } from '@/components/xp/Button';
import { ConnectWallet } from '@/components/xp/ConnectWallet';
import { Dialog } from '@/components/xp/Dialog';
import { ApiError, fetchCallouts, fetchSession, postCallout, reactToCallout, setNickname, type Callout, type CalloutPage, type ReactionKind } from '@/lib/api';
import { track } from '@/lib/analytics';
import { useIdentity } from '@/lib/identity';
import { displayTicker } from '@/lib/hoodToken';
import { onLive, startLive } from '@/lib/live';
import { ensureSession } from '@/lib/siwe';
import { txErrorMessage } from '@/lib/pons/launch';
import { CalloutItem } from './CalloutItem';
import styles from './Callouts.module.css';

const MAX = 180;
const FLASH_MS = 2_000;

type Pages = InfiniteData<CalloutPage, string | undefined>;

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : txErrorMessage(e));

/**
 * The callout feed (docs/BRIEF.md §5.5): newest first, infinite scroll, live additions that flash yellow,
 * reactions, and a 180-character compose box. With `token`, only callouts about that coin.
 */
export function CalloutFeed({ token, ticker, onLiveCounts }: { token?: string; ticker?: string; onLiveCounts?: (live: CalloutPage['live']) => void }) {
  const queryClient = useQueryClient();
  const key = ['callouts', token?.toLowerCase() ?? 'all'] as const;
  const { address, connected } = useIdentity();
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchCallouts({ before: pageParam, token }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 60_000,
  });

  const live = q.data?.pages[0]?.live;
  useEffect(() => {
    if (live && onLiveCounts) onLiveCounts(live);
  }, [live, onLiveCounts]);

  // Live: new callouts go on top (once), reaction counts update wherever the callout is.
  useEffect(() => {
    const stop = startLive();
    const off = onLive((e) => {
      if (e.type === 'activity') return;
      queryClient.setQueryData<Pages>(key, (data) => {
        if (!data) return data;
        if (e.type === 'reactions') {
          return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === e.id ? { ...c, reactions: e.reactions } : c)) })) };
        }
        const c = e.callout;
        if (token && c.tokenAddress?.toLowerCase() !== token.toLowerCase()) return data;
        if (data.pages.some((p) => p.items.some((x) => x.id === c.id))) return data;
        const [first, ...rest] = data.pages;
        return { ...data, pages: [{ ...first, items: [c, ...first.items], live: { ...first.live, callouts: first.live.callouts + 1 } }, ...rest] };
      });
      if (e.type === 'callout') {
        setFlash((s) => new Set(s).add(e.callout.id));
        setTimeout(() => setFlash((s) => ((s = new Set(s)), s.delete(e.callout.id), s)), FLASH_MS);
      }
    });
    return () => {
      off();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is derived from `token`
  }, [token, queryClient]);

  // Infinite scroll: load older pages as the sentinel comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [q]);

  const patch = (id: string, fn: (c: Callout) => Callout) =>
    queryClient.setQueryData<Pages>(key, (data) => data && { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((c) => (c.id === id ? fn(c) : c)) })) });

  async function react(c: Callout, kind: ReactionKind) {
    if (!connected || !address) return setNotice({ kind: 'info', text: 'Connect a wallet to react.' });
    try {
      await ensureSession(address as Address);
      const r = await reactToCallout(c.id, kind);
      patch(c.id, (x) => ({ ...x, reactions: r.reactions, mine: r.reacted ? [...(x.mine ?? []), kind] : (x.mine ?? []).filter((k) => k !== kind) }));
    } catch (e) {
      setNotice({ kind: 'error', text: errorText(e) });
    }
  }

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={styles.feed}>
      <ul className={styles.list} aria-live="polite">
        {q.isPending && <li className={styles.empty}>Loading callouts…</li>}
        {q.isError && <li className={styles.empty}>{errorText(q.error)}</li>}
        {!q.isPending && !q.isError && items.length === 0 && (
          <li className={styles.empty}>{ticker ? `No callouts for $${displayTicker(token, ticker)} yet. Post one →` : 'No callouts yet. Be the first.'}</li>
        )}
        {items.map((c) => (
          <CalloutItem key={c.id} callout={c} flash={flash.has(c.id)} onReact={(k) => void react(c, k)} />
        ))}
        <div ref={sentinel} className={styles.sentinel}>
          {q.isFetchingNextPage && 'Loading older callouts…'}
        </div>
      </ul>
      {notice && (
        <p className={notice.kind === 'error' ? styles.error : styles.info} role="status">
          {notice.text}
        </p>
      )}
      <Compose token={token} ticker={ticker} onPosted={(c, hidden) => {
        if (hidden) return setNotice({ kind: 'info', text: 'Held for review: it will show once a moderator allows it.' });
        setNotice(null);
        queryClient.setQueryData<Pages>(key, (data) => {
          if (!data || data.pages.some((p) => p.items.some((x) => x.id === c.id))) return data;
          const [first, ...rest] = data.pages;
          return { ...data, pages: [{ ...first, items: [c, ...first.items] }, ...rest] };
        });
      }} onError={(text) => setNotice({ kind: 'error', text })} />
    </div>
  );
}

function Compose({ token, ticker, onPosted, onError }: { token?: string; ticker?: string; onPosted: (c: Callout, hidden: boolean) => void; onError: (text: string) => void }) {
  const { address, connected, label } = useIdentity();
  const [text, setText] = useState(ticker ? `$${ticker} ` : '');
  const [busy, setBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const session = useQuery({ queryKey: ['session', address], queryFn: fetchSession, enabled: connected, staleTime: 60_000 });

  if (!connected || !address) {
    return (
      <div className={styles.compose}>
        <span className={styles.muted}>Connect a wallet to post callouts.</span>
        <ConnectWallet />
      </div>
    );
  }

  async function submit() {
    setBusy(true);
    try {
      await ensureSession(address as Address);
      const r = await postCallout(text, token);
      onPosted(r.callout, r.hidden);
      track('callout_posted', { hidden: r.hidden, with_ticker: token != null });
      setText(ticker ? `$${ticker} ` : '');
      void session.refetch();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const over = text.length > MAX;
  return (
    <div className={styles.compose}>
      <textarea
        rows={2}
        value={text}
        maxLength={MAX + 40}
        placeholder={ticker ? `Your call on $${displayTicker(token, ticker)}…` : 'Your call… mention a $TICKER to link it'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && !over && !busy) void submit();
        }}
        aria-label="Write a callout"
      />
      <div className={styles.composeBar}>
        <button type="button" className={styles.linkish} onClick={() => setEditingName(true)} title="Set your nickname">
          as {session.data?.nickname ?? label}
        </button>
        <span className={over ? styles.over : styles.muted}>
          {text.length}/{MAX}
        </span>
        <Button variant="primary" disabled={busy || !text.trim() || over} onClick={() => void submit()}>
          {busy ? 'Posting…' : 'Post'}
        </Button>
      </div>
      {editingName && (
        <NicknameDialog
          address={address as Address}
          current={session.data?.nickname ?? ''}
          onClose={() => setEditingName(false)}
          onSaved={() => {
            setEditingName(false);
            void session.refetch();
          }}
        />
      )}
    </div>
  );
}

function NicknameDialog({ address, current, onClose, onSaved }: { address: Address; current: string; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[a-z0-9_]{3,15}$/.test(value);
  async function save() {
    setBusy(true);
    try {
      await ensureSession(address);
      await setNickname(value);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Nickname"
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => void save()} disabled={!valid || busy} data-autofocus>
            Save
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <label htmlFor="nickname" style={{ display: 'block', marginBottom: 4 }}>
        Shown on your callouts instead of your address. 3–15 characters: a–z, 0–9, _. Once a day.
      </label>
      <input id="nickname" type="text" value={value} maxLength={15} autoComplete="off" spellCheck={false} onChange={(e) => setValue(e.target.value.toLowerCase())} style={{ width: '100%' }} />
      {error && <p className={styles.error}>{error}</p>}
    </Dialog>
  );
}

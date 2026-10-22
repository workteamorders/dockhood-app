'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useDisconnect } from 'wagmi';
import { APPS, isAppId } from '@/components/apps/meta';
import { APP_COMPONENTS } from '@/components/apps';
import { logout } from '@/lib/api';
import { isAddress } from 'viem';
import { openApp, openToken } from '@/lib/openApp';
import { useTray } from '@/store/tray';
import { useWindows } from '@/store/windows';
import { useStartup } from '@/store/startup';
import { DesktopIcons, type DesktopItemId } from './DesktopIcons';
import { MessageBox } from './Dialog';
import { BOOT_MS, BootScreen, WELCOME_MS, WelcomeScreen } from './Boot';
import { LogOffDialog, OffScreen, ShutDownDialog } from './Power';
import { Dock } from '../mac/Dock';
import { MenuBar } from '../mac/MenuBar';
import { Launchpad } from '../mac/Launchpad';
import { DesktopWidgets } from '../mac/DesktopWidgets';
import { Balloons } from './Balloons';
import { RiskDialog } from './RiskDialog';
import { Wallpaper } from './Wallpaper';
import { Window } from './Window';
import styles from './Desktop.module.css';

type Overlay = null | 'shutdown' | 'logoff' | 'standby' | 'off' | 'boot' | 'welcome';

export function Desktop() {
  const windows = useWindows((s) => s.windows);
  const activeId = useWindows((s) => s.activeId);
  const closeAll = useWindows((s) => s.closeAll);
  const unread = useTray((s) => s.unread);
  const startupDone = useStartup((s) => s.done);
  const { disconnect } = useDisconnect();

  const [selected, setSelected] = useState<DesktopItemId | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [widgetsOpen, setWidgetsOpen] = useState(false);

  // First load: open the coin in /t/0x… or the app named in ?app=, else Welcome.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = /^\/t\/(0x[0-9a-fA-F]{40})\/?$/.exec(window.location.pathname)?.[1];
    const game = /^\/games\/(solitaire|minesweeper)\/?$/.exec(window.location.pathname)?.[1];
    const verification = /^\/verification\/?$/.test(window.location.pathname) ? 'verification' : /^\/admin\/verification\/?$/.test(window.location.pathname) ? 'verificationAdmin' : null;
    const requested = shared ? 'token' : (game ?? verification ?? params.get('app'));
    const token = shared ?? params.get('t');
    if (useWindows.getState().windows.length > 0) return;
    if (requested === 'token' && token && isAddress(token, { strict: false })) openToken(token);
    else openApp(isAppId(requested) && requested !== 'token' ? requested : 'welcome');
  }, []);

  // Keep the URL pointing at the focused window so links shared on X reopen it.
  useEffect(() => {
    const active = windows.find((w) => w.id === activeId);
    const next =
      !active || active.appId === 'welcome'
        ? '/'
        : active.appId === 'token' && active.props?.address
          ? `/t/${active.props.address}`
          : active.appId === 'solitaire' || active.appId === 'minesweeper'
            ? `/games/${active.appId}`
          : active.appId === 'verification'
            ? '/verification'
          : active.appId === 'verificationAdmin'
            ? '/admin/verification'
          : `/?app=${active.appId}`;
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(null, '', next);
  }, [windows, activeId]);

  const closeGames = useCallback(() => useWindows.getState().close('games'), []);
  const cancelOverlay = useCallback(() => setOverlay(null), []);
  const closeWidgets = useCallback(() => setWidgetsOpen(false), []);

  useEffect(() => {
    const fitWindows = () => {
      const { windows: open, resize } = useWindows.getState();
      for (const win of open) resize(win.id, win.w, win.h);
    };
    window.addEventListener('resize', fitWindows);
    return () => window.removeEventListener('resize', fitWindows);
  }, []);

  // Restart / Power On run boot → welcome → desktop; Log Off skips straight to the welcome screen.
  const startUp = useCallback(
    (withBoot: boolean) => {
      closeAll();
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const bootMs = withBoot && !reduced ? BOOT_MS : 0;
      const welcomeMs = reduced ? 300 : WELCOME_MS;
      setOverlay(bootMs ? 'boot' : 'welcome');
      window.setTimeout(() => setOverlay('welcome'), bootMs);
      window.setTimeout(() => {
        setOverlay(null);
        openApp('welcome');
      }, bootMs + welcomeMs);
    },
    [closeAll],
  );
  const boot = useCallback(() => startUp(true), [startUp]);

  const grayscale = overlay === 'shutdown' || overlay === 'logoff';
  const games = windows.find((w) => w.appId === 'games' && !w.minimized);

  return (
    <div data-desktop className={`${styles.desktop} ${grayscale ? styles.grayscale : ''}`}>
      <Wallpaper interactive={startupDone && !overlay && !games} />
      <MenuBar onLogOff={() => setOverlay('logoff')} onShutDown={() => setOverlay('shutdown')} onWidgets={() => setWidgetsOpen(true)} />
      <main
        className={styles.workspace}
        data-workspace
        aria-label="Dockhood desktop"
        inert={!!games}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
      >
        <DesktopIcons selected={selected} onSelect={setSelected} />
        {startupDone && !overlay && !games && <DesktopWidgets open={widgetsOpen} onClose={closeWidgets} covered={windows.some((win) => win.maximized && !win.minimized)} />}
        {windows.map((win) => {
          if (win.appId === 'games') return null;
          const app = APPS[win.appId];
          const Content = APP_COMPONENTS[win.appId];
          return (
            <Window
              key={win.id}
              win={win}
              active={win.id === activeId}
              icon={<app.Icon size={16} />}
              maximizable={app.maximizable !== false}
            >
              <Suspense fallback={<p className={styles.loading}>Loading…</p>}>
                <Content win={win} />
              </Suspense>
            </Window>
          );
        })}
      </main>

      {games && <Launchpad onClose={closeGames} />}
      <Dock unread={unread} />
      <Balloons />
      <RiskDialog />

      {overlay === 'shutdown' && (
        <ShutDownDialog
          onCancel={cancelOverlay}
          onStandBy={() => setOverlay('standby')}
          onTurnOff={() => {
            closeAll();
            setOverlay('off');
          }}
          onRestart={boot}
        />
      )}
      {overlay === 'logoff' && (
        <LogOffDialog
          onCancel={cancelOverlay}
          onLogOff={() => {
            // Log Off ends the SIWE session too (docs/BRIEF.md §4.4); the API may be unreachable.
            void logout().catch(() => {});
            disconnect();
            startUp(false);
          }}
        />
      )}
      {overlay === 'standby' && (
        <MessageBox title="Stand By" onClose={cancelOverlay}>
          <p>Dockhood stays on. The chain never sleeps.</p>
          <p>Close windows you aren&apos;t using, or choose Turn Off.</p>
        </MessageBox>
      )}
      {overlay === 'off' && <OffScreen onPowerOn={boot} />}
      {overlay === 'boot' && <BootScreen />}
      {overlay === 'welcome' && <WelcomeScreen />}
    </div>
  );
}

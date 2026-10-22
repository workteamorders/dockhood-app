import { Wallpaper } from './Wallpaper';
import desktop from './Desktop.module.css';

/** Server-rendered first paint while the wallet-aware desktop loads in the browser. */
export function DesktopSkeleton() {
  return (
    <div className={desktop.desktop} aria-busy="true">
      <Wallpaper />
      <span className="sr-only">Loading Dockhood desktop</span>
    </div>
  );
}

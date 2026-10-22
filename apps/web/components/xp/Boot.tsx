import { DockhoodLogo } from '../mac/AppIcon';
import { Wallpaper } from './Wallpaper';
import { Wordmark } from './Wordmark';
import styles from './Boot.module.css';

export function BootScreen() {
  return <div className={styles.boot} role="status" aria-label="Starting Dockhood"><Wallpaper/><div className={styles.mark}><DockhoodLogo size={76}/><Wordmark size={46} dark/><p>The launchpad that boots clean.</p><div className={styles.track} aria-hidden="true"><span/></div></div><span className={styles.foot}>Robinhood Chain. Powered by Pons.</span></div>;
}
export function WelcomeScreen() {
  return <div className={styles.welcome} role="status" aria-label="Opening Dockhood desktop"><Wallpaper/><DockhoodLogo size={76}/></div>;
}
export const BOOT_MS = 800;
export const WELCOME_MS = 200;

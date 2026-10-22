'use client';

import { StatusBar } from '@/components/xp/Controls';
import { TheoremIcon, WarningIcon } from '@/components/xp/Icons';
import styles from './apps.module.css';

// Features cut from v1.0 of the brief, kept here as a wink to anyone who remembers them.
const ITEMS = [
  {
    name: 'Bonding Curve Selector',
    from: 'Dockhood / Launch',
    reason: 'Pons V2 uses one curve for every coin',
    Icon: TheoremIcon,
  },
  {
    name: 'Platform fee 0.0005',
    from: 'Dockhood / Fees',
    reason: 'No platform fee at launch',
    Icon: WarningIcon,
  },
];

export function RecycleBin() {
  return (
    <>
      <div className={styles.listWrap}>
        <table className={styles.list}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Original Location</th>
              <th>Why deleted</th>
            </tr>
          </thead>
          <tbody>
            {ITEMS.map(({ name, from, reason, Icon }) => (
              <tr key={name}>
                <td>
                  <span className={styles.nameCell}>
                    <Icon size={16} /> {name}
                  </span>
                </td>
                <td>{from}</td>
                <td>{reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <StatusBar cells={[`${ITEMS.length} items`, 'Trash']} />
    </>
  );
}

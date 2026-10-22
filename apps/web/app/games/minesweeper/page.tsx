import type { Metadata } from 'next';
import { Startup } from '@/components/Startup';

export const metadata: Metadata = {
  title: 'Minesweeper | Dockhood',
  description: 'Classic Minesweeper on the Dockhood desktop. Beginner. Intermediate. Expert. Custom. No wallet needed.',
};

/** /games/minesweeper: the desktop boots and opens Minesweeper (the desktop reads the path). */
export default function MinesweeperPage() {
  return <Startup />;
}

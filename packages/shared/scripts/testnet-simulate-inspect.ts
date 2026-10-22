/** Read-only inspection of cached verified Solidity sources, never wallet/deployment state. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PONS, VERIFIED_NAMES, verifiedArtifact } from './testnet-lib';

const [name, sourceFilter = name, needle] = process.argv.slice(2);
const contract = Object.values(PONS).find(([, n]) => n === name);
if (!contract) throw new Error('Specify a cached Pons artifact name and optional source filter/search term.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const raw = JSON.parse(readFileSync(join(root, '.testnet', 'artifacts', `${name}.json`), 'utf8'));
verifiedArtifact(raw, contract[0], VERIFIED_NAMES[name] ?? name, 'cached verified source');
for (const [path, source] of Object.entries(raw.stdJsonInput.sources) as [string, { content: string }][]) {
  if (!path.includes(sourceFilter)) continue;
  console.log(path);
  const lines = source.content.split('\n');
  const selected = new Set<number>();
  lines.forEach((line, i) => {
    if (!needle || line.includes(needle)) for (let j = Math.max(0, i - 6); j < Math.min(lines.length, i + 24); j++) selected.add(j);
  });
  for (const i of [...selected].sort((a, b) => a - b)) console.log(`${i + 1}: ${lines[i]}`);
}

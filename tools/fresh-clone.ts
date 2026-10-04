/**
 * Fresh-clone check (plan Phase 9: "the README is enough to set up the project from a fresh clone"). Clones the
 * repository into a temporary folder and runs what a new contributor runs: install from the lockfile, the type check,
 * lint, format check, unit tests and the production build. With --assets it also runs `pnpm assets` (needs the Git
 * LFS sources or `pnpm fetch-assets`); with --keep the clone stays for a look (and `pnpm start`).
 *
 *   npx tsx tools/fresh-clone.ts [repository or path, default: this folder] [--assets] [--keep]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const source = args.find((a) => !a.startsWith('--')) ?? resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'riffle-clone-'));
const results: { step: string; ok: boolean; seconds: number }[] = [];

function run(step: string, command: string, commandArgs: string[], cwd = dir): boolean {
  console.log(`\n▶ ${step}: ${command} ${commandArgs.join(' ')}`);
  const start = performance.now();
  const r = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  const ok = r.status === 0;
  results.push({ step, ok, seconds: (performance.now() - start) / 1000 });
  return ok;
}

let ok =
  run('clone', 'git', ['clone', '--depth', '1', source, dir], tmpdir()) &&
  run('install', 'pnpm', ['install', '--frozen-lockfile']) &&
  run('typecheck', 'pnpm', ['typecheck']) &&
  run('lint', 'pnpm', ['lint']) &&
  run('format', 'pnpm', ['format:check']) &&
  run('unit tests', 'pnpm', ['test']) &&
  run('build', 'pnpm', ['build']);
if (ok && flags.has('--assets')) ok = run('assets', 'pnpm', ['assets']);

console.log('\nFresh-clone check');
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.step.padEnd(12)} ${r.seconds.toFixed(1)} s`);
if (flags.has('--keep')) console.log(`\nThe clone is in ${dir} (pnpm start serves it at http://localhost:4173).`);
else rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);

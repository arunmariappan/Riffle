/**
 * Makes sure the page is cross-origin isolated before anything starts (SharedArrayBuffer needs it, plan principle 6).
 * The local servers send the headers themselves. On a static host such as GitHub Pages, the `coi-sw.js` service
 * worker (src/workers/isolation.sw.ts) adds them, which takes one reload on the first visit.
 */
const RELOAD_KEY = 'riffle-isolation-reload';

export type Isolation = 'isolated' | 'reloading' | 'unavailable';

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_KEY) === '1';
  } catch {
    return true;
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(RELOAD_KEY, '1');
    else sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // Storage blocked: readFlag() then reports a reload as already tried, so the page never loops.
  }
}

export async function ensureIsolation(): Promise<Isolation> {
  if (window.crossOriginIsolated) {
    writeFlag(false);
    return 'isolated';
  }
  // The dev server is always isolated; only production builds carry the worker.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return 'unavailable';
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-sw.js`, {
      scope: import.meta.env.BASE_URL,
      type: 'module',
    });
    await navigator.serviceWorker.ready;
  } catch {
    return 'unavailable';
  }
  // One reload puts the page under the worker. If it is still not isolated after that, the worker can't help.
  if (readFlag()) return 'unavailable';
  writeFlag(true);
  window.location.reload();
  return 'reloading';
}

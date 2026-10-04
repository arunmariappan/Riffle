/**
 * Autosave (plan 6.11): every 5 minutes and when the tab is hidden or closed, keeping the last 3. The storage is an
 * interface (OPFS in the browser, a Map in tests), so the rotation logic is pure and unit-tested.
 */

export interface SaveStore {
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface AutosaveEntry {
  name: string;
  /** Milliseconds since the epoch. */
  time: number;
}

const PREFIX = 'autosave-';
const SUFFIX = '.riffle';

export function autosaveName(time: number): string {
  return `${PREFIX}${String(Math.floor(time)).padStart(15, '0')}${SUFFIX}`;
}

export function parseAutosaveName(name: string): number | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null;
  const t = Number(name.slice(PREFIX.length, -SUFFIX.length));
  return Number.isFinite(t) ? t : null;
}

export class Autosaver {
  readonly intervalMs: number;
  readonly keep: number;
  private last: number;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly store: SaveStore,
    private readonly make: () => Promise<Uint8Array>,
    options: { intervalMs?: number; keep?: number; now?: number } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000;
    this.keep = options.keep ?? 3;
    this.last = options.now ?? Date.now();
  }

  /** Newest first. */
  async entries(): Promise<AutosaveEntry[]> {
    const names = await this.store.list();
    return names
      .map((name) => ({ name, time: parseAutosaveName(name) }))
      .filter((e): e is AutosaveEntry => e.time !== null)
      .sort((a, b) => b.time - a.time);
  }

  async latest(): Promise<{ entry: AutosaveEntry; bytes: Uint8Array } | null> {
    for (const entry of await this.entries()) {
      const bytes = await this.store.read(entry.name);
      if (bytes && bytes.length > 0) return { entry, bytes };
    }
    return null;
  }

  /** Saves now (unless a save is already running) and drops the oldest beyond `keep`. */
  save(now = Date.now()): Promise<void> {
    if (this.saving) return this.saving;
    this.last = now;
    this.saving = (async () => {
      try {
        const bytes = await this.make();
        // Never reuse a name: a quick second save gets the next millisecond.
        const existing = new Set((await this.entries()).map((e) => e.time));
        let t = Math.floor(now);
        while (existing.has(t)) t++;
        await this.store.write(autosaveName(t), bytes);
        const all = await this.entries();
        for (const old of all.slice(this.keep)) await this.store.remove(old.name);
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }

  /** Call regularly; saves when the interval has passed. Returns true when it started a save. */
  tick(now = Date.now()): boolean {
    if (now - this.last < this.intervalMs) return false;
    void this.save(now);
    return true;
  }
}

/** An in-memory store (tests, and the fallback when OPFS is unavailable). */
export class MemoryStore implements SaveStore {
  readonly files = new Map<string, Uint8Array>();
  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
  async read(name: string): Promise<Uint8Array | null> {
    return this.files.get(name) ?? null;
  }
  async write(name: string, bytes: Uint8Array): Promise<void> {
    this.files.set(name, bytes.slice());
  }
  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
}

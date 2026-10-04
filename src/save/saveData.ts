/**
 * What a saved valley holds (plan 6.11): the seed, the time, every panel setting, your edit layer and where you
 * were standing. Binary sections (the ecosystem's cohorts, environment and plants) ride alongside. A version number
 * and a migration table keep old saves loading after updates. Pure TypeScript.
 */
import { encodeRiffle, decodeRiffle, RiffleFormatError } from './format';
import { defaultEcosystem, normalizeSettings, type ValleySettings } from '../state/settings';
import { validateEditLayer, type EditLayer } from '../builder/editLayer';

/** Bump when the saved JSON changes shape, and add a migration from the previous version. */
export const SAVE_VERSION = 2;

export interface SavedView {
  mode: 'explore' | 'builder';
  /** Where you stand (Explore). */
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** The builder camera's orbit. */
  builder: { x: number; y: number; z: number; yaw: number; pitch: number; distance: number };
}

export interface SaveData {
  version: number;
  savedAt: string;
  seed: string;
  /** Simulated seconds since 1 January, year 0 (SimClock.seconds). */
  clock: number;
  settings: ValleySettings;
  edits: EditLayer;
  view: SavedView;
  /** Free-form extras from later phases (ecology summary, photo settings). */
  extra: Record<string, unknown>;
}

export interface SaveBundle {
  data: SaveData;
  sections: Record<string, Uint8Array>;
}

type Migration = (json: Record<string, unknown>) => Record<string, unknown>;

/** migrations[v] turns a version-v document into version v + 1. */
const MIGRATIONS: Record<number, Migration> = {
  /**
   * Version 2 (Phase 6) adds the ecosystem: its settings in the document and its state in the `ecology` and `plants`
   * sections. A valley saved before it keeps its stream as it was saved: rain doesn't raise it until you turn that on.
   */
  1: (json) => {
    const settings = (json.settings && typeof json.settings === 'object' ? json.settings : {}) as Record<
      string,
      unknown
    >;
    return { ...json, settings: { ...settings, ecosystem: { ...defaultEcosystem(), rainRaisesStream: false } } };
  },
};

export function migrate(json: Record<string, unknown>, from: number, to = SAVE_VERSION): Record<string, unknown> {
  let doc = json;
  for (let v = from; v < to; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new RiffleFormatError(`No way to update a version ${v} valley file`);
    doc = step(doc);
  }
  return doc;
}

export async function encodeSave(bundle: SaveBundle): Promise<Uint8Array> {
  return encodeRiffle({ version: SAVE_VERSION, json: bundle.data, sections: bundle.sections });
}

export async function decodeSave(bytes: Uint8Array): Promise<SaveBundle> {
  const file = await decodeRiffle(bytes);
  if (file.version > SAVE_VERSION)
    throw new RiffleFormatError('This valley was saved by a newer Riffle. Update Riffle to open it.');
  const json = migrate(file.json as Record<string, unknown>, file.version);
  return { data: validateSave(json), sections: file.sections };
}

function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Checks a decoded document and fills anything optional that's missing. */
export function validateSave(json: Record<string, unknown>): SaveData {
  if (typeof json.seed !== 'string' || json.seed.length === 0)
    throw new RiffleFormatError('The valley file has no seed');
  const view = (json.view ?? {}) as Partial<SavedView>;
  const p = (view.player ?? {}) as Partial<SavedView['player']>;
  const b = (view.builder ?? {}) as Partial<SavedView['builder']>;
  return {
    version: SAVE_VERSION,
    savedAt: typeof json.savedAt === 'string' ? json.savedAt : new Date(0).toISOString(),
    seed: json.seed,
    clock: n(json.clock, (95 * 24 + 8) * 3600),
    settings: normalizeSettings(json.settings),
    edits: validateEditLayer(json.edits),
    view: {
      mode: view.mode === 'builder' ? 'builder' : 'explore',
      player: { x: n(p.x), y: n(p.y), z: n(p.z), yaw: n(p.yaw), pitch: n(p.pitch) },
      builder: { x: n(b.x), y: n(b.y), z: n(b.z), yaw: n(b.yaw), pitch: n(b.pitch, 0.9), distance: n(b.distance, 40) },
    },
    extra: (json.extra && typeof json.extra === 'object' ? json.extra : {}) as Record<string, unknown>,
  };
}

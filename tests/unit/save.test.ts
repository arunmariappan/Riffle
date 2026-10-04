import { describe, expect, it } from 'vitest';
import { decodeRiffle, encodeRiffle, floatsToBytes, bytesToFloats, RiffleFormatError } from '../../src/save/format';
import { decodeSave, encodeSave, SAVE_VERSION, migrate, type SaveData } from '../../src/save/saveData';
import { Autosaver, MemoryStore, autosaveName, parseAutosaveName } from '../../src/save/autosave';
import { defaultSettings, normalizeSettings, withSetting, getSetting } from '../../src/state/settings';
import { createEditLayer, newUid, addItem } from '../../src/builder/editLayer';

function sample(): SaveData {
  const edits = createEditLayer();
  addItem(edits, {
    uid: newUid(edits),
    category: 'stones',
    kind: 'boulder-large',
    variant: 2,
    x: 12.5,
    y: 3,
    z: -40,
    yaw: 1.2,
    scale: 1,
    radius: 1.1,
    height: 0.8,
    quat: [0, 0.1, 0, 0.995],
  });
  edits.grass.push({ x: 1, z: 2, radius: 3, amount: 0.5 });
  return {
    version: SAVE_VERSION,
    savedAt: '2026-10-04T12:00:00.000Z',
    seed: 'riffle',
    clock: 123456.5,
    settings: withSetting(defaultSettings(), 'water.discharge', 7.5),
    edits,
    view: {
      mode: 'builder',
      player: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.1 },
      builder: { x: 4, y: 5, z: 6, yaw: 1, pitch: 0.8, distance: 55 },
    },
    extra: { note: 'hello' },
  };
}

describe('.riffle files', () => {
  it('round-trips JSON and binary sections', async () => {
    const grid = new Float32Array([0.25, -1, 3.5, 1e6]);
    const bytes = await encodeRiffle({ version: 3, json: { a: [1, 2, 'x'] }, sections: { grid: floatsToBytes(grid) } });
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('RIFFLE');
    const back = await decodeRiffle(bytes);
    expect(back.version).toBe(3);
    expect(back.json).toEqual({ a: [1, 2, 'x'] });
    expect(Array.from(bytesToFloats(back.sections.grid!))).toEqual(Array.from(grid));
  });

  it('compresses repetitive data', async () => {
    const zeros = new Uint8Array(200_000);
    const bytes = await encodeRiffle({ version: 1, json: {}, sections: { zeros } });
    expect(bytes.length).toBeLessThan(5_000);
  });

  it('rejects files that are not valleys or are damaged', async () => {
    await expect(decodeRiffle(new TextEncoder().encode('hello world'))).rejects.toThrow(RiffleFormatError);
    const good = await encodeRiffle({ version: 1, json: { seed: 'x' }, sections: {} });
    const cut = good.slice(0, good.length - 8);
    await expect(decodeRiffle(cut)).rejects.toThrow(RiffleFormatError);
  });

  it('saves and restores a valley exactly', async () => {
    const data = sample();
    const sections = { cohorts: new Uint8Array([1, 2, 3]) };
    const back = await decodeSave(await encodeSave({ data, sections }));
    expect(back.data).toEqual(data);
    expect(Array.from(back.sections.cohorts!)).toEqual([1, 2, 3]);
  });

  it('refuses files from a newer Riffle and has no gaps in its migrations', async () => {
    const bytes = await encodeRiffle({ version: SAVE_VERSION + 1, json: sample(), sections: {} });
    await expect(decodeSave(bytes)).rejects.toThrow(/newer Riffle/);
    expect(migrate({ seed: 'x' }, SAVE_VERSION)).toEqual({ seed: 'x' });
  });

  it('fills settings missing from older or hand-edited files', () => {
    const s = normalizeSettings({ water: { discharge: 99 }, wind: { dirX: 0, dirZ: 0 }, weather: { mode: 'tornado' } });
    expect(s.water.discharge).toBe(16);
    expect(s.water.speed).toBe(1);
    expect(Math.hypot(s.wind.dirX, s.wind.dirZ)).toBeCloseTo(1);
    expect(s.weather.mode).toBe('auto');
    expect(getSetting(withSetting(s, 'trees.species.bamboo', 2), 'trees.species.bamboo')).toBe(2);
  });
});

describe('autosave', () => {
  it('keeps the newest three', async () => {
    const store = new MemoryStore();
    let n = 0;
    const saver = new Autosaver(store, async () => new Uint8Array([++n]), { now: 0 });
    for (let t = 1; t <= 5; t++) await saver.save(t * 1000);
    const entries = await saver.entries();
    expect(entries.map((e) => e.time)).toEqual([5000, 4000, 3000]);
    const latest = await saver.latest();
    expect(Array.from(latest!.bytes)).toEqual([5]);
  });

  it('saves every interval, not more often', async () => {
    const store = new MemoryStore();
    const saver = new Autosaver(store, async () => new Uint8Array([1]), { now: 0, intervalMs: 300_000 });
    expect(saver.tick(100_000)).toBe(false);
    expect(saver.tick(300_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(saver.tick(400_000)).toBe(false);
    expect(saver.tick(600_001)).toBe(true);
  });

  it('names sort by time', () => {
    expect(parseAutosaveName(autosaveName(1234))).toBe(1234);
    expect(parseAutosaveName('notes.txt')).toBeNull();
    expect(autosaveName(9) < autosaveName(10)).toBe(true);
  });
});

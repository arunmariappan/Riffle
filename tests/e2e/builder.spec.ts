import { expect, test, type Page } from '@playwright/test';
import { waitForReady } from './helpers';

/** Frames the builder camera steeply over the middle of a stream zone; returns that point. */
async function frameZone(page: Page, zone: string): Promise<{ x: number; z: number }> {
  return page.evaluate((name) => {
    const w = (window as any).__riffle.world;
    const z = w.valley.profile.zones.find((q: any) => q.name === name);
    const i = Math.round((z.start + z.end) / 2);
    const x = w.flow.path.points[i * 2];
    const zz = w.flow.path.points[i * 2 + 1];
    w.builderCamera.frame(x, zz, { pitch: 1.25, distance: 22 });
    return { x, z: zz };
  }, zone);
}

/** Drags a catalog card to the middle of the 3D view. */
async function dragCardToCenter(page: Page, id: string, release = true): Promise<void> {
  const card = await page.getByTestId(`card-${id}`).boundingBox();
  const view = await page.getByTestId('viewport').boundingBox();
  if (!card || !view) throw new Error('missing card or viewport');
  await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2, { steps: 15 });
  await page.waitForTimeout(300);
  if (release) await page.mouse.up();
}

test.describe('the builder (Phase 4)', () => {
  test.setTimeout(360_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&spot=riffles&hour=11');
    await waitForReady(page, 300_000);
    await page.getByTestId('mode-builder').click();
    await expect(page.getByRole('tab', { name: 'Stones' })).toBeVisible();
  });

  test('drag a stone into the stream: it settles and the water flows around it', async ({ page }) => {
    const spot = await frameZone(page, 'riffles');
    await page.waitForTimeout(1000);
    const before = await page.evaluate(() => (window as any).__riffle.world.rocks.stones.length);
    await page.getByRole('tab', { name: 'Stones' }).click();
    await dragCardToCenter(page, 'boulder-medium', false);
    await expect(page.getByTestId('placement-hint')).toContainText('Boulder');
    await page.mouse.up();
    await page.waitForFunction(
      (n) => {
        const w = (window as any).__riffle.world;
        return w.rocks.stones.length > n && !w.items.busy;
      },
      before,
      { timeout: 20_000 },
    );
    const placed = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const s = w.rocks.stones[w.rocks.stones.length - 1];
      const f = w.flow.sample(s.x, s.z);
      return { x: s.x, z: s.z, y: s.y, bed: f?.bed ?? null, edits: w.items.edits.added.length };
    });
    // It landed near where it was dropped, resting on the bed, and is in your edit layer.
    expect(Math.hypot(placed.x - spot.x, placed.z - spot.z)).toBeLessThan(4);
    if (placed.bed !== null) expect(Math.abs(placed.y - placed.bed)).toBeLessThan(1.2);
    expect(placed.edits).toBe(1);
    // Undo takes it out again; redo puts it back where it settled.
    await page.getByTestId('undo').click();
    await expect.poll(() => page.evaluate(() => (window as any).__riffle.world.rocks.stones.length)).toBe(before);
    await page.getByTestId('redo').click();
    await expect.poll(() => page.evaluate(() => (window as any).__riffle.world.rocks.stones.length)).toBe(before + 1);
  });

  test('an invalid spot shows a clear reason and places nothing', async ({ page }) => {
    await frameZone(page, 'riffles');
    await page.waitForTimeout(1000);
    const lotus = () =>
      page.evaluate(
        () => [...(window as any).__riffle.world.plants.all()].filter((p: any) => p.kind === 'lotus').length,
      );
    const before = await lotus();
    await page.getByRole('tab', { name: 'Water plants' }).click();
    await dragCardToCenter(page, 'lotus', false);
    await expect(page.getByTestId('placement-hint')).toContainText('Lotus needs still water');
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(await lotus()).toBe(before);
  });

  test('every catalog item can be placed, Java fern onto a stone', async ({ page }) => {
    const results = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const b = (window as any).__riffle.builder;
      const c = w.catalog;
      const ids = [...c.fish, ...c.plants, ...c.stones, ...c.trees, ...c.bushes].map((i: any) => i.id);
      const path = w.flow.path;
      const pond = w.valley.pond;
      // Candidate spots: along the stream at several offsets, around the pond, and on the banks.
      const spots: { x: number; z: number }[] = [];
      for (let i = 0; i < path.count; i += 40)
        for (const k of [0, -3, 3, -6, 6, -14, 14, -30, 30])
          spots.push({
            x: path.points[i * 2] + path.normals[i * 2] * k,
            z: path.points[i * 2 + 1] + path.normals[i * 2 + 1] * k,
          });
      for (let a = 0; a < 24; a++)
        for (const r of [0.2, 0.5, 0.8])
          spots.push({ x: pond.x + Math.cos(a) * pond.radius * r, z: pond.z + Math.sin(a) * pond.radius * r });
      const out: Record<string, string> = {};
      for (const id of ids) {
        let done = false;
        const def = c.plants.find((p: any) => p.id === id);
        if (def?.placement.surface === 'stone') {
          for (const s of w.rocks.stones) {
            const r = b.check(id, s.x, s.z, s.uid);
            if (r?.ok) {
              await b.placeAt(id, s.x, s.z, s.uid);
              await b.undo.idle();
              done = true;
              break;
            }
          }
        } else {
          for (const s of spots) {
            const r = b.check(id, s.x, s.z);
            if (r?.ok) {
              await b.placeAt(id, s.x, s.z);
              await b.undo.idle();
              done = true;
              break;
            }
          }
        }
        out[id] = done ? 'placed' : 'no spot';
      }
      return { out, added: w.items.edits.added.map((a: any) => a.kind) };
    });
    for (const [id, r] of Object.entries(results.out)) expect(r, id).toBe('placed');
    const fern = results.added.indexOf('java-fern');
    expect(fern).toBeGreaterThanOrEqual(0);
  });

  test('sliders change the world live and undo/redo 100 steps', async ({ page }) => {
    await page.getByRole('tab', { name: 'Wind' }).click();
    const slider = page.getByTestId('slider-wind-speed').getByRole('slider');
    await slider.focus();
    await page.keyboard.press('End');
    await expect.poll(() => page.evaluate(() => (window as any).__riffle.world.windState.speed)).toBe(25);
    expect(await page.evaluate(() => (window as any).__riffle.world.wind.speed.value)).toBe(25);
    await page.keyboard.press('Home');
    await expect.poll(() => page.evaluate(() => (window as any).__riffle.world.windState.speed)).toBe(0);

    const result = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const b = (window as any).__riffle.builder;
      b.undo.clear();
      const start = JSON.stringify(w.settings.trees);
      for (let i = 0; i < 100; i++) await b.setSetting(i % 2 ? 'trees.sway' : 'trees.flutter', 0.2 + (i % 50) * 0.05);
      const end = JSON.stringify(w.settings.trees);
      for (let i = 0; i < 100; i++) await b.undoStep();
      const undone = JSON.stringify(w.settings.trees);
      for (let i = 0; i < 100; i++) await b.redoStep();
      return { start, end, undone, redone: JSON.stringify(w.settings.trees), size: b.undo.state.size };
    });
    expect(result.undone).toBe(result.start);
    expect(result.redone).toBe(result.end);
    expect(result.size).toBe(100);
  });
});

test.describe('saving and loading (Phase 4)', () => {
  test.setTimeout(480_000);

  /** The parts of a snapshot that must survive a save and reload (not the save time). */
  const essence = (page: Page) =>
    page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const s = w.snapshot();
      return {
        seed: s.seed,
        clock: Math.round(s.clock),
        settings: s.settings,
        edits: s.edits,
        stones: w.rocks.stones.length,
        trees: w.trees.totalInstances,
      };
    });

  /** Makes a few edits through the builder: a stone, a tree removed, settings changed. */
  const edit = (page: Page) =>
    page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const b = (window as any).__riffle.builder;
      const zone = w.valley.profile.zones.find((z: any) => z.name === 'pool');
      const i = Math.round((zone.start + zone.end) / 2);
      await w.placeStone('boulder-large', w.flow.path.points[i * 2], w.flow.path.points[i * 2 + 1], 1.1, 0.8);
      const tree = [...w.trees.all()][5];
      await b.select([tree.uid]);
      await b.deleteSelection();
      await b.setSetting('wind.speed', 9.5);
      await b.setSetting('water.clarity', 0.4);
      await b.setSetting('trees.species.bamboo', 2.2);
      await b.undo.idle();
    });

  test('save, close the tab and reopen restores the valley exactly (autosave)', async ({ page, context }) => {
    await page.goto('/?autostart&freeze&autosave&spot=pool&hour=9');
    await waitForReady(page, 300_000);
    await edit(page);
    const before = await essence(page);
    await page.evaluate(() => (window as any).__riffle.autosaver.save());
    await page.close();
    const again = await context.newPage();
    await again.goto('/?continue&freeze');
    await waitForReady(again, 300_000);
    const after = await essence(again);
    expect(after).toEqual(before);
  });

  test('save to a file and open it again restores the valley exactly', async ({ page }) => {
    await page.goto('/?autostart&spot=pool&hour=9');
    await waitForReady(page, 300_000);
    await edit(page);
    const before = await essence(page);
    const bytes: number[] = await page.evaluate(async () => {
      const b = (window as any).__riffle.builder;
      return Array.from(await b.saveBytes()) as number[];
    });
    // Use the file-input fallback so the test can hand the file over.
    await page.evaluate(() => {
      delete (window as any).showOpenFilePicker;
    });
    await page.getByRole('button', { name: 'Valley ▾' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Open valley…' }).click();
    await (
      await chooser
    ).setFiles({ name: 'test.riffle', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await page.waitForURL(/open/);
    await waitForReady(page, 300_000);
    const after = await essence(page);
    expect({ ...after, clock: 0 }).toEqual({ ...before, clock: 0 });
  });
});

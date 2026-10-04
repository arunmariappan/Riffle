import { expect, test } from '@playwright/test';
import { waitForReady } from './helpers';

test.describe('the fish (Phase 5)', () => {
  test.setTimeout(360_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/?autostart&freeze&allfish&spot=pool&hour=11&day=290');
    await waitForReady(page, 300_000);
    await page.waitForTimeout(8000); // let the schools settle into their water
  });

  test('all six species live in the valley, each in the water', async ({ page }) => {
    const stats = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const out: Record<string, { n: number; wet: number; pond: number }> = {};
      for (const f of w.fish.positions()) {
        const id = w.fish.defs[f.species].id;
        out[id] ??= { n: 0, wet: 0, pond: 0 };
        const s = w.flow.sample(f.x, f.z);
        out[id].n++;
        if (s && s.depth > 0.03 && f.y >= s.bed - 0.01 && f.y <= s.surface + 0.01) out[id].wet++;
        if (s?.pond) out[id].pond++;
      }
      return out;
    });
    for (const id of [
      'denison-barb',
      'golden-mahseer',
      'white-cloud-minnow',
      'celestial-pearl-danio',
      'hillstream-loach',
      'koi',
    ]) {
      expect(stats[id]?.n ?? 0, id).toBeGreaterThan(0);
      expect(stats[id]!.wet, id).toBe(stats[id]!.n);
    }
    expect(stats.koi!.pond).toBe(stats.koi!.n);
  });

  test('barbs and loaches hold in the current, facing upstream', async ({ page }) => {
    const r = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const res: Record<string, { moving: number; upstream: number }> = {};
      for (const f of w.fish.positions()) {
        const id = w.fish.defs[f.species].id;
        if (id !== 'denison-barb' && id !== 'hillstream-loach') continue;
        const s = w.flow.sample(f.x, f.z);
        const speed = s ? Math.hypot(s.velocityX, s.velocityZ) : 0;
        res[id] ??= { moving: 0, upstream: 0 };
        if (speed < 0.3) continue;
        res[id].moving++;
        if ((Math.sin(f.yaw) * s.velocityX + Math.cos(f.yaw) * s.velocityZ) / speed < -0.3) res[id].upstream++;
      }
      return res;
    });
    for (const id of ['denison-barb', 'hillstream-loach']) {
      const v = r[id]!;
      if (v.moving > 4) expect(v.upstream / v.moving, id).toBeGreaterThan(0.6);
    }
  });

  test('koi come to food thrown into the pond', async ({ page }) => {
    const target = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const koi = w.fish.speciesIndex('koi');
      const fish = w.fish.positions().filter((f: any) => f.species === koi);
      const p = w.valley.pond;
      // Throw the food across the pond from where the koi are.
      const cx = fish.reduce((s: number, f: any) => s + f.x, 0) / fish.length;
      const cz = fish.reduce((s: number, f: any) => s + f.z, 0) / fish.length;
      const dx = p.x - cx;
      const dz = p.z - cz;
      const len = Math.hypot(dx, dz) || 1;
      let x = p.x + (dx / len) * p.radius * 0.4;
      let z = p.z + (dz / len) * p.radius * 0.4;
      if (!w.flow.sample(x, z)?.pond) {
        x = p.x;
        z = p.z;
      }
      await w.fish.throwFood(x, w.flow.pondLevel(), z);
      return { x, z };
    });
    await page.waitForTimeout(25_000);
    const close = await page.evaluate(({ x, z }) => {
      const w = (window as any).__riffle.world;
      const koi = w.fish.speciesIndex('koi');
      const fish = w.fish.positions().filter((f: any) => f.species === koi);
      return fish.filter((f: any) => Math.hypot(f.x - x, f.z - z) < 3).length / fish.length;
    }, target);
    expect(close).toBeGreaterThan(0.5);
  });

  test('mahseer keep to deep or sheltered water', async ({ page }) => {
    const share = await page.evaluate(() => {
      const w = (window as any).__riffle.world;
      const m = w.fish.speciesIndex('golden-mahseer');
      const fish = w.fish.positions().filter((f: any) => f.species === m);
      const good = fish.filter((f: any) => {
        const s = w.flow.sample(f.x, f.z);
        return s && (s.depth > 0.8 || s.shelter > 0.15);
      });
      return good.length / Math.max(1, fish.length);
    });
    expect(share).toBeGreaterThan(0.6);
  });

  test('a fish can be inspected and followed', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const w = (window as any).__riffle.world;
      const b = (window as any).__riffle.builder;
      const f = w.fish.positions()[0];
      await b.inspectFish(f.id);
      b.toggleFollow();
      await new Promise((res) => setTimeout(res, 2500));
      const now = w.fish.get(f.id);
      const cam = (window as any).__riffle.engine.camera.position;
      return {
        mode: w.mode,
        dist: now ? Math.hypot(cam.x - now.x, cam.y - now.y, cam.z - now.z) : -1,
        length: f.length,
      };
    });
    await expect(page.getByTestId('fish-card')).toBeVisible();
    expect(r.mode).toBe('follow');
    expect(r.dist).toBeGreaterThan(0);
    expect(r.dist).toBeLessThan(Math.max(2, r.length * 12));
    await page.getByRole('button', { name: 'Stop following' }).click();
    expect(await page.evaluate(() => (window as any).__riffle.world.mode)).not.toBe('follow');
  });
});

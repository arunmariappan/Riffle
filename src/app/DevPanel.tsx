import { useEffect, useRef } from 'react';
import { Pane } from 'tweakpane';
import type { World } from '../engine/world/World';
import { withSetting } from '../state/settings';
import { useUi } from '../state/store';

/**
 * Developer tuning panel (dev builds and `?dev`): live water, time, wind and tree controls. The Builder's panels
 * (plan 6.8) are the real controls; this stays as a debug aid and goes through the same settings, without undo.
 */
export function DevPanel({ world }: { world: World }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const apply = (path: string, value: unknown) =>
      void world
        .applySettings(withSetting(world.settings, path, value))
        .then(() => useUi.getState().set({ settings: structuredClone(world.settings) }));
    const pane = new Pane({ container: host.current, title: 'Riffle dev', expanded: false });
    const water = {
      discharge: world.flow.discharge,
      speed: world.flow.speedMultiplier,
      level: world.flow.levelOffset,
      clarity: 1 - world.flow.look.turbidity.value,
    };
    const w = pane.addFolder({ title: 'Water' });
    w.addBinding(water, 'discharge', { min: 0.5, max: 16, step: 0.1, label: 'discharge m³/s' }).on('change', (e) => {
      if (e.last) apply('water.discharge', e.value);
    });
    w.addBinding(water, 'speed', { min: 0.2, max: 3, step: 0.05, label: 'speed ×' }).on('change', (e) => {
      if (e.last) apply('water.speed', e.value);
    });
    w.addBinding(water, 'level', { min: -0.5, max: 1, step: 0.02, label: 'level offset m' }).on('change', (e) => {
      if (e.last) apply('water.level', e.value);
    });
    w.addBinding(water, 'clarity', { min: 0, max: 1, step: 0.01 }).on('change', (e) => apply('water.clarity', e.value));

    const time = {
      hour: world.clock.hour,
      day: world.clock.dayOfYear,
      speed: world.clock.timeScale,
      paused: world.clock.paused,
    };
    const t = pane.addFolder({ title: 'Time' });
    t.addBinding(time, 'hour', { min: 0, max: 24, step: 0.05 }).on('change', (e) => world.clock.setHour(e.value));
    t.addBinding(time, 'day', { min: 0, max: 364, step: 1 }).on('change', (e) =>
      world.clock.setTime(e.value, world.clock.hour),
    );
    t.addBinding(time, 'speed', {
      options: { 'real time': 1, '1 min = 1 hour': 60, '1 min = 1 day': 1440, 'season lapse': 259200 },
    }).on('change', (e) => apply('time.timeScale', e.value));
    t.addBinding(time, 'paused').on('change', (e) => apply('time.paused', e.value));

    const windState = {
      speed: world.wind.speed.value,
      direction: (Math.atan2(world.wind.direction.value.y, world.wind.direction.value.x) * 180) / Math.PI,
      gustiness: world.wind.gustiness.value,
      turbulence: world.wind.turbulence.value,
    };
    const wi = pane.addFolder({ title: 'Wind' });
    wi.addBinding(windState, 'speed', { min: 0, max: 25, step: 0.1, label: 'speed m/s' }).on('change', (e) =>
      apply('wind.speed', e.value),
    );
    wi.addBinding(windState, 'direction', { min: -180, max: 180, step: 1 }).on('change', (e) => {
      const a = (e.value * Math.PI) / 180;
      apply('wind', { ...world.settings.wind, dirX: Math.cos(a), dirZ: Math.sin(a) });
    });
    wi.addBinding(windState, 'gustiness', { min: 0, max: 1.5, step: 0.01 }).on('change', (e) =>
      apply('wind.gustiness', e.value),
    );
    wi.addBinding(windState, 'turbulence', { min: 0, max: 1.5, step: 0.01 }).on('change', (e) =>
      apply('wind.turbulence', e.value),
    );

    const trees = {
      flexibility: world.wind.flexibility.value,
      sway: world.wind.swayStrength.value,
      flutter: world.wind.leafFlutter.value,
      delay: world.wind.responseDelay.value,
    };
    const tr = pane.addFolder({ title: 'Trees', expanded: false });
    tr.addBinding(trees, 'flexibility', { min: 0.2, max: 3, step: 0.01 }).on('change', (e) =>
      apply('trees.flexibility', e.value),
    );
    tr.addBinding(trees, 'sway', { min: 0, max: 3, step: 0.01 }).on('change', (e) => apply('trees.sway', e.value));
    tr.addBinding(trees, 'flutter', { min: 0, max: 3, step: 0.01 }).on('change', (e) =>
      apply('trees.flutter', e.value),
    );
    tr.addBinding(trees, 'delay', { min: 0.3, max: 3, step: 0.01, label: 'response delay' }).on('change', (e) =>
      apply('trees.delay', e.value),
    );

    const timer = window.setInterval(() => {
      time.hour = world.clock.hour;
      pane.refresh();
    }, 1000);
    return () => {
      window.clearInterval(timer);
      pane.dispose();
    };
  }, [world]);
  return <div ref={host} className="dev-panel" />;
}

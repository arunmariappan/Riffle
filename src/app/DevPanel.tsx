import { useEffect, useRef } from 'react';
import { Pane } from 'tweakpane';
import type { World } from '../engine/world/World';

/**
 * Developer tuning panel (dev builds and `?dev`): live water, time, wind and tree controls. The real Builder panels
 * (plan 6.8) arrive in Phase 4; this stays as a debug aid.
 */
export function DevPanel({ world }: { world: World }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const pane = new Pane({ container: host.current, title: 'Riffle dev', expanded: false });
    const water = {
      discharge: world.flow.discharge,
      speed: world.flow.speedMultiplier,
      level: world.flow.levelOffset,
      clarity: 1 - world.flow.look.turbidity.value,
    };
    const w = pane.addFolder({ title: 'Water' });
    w.addBinding(water, 'discharge', { min: 0.5, max: 16, step: 0.1, label: 'discharge m³/s' }).on('change', (e) => {
      if (e.last) void world.flow.setDischarge(e.value);
    });
    w.addBinding(water, 'speed', { min: 0.2, max: 3, step: 0.05, label: 'speed ×' }).on('change', (e) => {
      if (e.last) void world.flow.setSpeedMultiplier(e.value);
    });
    w.addBinding(water, 'level', { min: -0.5, max: 1, step: 0.02, label: 'level offset m' }).on('change', (e) => {
      if (e.last) void world.flow.setLevelOffset(e.value);
    });
    w.addBinding(water, 'clarity', { min: 0, max: 1, step: 0.01 }).on('change', (e) => {
      world.flow.look.turbidity.value = 1 - e.value;
    });

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
    }).on('change', (e) => (world.clock.timeScale = e.value));
    t.addBinding(time, 'paused').on('change', (e) => (world.clock.paused = e.value));

    const windState = {
      speed: world.wind.speed.value,
      direction:
        (Math.atan2(world.wind.direction.value.y, world.wind.direction.value.x) * 180) / Math.PI,
      gustiness: world.wind.gustiness.value,
      turbulence: world.wind.turbulence.value,
    };
    const wi = pane.addFolder({ title: 'Wind' });
    wi.addBinding(windState, 'speed', { min: 0, max: 25, step: 0.1, label: 'speed m/s' }).on(
      'change',
      (e) => (world.wind.speed.value = e.value),
    );
    wi.addBinding(windState, 'direction', { min: -180, max: 180, step: 1 }).on('change', (e) => {
      const a = (e.value * Math.PI) / 180;
      world.wind.direction.value.set(Math.cos(a), Math.sin(a));
    });
    wi.addBinding(windState, 'gustiness', { min: 0, max: 1.5, step: 0.01 }).on(
      'change',
      (e) => (world.wind.gustiness.value = e.value),
    );
    wi.addBinding(windState, 'turbulence', { min: 0, max: 1.5, step: 0.01 }).on(
      'change',
      (e) => (world.wind.turbulence.value = e.value),
    );

    const trees = {
      flexibility: world.wind.flexibility.value,
      sway: world.wind.swayStrength.value,
      flutter: world.wind.leafFlutter.value,
      delay: world.wind.responseDelay.value,
    };
    const tr = pane.addFolder({ title: 'Trees', expanded: false });
    tr.addBinding(trees, 'flexibility', { min: 0.2, max: 3, step: 0.01 }).on(
      'change',
      (e) => (world.wind.flexibility.value = e.value),
    );
    tr.addBinding(trees, 'sway', { min: 0, max: 3, step: 0.01 }).on(
      'change',
      (e) => (world.wind.swayStrength.value = e.value),
    );
    tr.addBinding(trees, 'flutter', { min: 0, max: 3, step: 0.01 }).on(
      'change',
      (e) => (world.wind.leafFlutter.value = e.value),
    );
    tr.addBinding(trees, 'delay', { min: 0.3, max: 3, step: 0.01, label: 'response delay' }).on(
      'change',
      (e) => (world.wind.responseDelay.value = e.value),
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

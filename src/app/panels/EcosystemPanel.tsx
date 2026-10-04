import { useCallback, useMemo, useState } from 'react';
import { useUi, type OverlayChoice } from '../../state/store';
import type { Builder } from '../../engine/builder/Builder';
import { SliderRow } from '../ui/SliderRow';
import { LIMITS } from '../../state/settings';
import { TIME_SPEEDS } from '../../sim/time/clock';
import { WEATHER_NAMES, type WeatherKind } from '../../sim/weather/weather';
import { EcoGraph, type GraphKind } from './EcoGraph';
import styles from '../ui.module.css';

const SPEEDS: [string, number][] = [
  ['Real time', TIME_SPEEDS.realtime],
  ['1 min = 1 hour', TIME_SPEEDS.minuteIsHour],
  ['1 min = 1 day', TIME_SPEEDS.minuteIsDay],
  ['Season lapse', TIME_SPEEDS.seasonLapse],
];

const GRAPHS: [GraphKind, string][] = [
  ['populations', 'Populations'],
  ['biodiversity', 'Biodiversity'],
  ['water', 'Water quality'],
  ['brightness', 'Color brightness'],
];

const OVERLAYS: [OverlayChoice, string][] = [
  ['none', 'Off'],
  ['flow', 'Flow'],
  ['oxygen', 'Oxygen'],
  ['light', 'Light'],
  ['temperature', 'Temperature'],
  ['fish', 'Fish'],
];

function Toggle({ label, on, onClick, testId }: { label: string; on: boolean; onClick: () => void; testId?: string }) {
  return (
    <button className={on ? styles.buttonOn : styles.button} onClick={onClick} aria-pressed={on} data-testid={testId}>
      {label}
    </button>
  );
}

/**
 * The Ecosystem panel (plan 6.6): time speed and the season lock, evolution, mutation, predators, population caps,
 * the kingfisher, graphs of the valley over time, and the ecology overlays.
 */
export function EcosystemPanel({ builder }: { builder: Builder }) {
  const settings = useUi((s) => s.settings);
  const eco = useUi((s) => s.ecology);
  const overlay = useUi((s) => s.overlay);
  const clock = useUi((s) => s.clock);
  const [graph, setGraph] = useState<GraphKind>('populations');
  const world = builder.world;
  const set = (path: string, v: unknown) => void builder.setSetting(path, v);
  const e = settings.ecosystem;
  const points = useCallback(() => world.ecology.history, [world]);
  const names = useMemo(() => eco?.names ?? [], [eco?.names.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className={styles.subhead}>Time</div>
      <div className={styles.buttonRow}>
        {SPEEDS.map(([label, scale]) => (
          <Toggle
            key={label}
            label={label}
            on={settings.time.timeScale === scale}
            onClick={() => set('time.timeScale', scale)}
          />
        ))}
      </div>
      <div className={styles.buttonRow}>
        <Toggle
          label={settings.time.lockedDay !== null ? 'Season locked' : 'Lock the season'}
          on={settings.time.lockedDay !== null}
          onClick={() => set('time.lockedDay', settings.time.lockedDay === null ? Math.floor(clock.day) : null)}
        />
        <Toggle
          label="Rain raises the stream"
          on={e.rainRaisesStream}
          onClick={() => set('ecosystem.rainRaisesStream', !e.rainRaisesStream)}
        />
      </div>

      {eco && (
        <div className={styles.readout} data-testid="eco-readout">
          {WEATHER_NAMES[eco.weather as WeatherKind] ?? eco.weather} · {eco.discharge.toFixed(1)} m³/s ·{' '}
          {eco.waterTemp.toFixed(1)} °C · O₂ {eco.oxygenMin.toFixed(1)}–{eco.oxygen.toFixed(1)} mg/L
        </div>
      )}
      {eco && (
        <div className={styles.ecoTable}>
          {eco.names.map((n, i) => (
            <div key={n} className={styles.ecoRow}>
              <span>{n}</span>
              <span>{Math.round(eco.populations[i] ?? 0)}</span>
              <span title="Average color brightness">✦ {Math.round((eco.brightness[i] ?? 0) * 100)}</span>
              <span title="Average swim strength">➶ {Math.round((eco.swimStrength[i] ?? 0) * 100)}</span>
            </div>
          ))}
          <div className={styles.ecoRow}>
            <span>Plants</span>
            <span>{eco.plants}</span>
            <span title="Growth (0) versus spread (100)">⇢ {Math.round(eco.plantGene * 100)}</span>
            <span />
          </div>
        </div>
      )}

      <div className={styles.subhead}>Graphs</div>
      <div className={styles.buttonRow}>
        {GRAPHS.map(([k, label]) => (
          <Toggle key={k} label={label} on={graph === k} onClick={() => setGraph(k)} />
        ))}
      </div>
      <EcoGraph kind={graph} names={names} points={points} revision={eco?.historyRevision ?? 0} />

      <div className={styles.subhead}>Evolution</div>
      <div className={styles.buttonRow}>
        <Toggle
          label={e.evolution ? 'Evolution on' : 'Evolution off'}
          on={e.evolution}
          onClick={() => set('ecosystem.evolution', !e.evolution)}
          testId="toggle-evolution"
        />
        <Toggle label="Kingfisher" on={e.kingfisher} onClick={() => set('ecosystem.kingfisher', !e.kingfisher)} />
        <Toggle label="Seed-stock floor" on={e.restock} onClick={() => set('ecosystem.restock', !e.restock)} />
      </div>
      <SliderRow
        label="Mutation rate"
        value={e.mutation}
        min={LIMITS.mutation[0]}
        max={LIMITS.mutation[1]}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onCommit={(v) => set('ecosystem.mutation', v)}
      />
      <SliderRow
        label="Predator pressure"
        value={e.predators}
        min={LIMITS.predators[0]}
        max={LIMITS.predators[1]}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => set('ecosystem.predators', v)}
        testId="slider-predators"
        hint="Low pressure lets the fish grow more vivid over the generations"
      />
      <SliderRow
        label="Population caps"
        value={e.caps}
        min={LIMITS.caps[0]}
        max={LIMITS.caps[1]}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onCommit={(v) => set('ecosystem.caps', v)}
        hint="How many fish each stretch of water can hold"
      />

      <div className={styles.subhead}>Overlays</div>
      <div className={styles.buttonRow}>
        {OVERLAYS.map(([k, label]) => (
          <Toggle key={k} label={label} on={overlay === k} onClick={() => builder.setOverlay(k)} />
        ))}
      </div>
    </>
  );
}

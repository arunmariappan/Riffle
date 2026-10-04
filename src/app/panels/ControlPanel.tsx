import { useState } from 'react';
import { Tabs } from 'radix-ui';
import { useUi } from '../../state/store';
import type { Builder } from '../../engine/builder/Builder';
import { SliderRow } from '../ui/SliderRow';
import { WindDial } from '../ui/WindDial';
import { LIMITS } from '../../state/settings';
import { beaufort, CALM_BREEZE, MONSOON_STORM } from '../../sim/wind/windField';
import { WEATHER_KINDS, WEATHER_NAMES } from '../../sim/weather/weather';
import { TIME_SPEEDS } from '../../sim/time/clock';
import styles from '../ui.module.css';

const SPEEDS: [string, number][] = [
  ['Real time', TIME_SPEEDS.realtime],
  ['1 min = 1 hour', TIME_SPEEDS.minuteIsHour],
  ['1 min = 1 day', TIME_SPEEDS.minuteIsDay],
  ['Season lapse', TIME_SPEEDS.seasonLapse],
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEASON_NAMES: Record<string, string> = {
  winter: 'Winter',
  spring: 'Spring',
  premonsoon: 'Pre-monsoon',
  monsoon: 'Monsoon',
  autumn: 'Autumn',
};

function dayLabel(day: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + Math.floor(day)));
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function hourLabel(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** The control panels (plan 6.8): Water, Wind, Trees, Time & weather. Every slider changes the world live. */
export function ControlPanel({ builder }: { builder: Builder }) {
  const settings = useUi((s) => s.settings);
  const clock = useUi((s) => s.clock);
  const world = builder.world;
  const set = (path: string, v: unknown) => void builder.setSetting(path, v);
  const [species, setSpecies] = useState(() => world.catalog.trees[0]?.id ?? '');
  const b = beaufort(settings.wind.speed);
  return (
    <Tabs.Root className={styles.panel} defaultValue="water">
      <Tabs.List className={styles.tabs} aria-label="Controls">
        <Tabs.Trigger className={styles.tab} value="water">
          Water
        </Tabs.Trigger>
        <Tabs.Trigger className={styles.tab} value="wind">
          Wind
        </Tabs.Trigger>
        <Tabs.Trigger className={styles.tab} value="trees">
          Trees
        </Tabs.Trigger>
        <Tabs.Trigger className={styles.tab} value="time">
          Time &amp; weather
        </Tabs.Trigger>
      </Tabs.List>

      <Tabs.Content className={styles.tabBody} value="water">
        <SliderRow
          label="Water flow"
          value={settings.water.discharge}
          min={LIMITS.discharge[0]}
          max={LIMITS.discharge[1]}
          step={0.1}
          format={(v) => `${v.toFixed(1)} m³/s`}
          onCommit={(v) => set('water.discharge', v)}
          testId="slider-discharge"
          hint="Discharge: more water raises and speeds up the stream"
        />
        <SliderRow
          label="Water speed"
          value={settings.water.speed}
          min={LIMITS.speed[0]}
          max={LIMITS.speed[1]}
          step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onCommit={(v) => set('water.speed', v)}
        />
        <SliderRow
          label="Water level"
          value={settings.water.level}
          min={LIMITS.level[0]}
          max={LIMITS.level[1]}
          step={0.02}
          format={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} m`}
          onCommit={(v) => set('water.level', v)}
        />
        <SliderRow
          label="Clarity"
          value={settings.water.clarity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set('water.clarity', v)}
        />
        <button className={styles.button} onClick={() => builder.setTool('spring')}>
          Spring tool: click a bank to add a side brook
        </button>
      </Tabs.Content>

      <Tabs.Content className={styles.tabBody} value="wind">
        <WindDial
          dirX={settings.wind.dirX}
          dirZ={settings.wind.dirZ}
          onChange={(x, z) => set('wind', { ...settings.wind, dirX: x, dirZ: z })}
        />
        <SliderRow
          label="Wind speed"
          value={settings.wind.speed}
          min={LIMITS.windSpeed[0]}
          max={LIMITS.windSpeed[1]}
          step={0.1}
          format={(v) => `${v.toFixed(1)} m/s · ${beaufort(v).name}`}
          onChange={(v) => set('wind.speed', v)}
          testId="slider-wind-speed"
          hint={`Beaufort ${b.force}`}
        />
        <SliderRow
          label="Gustiness"
          value={settings.wind.gustiness}
          min={LIMITS.gustiness[0]}
          max={LIMITS.gustiness[1]}
          step={0.01}
          onChange={(v) => set('wind.gustiness', v)}
        />
        <SliderRow
          label="Turbulence"
          value={settings.wind.turbulence}
          min={LIMITS.turbulence[0]}
          max={LIMITS.turbulence[1]}
          step={0.01}
          onChange={(v) => set('wind.turbulence', v)}
        />
        <div className={styles.buttonRow}>
          <button className={styles.button} onClick={() => set('wind', { ...CALM_BREEZE })}>
            Calm breeze
          </button>
          <button className={styles.button} onClick={() => set('wind', { ...MONSOON_STORM })}>
            Monsoon storm
          </button>
        </div>
      </Tabs.Content>

      <Tabs.Content className={styles.tabBody} value="trees">
        <SliderRow
          label="Flexibility"
          value={settings.trees.flexibility}
          min={LIMITS.flexibility[0]}
          max={LIMITS.flexibility[1]}
          step={0.01}
          onChange={(v) => set('trees.flexibility', v)}
          testId="slider-flexibility"
        />
        <SliderRow
          label="Sway strength"
          value={settings.trees.sway}
          min={LIMITS.sway[0]}
          max={LIMITS.sway[1]}
          step={0.01}
          onChange={(v) => set('trees.sway', v)}
        />
        <SliderRow
          label="Leaf flutter"
          value={settings.trees.flutter}
          min={LIMITS.flutter[0]}
          max={LIMITS.flutter[1]}
          step={0.01}
          onChange={(v) => set('trees.flutter', v)}
        />
        <SliderRow
          label="Response delay"
          value={settings.trees.delay}
          min={LIMITS.delay[0]}
          max={LIMITS.delay[1]}
          step={0.01}
          onChange={(v) => set('trees.delay', v)}
          hint="How heavy the branches feel"
        />
        <div className={styles.subhead}>Per species</div>
        <select className={styles.select} value={species} onChange={(e) => setSpecies(e.target.value)}>
          {world.catalog.trees.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <SliderRow
          label="Flexibility"
          value={settings.trees.species[species] ?? 1}
          min={LIMITS.speciesFlex[0]}
          max={LIMITS.speciesFlex[1]}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => set(`trees.species.${species}`, v)}
        />
      </Tabs.Content>

      <Tabs.Content className={styles.tabBody} value="time">
        <div className={styles.readout}>
          {dayLabel(clock.day)} · {hourLabel(clock.hour)} · {SEASON_NAMES[clock.season] ?? clock.season} · year{' '}
          {clock.year + 1}
        </div>
        <SliderRow
          label="Time of day"
          value={clock.hour}
          min={0}
          max={24}
          step={0.05}
          format={hourLabel}
          onChange={(v) => world.clock.setHour(v)}
        />
        <SliderRow
          label="Day of year"
          value={clock.day}
          min={0}
          max={364}
          step={1}
          format={dayLabel}
          onChange={(v) => world.clock.setTime(v, world.clock.hour)}
        />
        <div className={styles.subhead}>Speed</div>
        <div className={styles.buttonRow}>
          {SPEEDS.map(([label, scale]) => (
            <button
              key={label}
              className={settings.time.timeScale === scale ? styles.buttonOn : styles.button}
              onClick={() => set('time.timeScale', scale)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={settings.time.paused ? styles.buttonOn : styles.button}
            onClick={() => set('time.paused', !settings.time.paused)}
          >
            {settings.time.paused ? 'Paused' : 'Pause'}
          </button>
          <button
            className={settings.time.lockedDay !== null ? styles.buttonOn : styles.button}
            onClick={() => set('time.lockedDay', settings.time.lockedDay === null ? Math.floor(clock.day) : null)}
          >
            {settings.time.lockedDay !== null
              ? `Season locked (${dayLabel(settings.time.lockedDay)})`
              : 'Lock the season'}
          </button>
        </div>
        <div className={styles.subhead}>Weather</div>
        <select
          className={styles.select}
          value={settings.weather.mode}
          onChange={(e) => set('weather.mode', e.target.value)}
          aria-label="Weather"
        >
          <option value="auto">Follow the seasons</option>
          {WEATHER_KINDS.map((k) => (
            <option key={k} value={k}>
              {WEATHER_NAMES[k]}
            </option>
          ))}
        </select>
      </Tabs.Content>
    </Tabs.Root>
  );
}

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { EcologyPoint } from '../../sim/ecology/ecology';
import styles from '../ui.module.css';

export type GraphKind = 'populations' | 'biodiversity' | 'water' | 'brightness';

/** Series colors per species (barb red, loach brown, mahseer gold…), cycled for new species. */
const PALETTE = ['#e0573a', '#9a7a52', '#e8b33a', '#7fc8e8', '#ff8f5a', '#5ed49a', '#c77ddb', '#f4e06d'];

function seriesFor(kind: GraphKind, names: readonly string[]): uPlot.Series[] {
  const x: uPlot.Series = { label: 'Year', value: (_u, v) => (v === null ? '' : (v + 1).toFixed(2)) };
  const line = (label: string, stroke: string, unit = ''): uPlot.Series => ({
    label,
    stroke,
    width: 1.5,
    value: (_u, v) => (v === null ? '' : `${v.toFixed(v < 10 ? 2 : 0)}${unit}`),
  });
  switch (kind) {
    case 'populations':
      return [x, ...names.map((n, i) => line(n, PALETTE[i % PALETTE.length] as string))];
    case 'brightness':
      return [x, ...names.map((n, i) => line(n, PALETTE[i % PALETTE.length] as string))];
    case 'biodiversity':
      return [x, line('Diversity', '#8fd18f')];
    case 'water':
      return [
        x,
        line('Oxygen', '#7fc8e8', ' mg/L'),
        line('Dawn oxygen', '#3a7fbf', ' mg/L'),
        line('Temperature', '#e8a05a', ' °C'),
        line('Flow', '#c8c8c8', ' m³/s'),
      ];
  }
}

function dataFor(kind: GraphKind, points: readonly EcologyPoint[], species: number): uPlot.AlignedData {
  const x = points.map((p) => p.day / 365);
  switch (kind) {
    case 'populations':
      return [x, ...Array.from({ length: species }, (_, i) => points.map((p) => p.populations[i] ?? 0))];
    case 'brightness':
      return [x, ...Array.from({ length: species }, (_, i) => points.map((p) => p.brightness[i] ?? 0))];
    case 'biodiversity':
      return [x, points.map((p) => p.biodiversity)];
    case 'water':
      return [
        x,
        points.map((p) => p.oxygen),
        points.map((p) => p.oxygenMin),
        points.map((p) => p.waterTemp),
        points.map((p) => p.discharge),
      ];
  }
}

/**
 * A graph of the ecosystem over time (plan 6.6: populations, biodiversity, water quality, average color brightness),
 * drawn with uPlot. `points` is the ecology's history; the graph redraws when `revision` changes.
 */
export function EcoGraph({
  kind,
  names,
  points,
  revision,
}: {
  kind: GraphKind;
  names: readonly string[];
  points: () => readonly EcologyPoint[];
  revision: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const axis: uPlot.Axis = { stroke: '#b9c2bd', grid: { stroke: 'rgba(255,255,255,0.08)' }, ticks: { show: false } };
    const u = new uPlot(
      {
        width: el.clientWidth || 300,
        height: 170,
        scales: { x: { time: false } },
        axes: [{ ...axis, label: 'year', values: (_u, ticks) => ticks.map((t) => String(Math.floor(t) + 1)) }, axis],
        series: seriesFor(kind, names),
        legend: { show: true, live: false },
        cursor: { drag: { x: false, y: false } },
      },
      dataFor(kind, points(), names.length),
      el,
    );
    plot.current = u;
    const resize = new ResizeObserver(() => u.setSize({ width: el.clientWidth || 300, height: 170 }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      u.destroy();
      plot.current = null;
    };
    // The plot is rebuilt when its kind or species change; new data comes in through the effect below.
  }, [kind, names]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    plot.current?.setData(dataFor(kind, points(), names.length));
  }, [revision, kind, names, points]);

  return <div ref={box} className={styles.graph} data-testid={`graph-${kind}`} />;
}

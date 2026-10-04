import { useEffect, useState } from 'react';
import type { Engine, EngineStats } from '../engine/Engine';
import { QUALITY_PRESETS, type QualityPreset } from '../engine/post/pipeline';

/** Small performance readout (fps, CPU and GPU ms, draw calls) with a quality switch. Updates at 4 Hz. */
export function StatsOverlay({
  engine,
  quality,
  onQuality,
}: {
  engine: Engine;
  quality: QualityPreset;
  onQuality: (q: QualityPreset) => void;
}) {
  const [stats, setStats] = useState<EngineStats>({ ...engine.stats });
  useEffect(() => {
    const id = window.setInterval(() => setStats({ ...engine.stats }), 250);
    return () => window.clearInterval(id);
  }, [engine]);

  return (
    <div className="stats" data-testid="stats">
      <span>{stats.fps.toFixed(0)} fps</span>
      <span>CPU {stats.cpuMs.toFixed(1)} ms</span>
      <span>GPU {stats.gpuMs > 0 ? `${stats.gpuMs.toFixed(1)} ms` : '–'}</span>
      <span>{stats.drawCalls} draws</span>
      <select value={quality} onChange={(e) => onQuality(e.target.value as QualityPreset)} aria-label="Quality">
        {QUALITY_PRESETS.map((q) => (
          <option key={q} value={q}>
            {q}
          </option>
        ))}
      </select>
    </div>
  );
}

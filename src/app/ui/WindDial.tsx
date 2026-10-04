import { useRef } from 'react';
import styles from '../ui.module.css';

/**
 * The Wind panel's direction dial (plan 6.3): drag around the circle to set where the wind blows toward. The arrow
 * points along the wind in map view (north up = −z).
 */
export function WindDial({
  dirX,
  dirZ,
  onChange,
}: {
  dirX: number;
  dirZ: number;
  onChange: (x: number, z: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const set = (clientX: number, clientY: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = clientX - (r.left + r.width / 2);
    const y = clientY - (r.top + r.height / 2);
    const len = Math.hypot(x, y);
    if (len < 4) return;
    // Screen up is north (−z), screen right is east (+x).
    onChange(x / len, y / len);
  };
  const angle = (Math.atan2(dirX, -dirZ) * 180) / Math.PI;
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((angle + 360) % 360) / 45) % 8];
  return (
    <div className={styles.dialRow}>
      <svg
        ref={ref}
        className={styles.dial}
        viewBox="-50 -50 100 100"
        role="slider"
        aria-label="Wind direction"
        aria-valuenow={Math.round((angle + 360) % 360)}
        aria-valuemin={0}
        aria-valuemax={359}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          set(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) set(e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowRight' ? 15 : e.key === 'ArrowLeft' ? -15 : 0;
          if (!step) return;
          const a = ((angle + step) * Math.PI) / 180;
          onChange(Math.sin(a), -Math.cos(a));
        }}
      >
        <circle r="44" className={styles.dialFace} />
        {['N', 'E', 'S', 'W'].map((l, i) => (
          <text key={l} x={[0, 36, 0, -36][i]} y={[-32, 4, 40, 4][i]} textAnchor="middle" className={styles.dialText}>
            {l}
          </text>
        ))}
        <g transform={`rotate(${angle})`}>
          <line x1="0" y1="22" x2="0" y2="-26" className={styles.dialArrow} />
          <path d="M0 -34 L8 -20 L-8 -20 Z" className={styles.dialHead} />
        </g>
      </svg>
      <span className={styles.dialLabel}>Blowing toward {compass}</span>
    </div>
  );
}

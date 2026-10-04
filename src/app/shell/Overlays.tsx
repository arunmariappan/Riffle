import { useUi } from '../../state/store';
import { colormapHex } from '../../builder/colormap';
import styles from '../ui.module.css';

/** The placement reason next to the cursor while dragging (green: fine, red: why not). */
export function PlacementHint() {
  const hint = useUi((s) => s.hint);
  if (!hint) return null;
  return (
    <div
      className={hint.ok ? styles.hintOk : styles.hintBad}
      style={{ left: hint.x + 18, top: hint.y + 14 }}
      role="status"
      data-testid="placement-hint"
    >
      {hint.text}
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className={styles.toasts} aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          className={t.kind === 'error' ? styles.toastError : styles.toast}
          onClick={() => dismiss(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

/** The color scale of the active overlay. */
export function Legend() {
  const legend = useUi((s) => s.legend);
  if (!legend) return null;
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${colormapHex(t)} ${t * 100}%`).join(', ');
  return (
    <div className={styles.legend}>
      <div>{legend.label}</div>
      <div className={styles.legendBar} style={{ background: `linear-gradient(90deg, ${stops})` }} />
      <div className={styles.legendScale}>
        <span>
          {legend.min} {legend.unit}
        </span>
        <span>
          {legend.max} {legend.unit}
        </span>
      </div>
    </div>
  );
}

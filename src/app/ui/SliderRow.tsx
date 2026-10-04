import { useEffect, useRef, useState } from 'react';
import { Slider } from 'radix-ui';
import styles from '../ui.module.css';

export interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Formats the value readout. */
  format?: (v: number) => string;
  /** Called while dragging (cheap settings apply live). */
  onChange?: (v: number) => void;
  /** Called when the drag ends (expensive settings, like the water, apply here). */
  onCommit?: (v: number) => void;
  testId?: string;
  hint?: string;
}

/** A labelled Radix slider with a value readout (plan 6.8: every slider changes the world live). */
export function SliderRow({ label, value, min, max, step, format, onChange, onCommit, testId, hint }: SliderRowProps) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  const text = format ? format(local) : local.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0);
  return (
    <div className={styles.sliderRow} title={hint}>
      <div className={styles.sliderLabel}>
        <span>{label}</span>
        <span className={styles.sliderValue}>{text}</span>
      </div>
      <Slider.Root
        className={styles.slider}
        value={[local]}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onValueChange={([v]) => {
          if (v === undefined) return;
          dragging.current = true;
          setLocal(v);
          onChange?.(v);
        }}
        onValueCommit={([v]) => {
          dragging.current = false;
          if (v !== undefined) onCommit?.(v);
        }}
      >
        <Slider.Track className={styles.sliderTrack}>
          <Slider.Range className={styles.sliderRange} />
        </Slider.Track>
        <Slider.Thumb className={styles.sliderThumb} aria-label={label} />
      </Slider.Root>
    </div>
  );
}

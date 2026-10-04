import { Dialog } from 'radix-ui';
import { useUi } from '../../state/store';
import { PREFERENCE_LIMITS } from '../../state/preferences';
import { QUALITY, QUALITY_PRESETS, type QualityPreset } from '../../state/quality';
import { SliderRow } from '../ui/SliderRow';
import { CONTROLS } from '../controls';
import styles from '../ui.module.css';

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={on ? styles.buttonOn : styles.button} onClick={onClick} aria-pressed={on}>
      {label}
    </button>
  );
}

/**
 * Settings (plan 9): graphics (quality preset, dynamic resolution, frame cap), comfort (field of view, mouse, invert,
 * head bob, softer lightning), sound, and the controls guide. Kept in this browser.
 */
export function SettingsDialog({
  quality,
  onQuality,
}: {
  quality: QualityPreset;
  onQuality: (q: QualityPreset) => void;
}) {
  const prefs = useUi((s) => s.prefs);
  const set = useUi((s) => s.setPrefs);
  return (
    <Dialog.Root>
      <Dialog.Trigger className={styles.button} aria-label="Settings" title="Settings" data-testid="settings">
        ⚙
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <Dialog.Title className={styles.dialogTitle}>Settings</Dialog.Title>

          <div className={styles.subhead}>Graphics</div>
          <div className={styles.buttonRow}>
            {QUALITY_PRESETS.map((q) => (
              <button
                key={q}
                className={quality === q ? styles.buttonOn : styles.button}
                onClick={() => onQuality(q)}
                title={QUALITY[q].description}
                data-testid={`quality-${q}`}
              >
                {QUALITY[q].label}
              </button>
            ))}
          </div>
          <div className={styles.readout}>{QUALITY[quality].description}</div>
          <div className={styles.buttonRow}>
            <Toggle
              label="Dynamic resolution"
              on={prefs.dynamicResolution}
              onClick={() => set({ dynamicResolution: !prefs.dynamicResolution })}
            />
            <Toggle label="60 fps" on={prefs.maxFps === 60} onClick={() => set({ maxFps: 60 })} />
            <Toggle label="30 fps (cooler, quieter)" on={prefs.maxFps === 30} onClick={() => set({ maxFps: 30 })} />
          </div>

          <div className={styles.subhead}>Comfort</div>
          <SliderRow
            label="Field of view"
            value={prefs.fov}
            min={PREFERENCE_LIMITS.fov[0]}
            max={PREFERENCE_LIMITS.fov[1]}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) => set({ fov: v })}
          />
          <SliderRow
            label="Mouse sensitivity"
            value={prefs.mouseSensitivity}
            min={PREFERENCE_LIMITS.mouseSensitivity[0]}
            max={PREFERENCE_LIMITS.mouseSensitivity[1]}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => set({ mouseSensitivity: v })}
          />
          <div className={styles.buttonRow}>
            <Toggle label="Invert mouse Y" on={prefs.invertY} onClick={() => set({ invertY: !prefs.invertY })} />
            <Toggle label="Head bob" on={prefs.headBob} onClick={() => set({ headBob: !prefs.headBob })} />
            <Toggle
              label="Softer lightning"
              on={prefs.reduceFlashes}
              onClick={() => set({ reduceFlashes: !prefs.reduceFlashes })}
            />
          </div>

          <div className={styles.subhead}>Sound</div>
          <SliderRow
            label="Volume"
            value={prefs.volume}
            min={0}
            max={1}
            step={0.01}
            format={(v) => (prefs.muted ? 'muted' : `${Math.round(v * 100)}%`)}
            onChange={(v) => set({ volume: v, muted: false })}
          />

          <div className={styles.subhead}>Controls</div>
          <div className={styles.controls}>
            {CONTROLS.map((group) => (
              <div key={group.mode}>
                <strong>{group.mode}</strong>
                {group.keys.map(([k, what]) => (
                  <div key={k} className={styles.controlRow}>
                    <kbd>{k}</kbd>
                    <span>{what}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <Dialog.Close className={styles.button}>Done</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

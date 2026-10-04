import { useUi } from '../../state/store';
import type { Builder } from '../../engine/builder/Builder';
import styles from '../ui.module.css';

const TRAITS: [keyof NonNullable<ReturnType<typeof useUi.getState>['inspect']>['genes'], string][] = [
  ['bodySize', 'Body size'],
  ['swimStrength', 'Swim strength'],
  ['preferredFlow', 'Likes fast water'],
  ['brightness', 'Brightness'],
  ['shyness', 'Shyness'],
];

function years(age: number): string {
  if (age < 1) return `${Math.max(1, Math.round(age * 12))} months`;
  return `${age.toFixed(age < 10 ? 1 : 0)} years`;
}

/** The fish card (plan 6.5): species, size, age and its five traits; follow it with the camera. */
export function FishCard({ builder }: { builder: Builder }) {
  const info = useUi((s) => s.inspect);
  if (!info) return null;
  return (
    <div className={styles.fishCard} role="dialog" aria-label={info.name} data-testid="fish-card">
      <div className={styles.fishTitle}>{info.name}</div>
      <div className={styles.small}>
        {info.lengthCm < 10 ? info.lengthCm.toFixed(1) : Math.round(info.lengthCm)} cm · {years(info.age)}
      </div>
      {TRAITS.map(([key, label]) => (
        <div key={key} className={styles.trait}>
          <span>{label}</span>
          <span className={styles.traitBar}>
            <span style={{ width: `${Math.round(info.genes[key] * 100)}%` }} />
          </span>
        </div>
      ))}
      <div className={styles.buttonRow}>
        <button className={info.following ? styles.buttonOn : styles.button} onClick={() => builder.toggleFollow()}>
          {info.following ? 'Stop following' : 'Follow'}
        </button>
        <button className={styles.button} onClick={() => builder.closeInspect()}>
          Close
        </button>
      </div>
    </div>
  );
}

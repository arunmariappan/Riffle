import { DropdownMenu } from 'radix-ui';
import { useUi, type AppMode } from '../../state/store';
import styles from '../ui.module.css';

export interface TopBarProps {
  onMode: (mode: AppMode) => void;
  onSave: () => void;
  onOpen: () => void;
  onNew: () => void;
  savedAt: string | null;
}

const MODES: [AppMode, string, string][] = [
  ['explore', 'Explore', 'Walk, wade and swim (Tab)'],
  ['builder', 'Build', 'Shape the valley (Tab)'],
  ['photo', 'Photo', 'Photo mode arrives in Phase 8'],
];

/** Mode switch and the valley menu (save, open, new). */
export function TopBar({ onMode, onSave, onOpen, onNew, savedAt }: TopBarProps) {
  const mode = useUi((s) => s.mode);
  return (
    <div className={styles.topbar}>
      <span className={styles.brand}>Riffle</span>
      <div className={styles.segmented} role="radiogroup" aria-label="Mode">
        {MODES.map(([id, label, hint]) => (
          <button
            key={id}
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? styles.segmentOn : styles.segment}
            title={hint}
            disabled={id === 'photo'}
            onClick={() => onMode(id)}
            data-testid={`mode-${id}`}
          >
            {label}
          </button>
        ))}
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={styles.button}>Valley ▾</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={styles.menu} sideOffset={6} align="end">
            <DropdownMenu.Item className={styles.menuItem} onSelect={onSave}>
              Save valley as…
            </DropdownMenu.Item>
            <DropdownMenu.Item className={styles.menuItem} onSelect={onOpen}>
              Open valley…
            </DropdownMenu.Item>
            <DropdownMenu.Separator className={styles.menuSeparator} />
            <DropdownMenu.Item className={styles.menuItem} onSelect={onNew}>
              New valley…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {savedAt && <span className={styles.small}>Autosaved {savedAt}</span>}
    </div>
  );
}

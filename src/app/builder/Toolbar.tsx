import { useUi, type BuilderTool, type OverlayChoice } from '../../state/store';
import type { Builder } from '../../engine/builder/Builder';
import { SliderRow } from '../ui/SliderRow';
import styles from '../ui.module.css';

const TOOLS: [BuilderTool, string, string][] = [
  ['select', 'Select', 'Click to select, Shift+click to add; drag the gizmo to move (1 move · 2 turn · 3 scale)'],
  ['scatter', 'Scatter', 'Paint the chosen catalog item (plants, pebbles) with natural spacing'],
  ['erase', 'Erase', 'Remove plants and stones under the brush'],
  ['grass', 'Grass', 'Paint grass; hold Shift to clear it'],
  ['spring', 'Spring', 'Click a bank to add a side brook'],
];

const OVERLAYS: [OverlayChoice, string][] = [
  ['none', 'No overlay'],
  ['flow', 'Flow arrows'],
  ['depth', 'Water depth'],
  ['speed', 'Current speed'],
];

/** Builder tools, brush settings, selection actions, undo/redo and overlays (plan 6.8). */
export function Toolbar({ builder }: { builder: Builder }) {
  const tool = useUi((s) => s.tool);
  const gizmo = useUi((s) => s.gizmo);
  const brush = useUi((s) => s.brush);
  const selection = useUi((s) => s.selection);
  const undo = useUi((s) => s.undo);
  const overlay = useUi((s) => s.overlay);
  const busy = useUi((s) => s.busy);
  const set = useUi((s) => s.set);
  const brushTool = tool === 'scatter' || tool === 'erase' || tool === 'grass';
  return (
    <div className={styles.toolbar}>
      <div className={styles.buttonRow} role="toolbar" aria-label="Tools">
        {TOOLS.map(([id, label, hint]) => (
          <button
            key={id}
            title={hint}
            className={tool === id ? styles.buttonOn : styles.button}
            onClick={() => builder.setTool(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {brushTool && (
        <div className={styles.toolRow}>
          <SliderRow
            label="Brush size"
            value={brush.radius}
            min={0.5}
            max={15}
            step={0.1}
            format={(v) => `${v.toFixed(1)} m`}
            onChange={(v) => set({ brush: { ...useUi.getState().brush, radius: v } })}
          />
          <SliderRow
            label={tool === 'grass' ? 'Strength' : 'Density'}
            value={brush.density}
            min={0.05}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ brush: { ...useUi.getState().brush, density: v } })}
          />
        </div>
      )}
      {selection.length > 0 && (
        <div className={styles.buttonRow}>
          <span className={styles.small}>
            {selection.length === 1 ? selection[0]?.name : `${selection.length} selected`}
          </span>
          {(['translate', 'rotate', 'scale'] as const).map((m, i) => (
            <button
              key={m}
              className={gizmo === m ? styles.buttonOn : styles.button}
              onClick={() => builder.setGizmoMode(m)}
              title={`${['Move', 'Turn', 'Scale'][i]} (${i + 1})`}
            >
              {['Move', 'Turn', 'Scale'][i]}
            </button>
          ))}
          <button className={styles.buttonDanger} onClick={() => void builder.deleteSelection()} title="Delete">
            Delete
          </button>
        </div>
      )}
      <div className={styles.buttonRow}>
        <button
          className={styles.button}
          disabled={!undo.canUndo}
          onClick={() => void builder.undoStep()}
          title="Ctrl+Z"
          data-testid="undo"
        >
          Undo{undo.undoLabel ? ` ${undo.undoLabel}` : ''}
        </button>
        <button
          className={styles.button}
          disabled={!undo.canRedo}
          onClick={() => void builder.redoStep()}
          title="Ctrl+Y"
          data-testid="redo"
        >
          Redo{undo.redoLabel ? ` ${undo.redoLabel}` : ''}
        </button>
        <select
          className={styles.select}
          value={overlay}
          onChange={(e) => builder.setOverlay(e.target.value as OverlayChoice)}
          aria-label="Overlay"
        >
          {OVERLAYS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button className={styles.button} onClick={() => builder.world.exploreFromBuilder()} title="Walk from here">
          Explore from here
        </button>
      </div>
      {busy && <div className={styles.small}>{busy}…</div>}
    </div>
  );
}

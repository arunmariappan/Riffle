/**
 * The shared store between the UI and the engine (plan principle 3): React reads it, the engine writes snapshots into
 * it a few times a second, and UI actions go to the engine as commands (never through per-frame React renders).
 */
import { create } from 'zustand';
import type { UndoState } from '../builder/undo';
import { defaultSettings, type ValleySettings } from './settings';
import { loadPreferences, savePreferences, type Preferences } from './preferences';
import type { ItemCategory } from '../builder/editLayer';

export type AppMode = 'explore' | 'builder' | 'photo';
export type BuilderTool = 'select' | 'scatter' | 'erase' | 'grass' | 'spring';
export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type OverlayChoice = 'none' | 'flow' | 'depth' | 'speed' | 'oxygen' | 'light' | 'temperature' | 'fish';
export type CatalogTab = 'fish' | 'plants' | 'stones' | 'trees' | 'bushes';

export interface PlacementHint {
  ok: boolean;
  text: string;
  /** Screen position (CSS pixels). */
  x: number;
  y: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

export interface ClockSnapshot {
  hour: number;
  day: number;
  season: string;
  year: number;
}

export interface SelectedInfo {
  uid: string;
  category: ItemCategory;
  kind: string;
  name: string;
}

/** The fish card (plan 6.5: click a fish to see its species, age, size and traits). */
export interface FishInfo {
  id: number;
  name: string;
  /** Body length, cm. */
  lengthCm: number;
  /** Years. */
  age: number;
  genes: { bodySize: number; swimStrength: number; preferredFlow: number; brightness: number; shyness: number };
  following: boolean;
}

/** The Ecosystem panel's readout (plan 6.6), refreshed a few times a second. */
export interface EcologyUi {
  /** Species names, in the same order as the numbers below. */
  names: string[];
  /** Juveniles and adults per species in the whole valley, and fry. */
  populations: number[];
  fry: number[];
  /** Average color brightness and swim strength (adults), 0..1. */
  brightness: number[];
  swimStrength: number[];
  /** Shannon diversity of the fish. */
  biodiversity: number;
  /** Mean dissolved oxygen and the lowest dawn oxygen, mg/L; mean water temperature, °C. */
  oxygen: number;
  oxygenMin: number;
  waterTemp: number;
  /** The stream now, m³/s, and the weather the valley has. */
  discharge: number;
  weather: string;
  turbidity: number;
  /** Ground and water plants, and their average growth-versus-spread gene. */
  plants: number;
  plantGene: number;
  /** Bumped when new graph points arrive. */
  historyRevision: number;
}

export interface UiState {
  mode: AppMode;
  tool: BuilderTool;
  gizmo: GizmoMode;
  brush: { radius: number; density: number };
  /** Which categories the eraser removes. */
  eraseCategories: ItemCategory[];
  schoolSize: number;
  catalogTab: CatalogTab;
  /** Catalog item used by the scatter brush. */
  brushItem: string | null;
  hint: PlacementHint | null;
  selection: SelectedInfo[];
  undo: UndoState;
  settings: ValleySettings;
  overlay: OverlayChoice;
  legend: { label: string; unit: string; min: number; max: number } | null;
  thumbnails: Record<string, string>;
  toasts: Toast[];
  clock: ClockSnapshot;
  busy: string | null;
  inspect: FishInfo | null;
  ecology: EcologyUi | null;
  /** Photo mode: hide every control (H). */
  hideUi: boolean;
  /** Photo mode: show the rule-of-thirds grid. */
  photoGrid: boolean;
  /** Your preferences (sound), kept in this browser. */
  prefs: Preferences;
  setPrefs: (p: Partial<Preferences>) => void;
  set: (partial: Partial<UiState>) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
  setThumbnail: (id: string, url: string) => void;
}

let toastId = 1;

export const useUi = create<UiState>((set) => ({
  mode: 'explore',
  tool: 'select',
  gizmo: 'translate',
  brush: { radius: 3, density: 0.6 },
  eraseCategories: ['bushes', 'plants', 'stones'],
  schoolSize: 18,
  catalogTab: 'stones',
  brushItem: null,
  hint: null,
  selection: [],
  undo: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, size: 0 },
  settings: defaultSettings(),
  overlay: 'none',
  legend: null,
  thumbnails: {},
  toasts: [],
  clock: { hour: 8, day: 95, season: 'spring', year: 0 },
  busy: null,
  inspect: null,
  ecology: null,
  hideUi: false,
  photoGrid: false,
  prefs: loadPreferences(),
  setPrefs: (p) =>
    set((s) => {
      const prefs = { ...s.prefs, ...p };
      savePreferences(prefs);
      return { prefs };
    }),
  set: (partial) => set(partial),
  toast: (text, kind = 'info') => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setThumbnail: (id, url) => set((s) => ({ thumbnails: { ...s.thumbnails, [id]: url } })),
}));

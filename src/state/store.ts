/**
 * The shared store between the UI and the engine (plan principle 3): React reads it, the engine writes snapshots into
 * it a few times a second, and UI actions go to the engine as commands (never through per-frame React renders).
 */
import { create } from 'zustand';
import type { UndoState } from '../builder/undo';
import { defaultSettings, type ValleySettings } from './settings';
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
  set: (partial) => set(partial),
  toast: (text, kind = 'info') => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setThumbnail: (id, url) => set((s) => ({ thumbnails: { ...s.thumbnails, [id]: url } })),
}));

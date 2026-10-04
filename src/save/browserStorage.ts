/**
 * Browser storage for saves (plan 6.11): the Origin Private File System for autosaves, and the File System Access
 * API for "Save valley as…" / "Open valley…" (with download and file-input fallbacks). Asks for persistent storage
 * so the browser doesn't evict the autosaves.
 */
import { MemoryStore, type SaveStore } from './autosave';

/** The File System Access API pickers (Chrome and Edge), not in TypeScript's DOM types yet. */
interface PickerWindow {
  showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandle[]>;
}

interface IterableDirectory {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
}

export class OpfsStore implements SaveStore {
  private dir: Promise<FileSystemDirectoryHandle>;

  constructor(folder = 'riffle-saves') {
    this.dir = navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(folder, { create: true }));
  }

  async list(): Promise<string[]> {
    const dir = await this.dir;
    const names: string[] = [];
    for await (const [name, handle] of (dir as unknown as IterableDirectory).entries())
      if (handle.kind === 'file') names.push(name);
    return names;
  }

  async read(name: string): Promise<Uint8Array | null> {
    try {
      const file = await (await (await this.dir).getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await (await this.dir).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes as BufferSource);
    await writable.close();
  }

  async remove(name: string): Promise<void> {
    await (await this.dir).removeEntry(name).catch(() => undefined);
  }
}

/** OPFS when the browser has it, memory otherwise (autosaves then only last for the session). */
export function createSaveStore(): SaveStore {
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') return new OpfsStore();
  return new MemoryStore();
}

/** Asks the browser to keep our storage (plan 6.11). Returns whether it agreed. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

const PICKER_TYPES = [{ description: 'Riffle valley', accept: { 'application/x-riffle': ['.riffle'] } }];

/** "Save valley as…": a save dialog when the browser has one, a download otherwise. */
export async function saveToDisk(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  const w = window as unknown as PickerWindow;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: PICKER_TYPES });
      const writable = await handle.createWritable();
      await writable.write(bytes as BufferSource);
      await writable.close();
      return true;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return false;
      throw err;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** "Open valley…": an open dialog when the browser has one, a file input otherwise. Null when cancelled. */
export async function openFromDisk(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const w = window as unknown as PickerWindow;
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.riffle';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.click();
  });
}

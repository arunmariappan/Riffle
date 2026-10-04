/**
 * Undo and redo for the builder (plan 6.8): a command stack of 100 steps. Commands may be asynchronous (placing a
 * stone re-solves the flow), so every do/undo/redo runs through one queue and never overlaps another.
 * Pure TypeScript: no three.js or DOM, so it is unit-tested in Node.
 */

export interface Command {
  /** Shown in the UI ("Undo place boulder"). */
  readonly label: string;
  do(): void | Promise<void>;
  undo(): void | Promise<void>;
  /**
   * Folds a following command into this one (dragging a slider makes one undo step, not hundreds). Return true when
   * merged; the stack then drops `next` (its effect has already been applied by `next.do()`).
   */
  merge?(next: Command): boolean;
}

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  size: number;
}

export class UndoStack {
  readonly limit: number;
  private readonly done: Command[] = [];
  private readonly undone: Command[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(state: UndoState) => void>();

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** Runs a command and records it. Clears the redo branch. */
  execute(command: Command): Promise<void> {
    return this.enqueue(async () => {
      await command.do();
      const last = this.done[this.done.length - 1];
      if (!(last?.merge && last.merge(command))) {
        this.done.push(command);
        if (this.done.length > this.limit) this.done.shift();
      }
      this.undone.length = 0;
    });
  }

  /** Records a command whose effect has already happened (e.g. a gizmo drag that moved things live). */
  record(command: Command): void {
    const last = this.done[this.done.length - 1];
    if (!(last?.merge && last.merge(command))) {
      this.done.push(command);
      if (this.done.length > this.limit) this.done.shift();
    }
    this.undone.length = 0;
    this.notify();
  }

  undo(): Promise<boolean> {
    return this.enqueueResult(async () => {
      const command = this.done.pop();
      if (!command) return false;
      await command.undo();
      this.undone.push(command);
      return true;
    });
  }

  redo(): Promise<boolean> {
    return this.enqueueResult(async () => {
      const command = this.undone.pop();
      if (!command) return false;
      await command.do();
      this.done.push(command);
      return true;
    });
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.notify();
  }

  /** Resolves when every queued command has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  get state(): UndoState {
    const u = this.done[this.done.length - 1];
    const r = this.undone[this.undone.length - 1];
    return {
      canUndo: !!u,
      canRedo: !!r,
      undoLabel: u?.label ?? null,
      redoLabel: r?.label ?? null,
      size: this.done.length,
    };
  }

  subscribe(listener: (state: UndoState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const s = this.state;
    for (const l of this.listeners) l(s);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    // A failed command must not block the queue forever; the error still reaches the caller.
    this.queue = run.catch(() => undefined).then(() => this.notify());
    return run;
  }

  private enqueueResult<T>(task: () => Promise<T>): Promise<T> {
    let result: T;
    return this.enqueue(async () => {
      result = await task();
    }).then(() => result);
  }
}

/**
 * A command that sets a value (a slider). Consecutive changes of the same key within `windowMs` merge into one step
 * that undoes back to the value before the drag started.
 */
export class SetValueCommand<T> implements Command {
  readonly label: string;
  private readonly key: string;
  private readonly before: T;
  private after: T;
  private readonly apply: (value: T) => void | Promise<void>;
  private time: number;
  private readonly windowMs: number;

  constructor(options: {
    key: string;
    label: string;
    before: T;
    after: T;
    apply: (value: T) => void | Promise<void>;
    now?: number;
    windowMs?: number;
  }) {
    this.key = options.key;
    this.label = options.label;
    this.before = options.before;
    this.after = options.after;
    this.apply = options.apply;
    this.time = options.now ?? Date.now();
    this.windowMs = options.windowMs ?? 1200;
  }

  do(): void | Promise<void> {
    return this.apply(this.after);
  }

  undo(): void | Promise<void> {
    return this.apply(this.before);
  }

  merge(next: Command): boolean {
    if (!(next instanceof SetValueCommand) || next.key !== this.key) return false;
    if (next.time - this.time > this.windowMs) return false;
    this.after = next.after as T;
    this.time = next.time;
    return true;
  }
}

/** Several commands as one undo step (multi-select delete, a brush stroke). */
export class BatchCommand implements Command {
  readonly label: string;
  private readonly commands: Command[];

  constructor(label: string, commands: Command[]) {
    this.label = label;
    this.commands = commands;
  }

  async do(): Promise<void> {
    for (const c of this.commands) await c.do();
  }

  async undo(): Promise<void> {
    for (let i = this.commands.length - 1; i >= 0; i--) await (this.commands[i] as Command).undo();
  }
}

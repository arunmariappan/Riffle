import { describe, expect, it } from 'vitest';
import { BatchCommand, SetValueCommand, UndoStack, type Command } from '../../src/builder/undo';

/** A command that adds to a counter (and can be slow, like a flow re-solve). */
function add(state: { value: number; log: string[] }, n: number, delayMs = 0): Command {
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs));
  return {
    label: `add ${n}`,
    async do() {
      if (delayMs) await wait();
      state.value += n;
      state.log.push(`do ${n}`);
    },
    async undo() {
      if (delayMs) await wait();
      state.value -= n;
      state.log.push(`undo ${n}`);
    },
  };
}

describe('undo and redo', () => {
  it('undoes and redoes 100 steps', async () => {
    const s = { value: 0, log: [] as string[] };
    const stack = new UndoStack(100);
    for (let i = 1; i <= 100; i++) await stack.execute(add(s, i));
    expect(s.value).toBe(5050);
    for (let i = 0; i < 100; i++) expect(await stack.undo()).toBe(true);
    expect(s.value).toBe(0);
    expect(await stack.undo()).toBe(false);
    for (let i = 0; i < 100; i++) expect(await stack.redo()).toBe(true);
    expect(s.value).toBe(5050);
    expect(await stack.redo()).toBe(false);
  });

  it('keeps at most `limit` steps (the oldest drop off)', async () => {
    const s = { value: 0, log: [] as string[] };
    const stack = new UndoStack(100);
    for (let i = 0; i < 130; i++) await stack.execute(add(s, 1));
    let undone = 0;
    while (await stack.undo()) undone++;
    expect(undone).toBe(100);
    expect(s.value).toBe(30);
  });

  it('clears the redo branch on a new command', async () => {
    const s = { value: 0, log: [] as string[] };
    const stack = new UndoStack();
    await stack.execute(add(s, 1));
    await stack.execute(add(s, 2));
    await stack.undo();
    expect(stack.state.canRedo).toBe(true);
    await stack.execute(add(s, 5));
    expect(stack.state.canRedo).toBe(false);
    expect(s.value).toBe(6);
    expect(stack.state.undoLabel).toBe('add 5');
  });

  it('runs slow commands one at a time, in order', async () => {
    const s = { value: 0, log: [] as string[] };
    const stack = new UndoStack();
    // Fire without awaiting, like fast clicks while the flow re-solves.
    void stack.execute(add(s, 1, 20));
    void stack.execute(add(s, 2, 5));
    void stack.undo();
    void stack.redo();
    await stack.idle();
    expect(s.log).toEqual(['do 1', 'do 2', 'undo 2', 'do 2']);
    expect(s.value).toBe(3);
  });

  it('merges a slider drag into one step that undoes to the start', async () => {
    let value = 1;
    const stack = new UndoStack();
    const set = (after: number, now: number, before = value) =>
      new SetValueCommand({
        key: 'wind.speed',
        label: 'Wind speed',
        before,
        after,
        now,
        apply: (v) => {
          value = v;
        },
      });
    await stack.execute(set(2, 1000));
    await stack.execute(set(3, 1100));
    await stack.execute(set(4, 1200));
    expect(value).toBe(4);
    expect(stack.state.size).toBe(1);
    await stack.undo();
    expect(value).toBe(1);
    await stack.redo();
    expect(value).toBe(4);
    // A change much later is a new step.
    await stack.execute(set(7, 9000));
    expect(stack.state.size).toBe(2);
  });

  it('undoes a batch in reverse order', async () => {
    const s = { value: 0, log: [] as string[] };
    const stack = new UndoStack();
    await stack.execute(new BatchCommand('two', [add(s, 1), add(s, 2)]));
    await stack.undo();
    expect(s.log).toEqual(['do 1', 'do 2', 'undo 2', 'undo 1']);
  });

  it('tells listeners about changes', async () => {
    const s = { value: 0, log: [] as string[] };
    const stack = new UndoStack();
    const seen: boolean[] = [];
    stack.subscribe((st) => seen.push(st.canUndo));
    await stack.execute(add(s, 1));
    await stack.undo();
    expect(seen).toEqual([true, false]);
  });
});

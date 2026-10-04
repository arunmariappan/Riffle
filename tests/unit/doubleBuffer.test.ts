import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { DoubleBuffer } from '../../src/sim/shared/doubleBuffer';

describe('shared double buffer', () => {
  it('publishes complete results with a rising version', () => {
    const db = new DoubleBuffer(16);
    expect(db.version).toBe(0);
    db.write((b) => b.fill(1));
    expect(db.version).toBe(1);
    const copy = new Float32Array(16);
    db.copyTo(copy);
    expect([...copy]).toEqual(new Array(16).fill(1));
    db.write((b) => b.fill(2));
    db.copyTo(copy);
    expect([...copy]).toEqual(new Array(16).fill(2));
  });

  it('never lets a reader see a half-written result (writer and reader racing on two threads)', async () => {
    const length = 20_000;
    const db = new DoubleBuffer(length);
    // The writer thread fills every element with the same value per publish: a torn read would mix two values.
    const worker = new Worker(
      `
      const { workerData, parentPort } = require('node:worker_threads');
      const header = new Int32Array(workerData.buffer, 0, 2);
      const regions = [new Float32Array(workerData.buffer, 8, workerData.length), new Float32Array(workerData.buffer, 8 + workerData.length * 4, workerData.length)];
      const nap = new Int32Array(new SharedArrayBuffer(4));
      for (let k = 1; k <= 3000; k++) {
        Atomics.wait(nap, 0, 0, 0.02); // a short pause: real writers publish at most ~30 times a second
        const back = 1 - Atomics.load(header, 1);
        regions[back].fill(k);
        Atomics.store(header, 1, back);
        Atomics.add(header, 0, 1);
      }
      parentPort.postMessage('done');
      `,
      { eval: true, workerData: db.handle() },
    );
    const done = new Promise<void>((resolve) => worker.on('message', () => resolve()));
    let reads = 0;
    let torn = 0;
    let finished = false;
    void done.then(() => (finished = true));
    while (!finished) {
      // Only the result the read returns counts: discarded (retried) attempts don't.
      const isTorn = db.read((front) => {
        const first = front[0];
        for (let i = 1; i < front.length; i += 97) if (front[i] !== first) return true;
        return false;
      });
      if (isTorn) torn++;
      reads++;
      await new Promise((r) => setImmediate(r));
    }
    await worker.terminate();
    expect(reads).toBeGreaterThan(10);
    expect(torn).toBe(0);
    expect(db.version).toBe(3000);
  });
});

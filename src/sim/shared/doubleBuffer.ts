/**
 * A double-buffered Float32 array in shared memory with a version number (plan principle 2): the writer fills the
 * back buffer and then publishes it, so readers on other threads never see a half-written result.
 *
 * Layout: Int32 header [version, front] + two Float32 regions. Readers use a seqlock check: if the writer published
 * twice while a read was in progress (so the buffer being read may have been reused), the read is retried.
 */

const HEADER_INTS = 2;

export interface DoubleBufferHandle {
  buffer: SharedArrayBuffer | ArrayBuffer;
  length: number;
}

export class DoubleBuffer {
  readonly length: number;
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  private readonly header: Int32Array;
  private readonly regions: [Float32Array, Float32Array];

  constructor(handleOrLength: DoubleBufferHandle | number) {
    if (typeof handleOrLength === 'number') {
      this.length = handleOrLength;
      const bytes = HEADER_INTS * 4 + handleOrLength * 2 * 4;
      this.buffer = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    } else {
      this.length = handleOrLength.length;
      this.buffer = handleOrLength.buffer;
    }
    this.header = new Int32Array(this.buffer, 0, HEADER_INTS);
    this.regions = [
      new Float32Array(this.buffer, HEADER_INTS * 4, this.length),
      new Float32Array(this.buffer, HEADER_INTS * 4 + this.length * 4, this.length),
    ];
  }

  /** What to send to another thread to open the same buffer. */
  handle(): DoubleBufferHandle {
    return { buffer: this.buffer, length: this.length };
  }

  get version(): number {
    return Atomics.load(this.header, 0);
  }

  /** Writer: fills the back buffer, then publishes it. */
  write(fill: (back: Float32Array) => void): number {
    const front = Atomics.load(this.header, 1);
    const back = 1 - front;
    fill(this.regions[back] as Float32Array);
    Atomics.store(this.header, 1, back);
    return Atomics.add(this.header, 0, 1) + 1;
  }

  /** Reader: runs `read` on the latest complete buffer; retries if it was overwritten meanwhile. */
  read<T>(read: (front: Float32Array, version: number) => T, maxTries = 8): T {
    for (let attempt = 0; ; attempt++) {
      const v0 = Atomics.load(this.header, 0);
      const front = Atomics.load(this.header, 1);
      const result = read(this.regions[front] as Float32Array, v0);
      const v1 = Atomics.load(this.header, 0);
      // One publish during the read went to the other buffer: still consistent. Two or more may have reused ours.
      if (v1 - v0 < 2 || attempt >= maxTries) return result;
    }
  }

  /** Copies the latest complete buffer into `out`. */
  copyTo(out: Float32Array): number {
    return this.read((front, version) => {
      out.set(front);
      return version;
    });
  }
}

/**
 * The `.riffle` file format (plan 6.11): a short magic prefix, then a gzip stream (the browser's own
 * CompressionStream) holding a versioned header, a JSON document (settings, your edit layer, time, weather) and named
 * binary sections (environment grids, plant densities, fish cohorts). Pure TypeScript; runs in the browser and Node.
 *
 * Layout inside the gzip stream (little-endian):
 *   u16 format version · u32 JSON byte length · JSON (UTF-8) · u32 section count ·
 *   per section: u16 name length · name (UTF-8) · u32 byte length · bytes
 */

const MAGIC = 'RIFFLE';
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
/** The prefix byte after the magic: 1 = gzip. */
const GZIP = 1;

export interface RiffleFile {
  version: number;
  json: unknown;
  sections: Record<string, Uint8Array>;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream);
  const buffer = await new Response(source).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function encodeRiffle(file: RiffleFile): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const json = enc.encode(JSON.stringify(file.json));
  const names = Object.keys(file.sections).sort();
  let size = 2 + 4 + json.length + 4;
  const encodedNames = names.map((n) => enc.encode(n));
  names.forEach(
    (n, i) => (size += 2 + (encodedNames[i] as Uint8Array).length + 4 + (file.sections[n] as Uint8Array).length),
  );
  const payload = new Uint8Array(size);
  const view = new DataView(payload.buffer);
  let o = 0;
  view.setUint16(o, file.version, true);
  o += 2;
  view.setUint32(o, json.length, true);
  o += 4;
  payload.set(json, o);
  o += json.length;
  view.setUint32(o, names.length, true);
  o += 4;
  names.forEach((n, i) => {
    const name = encodedNames[i] as Uint8Array;
    const data = file.sections[n] as Uint8Array;
    view.setUint16(o, name.length, true);
    o += 2;
    payload.set(name, o);
    o += name.length;
    view.setUint32(o, data.length, true);
    o += 4;
    payload.set(data, o);
    o += data.length;
  });
  const compressed = await pipe(payload, new CompressionStream('gzip'));
  const out = new Uint8Array(MAGIC_BYTES.length + 1 + compressed.length);
  out.set(MAGIC_BYTES, 0);
  out[MAGIC_BYTES.length] = GZIP;
  out.set(compressed, MAGIC_BYTES.length + 1);
  return out;
}

export class RiffleFormatError extends Error {}

export async function decodeRiffle(bytes: Uint8Array): Promise<RiffleFile> {
  if (bytes.length < MAGIC_BYTES.length + 1 || MAGIC_BYTES.some((b, i) => bytes[i] !== b))
    throw new RiffleFormatError('This is not a Riffle valley file');
  if (bytes[MAGIC_BYTES.length] !== GZIP) throw new RiffleFormatError('Unknown Riffle file encoding');
  let payload: Uint8Array;
  try {
    payload = await pipe(bytes.subarray(MAGIC_BYTES.length + 1), new DecompressionStream('gzip'));
  } catch {
    throw new RiffleFormatError('The valley file is damaged (it could not be decompressed)');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const dec = new TextDecoder();
  const need = (o: number, n: number) => {
    if (o + n > payload.length) throw new RiffleFormatError('The valley file is cut short');
  };
  let o = 0;
  need(o, 6);
  const version = view.getUint16(o, true);
  o += 2;
  const jsonLength = view.getUint32(o, true);
  o += 4;
  need(o, jsonLength);
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(payload.subarray(o, o + jsonLength)));
  } catch {
    throw new RiffleFormatError('The valley file is damaged (bad settings data)');
  }
  o += jsonLength;
  need(o, 4);
  const count = view.getUint32(o, true);
  o += 4;
  const sections: Record<string, Uint8Array> = {};
  for (let k = 0; k < count; k++) {
    need(o, 2);
    const nameLength = view.getUint16(o, true);
    o += 2;
    need(o, nameLength + 4);
    const name = dec.decode(payload.subarray(o, o + nameLength));
    o += nameLength;
    const length = view.getUint32(o, true);
    o += 4;
    need(o, length);
    sections[name] = payload.slice(o, o + length);
    o += length;
  }
  return { version, json, sections };
}

/** Float32Array ↔ bytes for binary sections (little-endian, as in the browser). */
export function floatsToBytes(data: Float32Array): Uint8Array {
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
}

export function bytesToFloats(bytes: Uint8Array): Float32Array {
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

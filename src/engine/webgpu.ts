/** WebGPU capability check (plan D1: desktop Chrome and Edge, WebGPU required, no WebGL fallback). */

export interface GpuSupport {
  supported: boolean;
  reason?: string;
  adapterInfo?: string;
  timestampQuery?: boolean;
}

export async function checkWebGpu(): Promise<GpuSupport> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { supported: false, reason: 'This browser has no WebGPU.' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { supported: false, reason: 'No WebGPU adapter is available on this device.' };
    const info = adapter.info;
    const adapterInfo = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
    return { supported: true, adapterInfo, timestampQuery: adapter.features.has('timestamp-query') };
  } catch (error) {
    return { supported: false, reason: `WebGPU failed to start: ${String(error)}` };
  }
}

export function isChromium(): boolean {
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  if (brands)
    return brands.some((b) => b.brand === 'Google Chrome' || b.brand === 'Microsoft Edge' || b.brand === 'Chromium');
  return /Chrome\//.test(navigator.userAgent);
}

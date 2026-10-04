/**
 * The overlays' color map (plan 6.8): a five-stop perceptual scale (dark blue → teal → green → yellow), shared by the
 * heat-map drape, the flow arrows and the legend. Pure TypeScript.
 */

export const COLORMAP_STOPS = [0x440154, 0x3b528b, 0x21918c, 0x5ec962, 0xfde725] as const;

/** Linear-interpolated color at t (0..1) as [r, g, b] in 0..1 (sRGB). */
export function colormapRgb(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (COLORMAP_STOPS.length - 1);
  const i = Math.min(COLORMAP_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = COLORMAP_STOPS[i] as number;
  const b = COLORMAP_STOPS[i + 1] as number;
  const ch = (c: number, s: number) => ((c >> s) & 255) / 255;
  return [16, 8, 0].map((s) => ch(a, s) + (ch(b, s) - ch(a, s)) * f) as [number, number, number];
}

/** The same as a CSS hex color. */
export function colormapHex(t: number): string {
  return `#${colormapRgb(t)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

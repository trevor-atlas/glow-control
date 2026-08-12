/** Clamp a value to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert normalized HSV (hue 0–1, saturation 0–1, value=1) to sRGB.
 * h maps to [0, 360) degrees; both 0 and 1 represent red.
 */
export function hsToRgb(h: number, s: number): { red: number; green: number; blue: number } {
  const hue = (h * 360) % 360;
  const c = s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = 1 - c;
  const [r1, g1, b1] =
    hue < 60 ? [c, x, 0] :
    hue < 120 ? [x, c, 0] :
    hue < 180 ? [0, c, x] :
    hue < 240 ? [0, x, c] :
    hue < 300 ? [x, 0, c] :
    [c, 0, x];
  return {
    red: Math.round((r1 + m) * 255),
    green: Math.round((g1 + m) * 255),
    blue: Math.round((b1 + m) * 255),
  };
}

/**
 * Convert sRGB to normalized HSV (hue 0–1, saturation 0–1, value=1 implied).
 */
export function rgbToHs(
  red: number,
  green: number,
  blue: number,
): { h: number; s: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  const saturation = max === 0 ? 0 : delta / max;

  return { h: hue / 360, s: saturation };
}

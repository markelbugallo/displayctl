// Utility functions for hardware and software brightness calculations.

/**
 * Calculates the opacity value (0 to 255) for a software black overlay widget based on a normalized brightness value.
 * 
 * @param brightness Normalized brightness level from 0.0 (darkest) to 1.0 (brightest)
 * @returns Opacity value for St.Widget (0 = completely transparent, 255 = completely black)
 */
export function calculateSoftwareOpacity(brightness: number): number {
  const clamped = Math.max(0.1, Math.min(1.0, brightness));
  return Math.round((1 - clamped) * 255);
}

export function scaleNormalizedToHardware(value: number, min: number, max: number): number {
  const clamped = Math.max(0.0, Math.min(1.0, value));
  const scaled = min + clamped * (max - min);
  return Math.round(Math.max(min, Math.min(max, scaled)));
}

export function scaleHardwareToNormalized(value: number, min: number, max: number): number {
  if (max <= min) return 1.0;
  const scaled = (value - min) / (max - min);
  return Math.max(0.0, Math.min(1.0, scaled));
}

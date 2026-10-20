/** How far an arrow key moves the selection: about 3 screen pixels at this zoom, rounded to 1, 2 or 5 times a power of ten (mm) */
export function nudgeStep(scale: number): number {
  const raw = 3 / Math.max(scale, 1e-6);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const nice = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
  return Math.min(100, Math.max(0.001, nice));
}


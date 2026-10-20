// Pure unit conversion (no React), shared by the UI and the tests.

export type Unit = 'mm' | 'in';
export const MM_PER_INCH = 25.4;

export interface Units {
  unit: Unit;
  setUnit: (u: Unit) => void;
  /** Length for display, e.g. 12.700 (mm) or 0.5000 (in). `digits` is the number of decimals in mm; inches get one more. */
  len: (mm: number, digits?: number) => string;
  /** Feed rate for display, rounded to a whole number of mm/min or 0.1 in/min */
  feed: (mmPerMin: number) => string;
  lenUnit: string;
  feedUnit: string;
}

export function makeUnits(unit: Unit, setUnit: (u: Unit) => void = () => {}): Units {
  const inch = unit === 'in';
  return {
    unit, setUnit,
    len: (mm, digits = 3) => (inch ? mm / MM_PER_INCH : mm).toFixed(inch ? digits + 1 : digits),
    feed: (v) => (inch ? (v / MM_PER_INCH).toFixed(1) : String(Math.round(v))),
    lenUnit: inch ? 'in' : 'mm',
    feedUnit: inch ? 'in/min' : 'mm/min',
  };
}

/** What a typed number means in millimetres. `kind`: a length or feed in the chosen unit, or a plain count. */
export const toMm = (typed: number, unit: Unit, kind: 'len' | 'feed' | 'raw') => (kind === 'raw' || unit === 'mm' ? typed : typed * MM_PER_INCH);
export const fromMm = (mm: number, unit: Unit, kind: 'len' | 'feed' | 'raw') => (kind === 'raw' || unit === 'mm' ? mm : mm / MM_PER_INCH);


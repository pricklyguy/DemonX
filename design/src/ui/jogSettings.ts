import { useEffect, useState } from 'react';

// The step and speed of the arrow buttons, remembered in this browser. The Laser panel's Frame uses the same speed.
const KEY = 'design-jog';
export interface Jog { step: number; speed: number; zStep: number; zSpeed: number }
const Z_STEPS = [0.1, 1, 5, 10];
const read = (): Jog => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      step: [0.1, 1, 10, 50].includes(v.step) ? v.step : 10,
      speed: Number.isFinite(v.speed) && v.speed >= 1 && v.speed <= 10000 ? v.speed : 3000,
      zStep: Z_STEPS.includes(v.zStep) ? v.zStep : 1,
      zSpeed: Number.isFinite(v.zSpeed) && v.zSpeed >= 1 && v.zSpeed <= 600 ? v.zSpeed : 250,
    };
  } catch { return { step: 10, speed: 3000, zStep: 1, zSpeed: 250 }; }
};

export const Z_STEP_CHOICES = Z_STEPS;
export function useJogSettings() {
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('design-jog', on);
    return () => window.removeEventListener('design-jog', on);
  }, []);
  const put = (n: Partial<Jog>) => {
    try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...n })); } catch { /* not remembered */ }
    setV((o) => ({ ...o, ...n }));
    window.dispatchEvent(new Event('design-jog'));
  };
  return { step: v.step, speed: v.speed, zStep: v.zStep, zSpeed: v.zSpeed, setStep: (step: number) => put({ step }), setSpeed: (speed: number) => put({ speed }), setZStep: (zStep: number) => put({ zStep }), setZSpeed: (zSpeed: number) => put({ zSpeed }) };
}

import { createContext, useContext } from 'react';

export type SettingsPage = 'layout' | 'units' | 'appearance' | 'camera' | 'homeassistant' | 'spindle' | 'controller' | 'pcb' | 'access' | 'stats' | 'gamepad' | 'keyboard';

/** Lets any panel open Settings on a page (a panel's ⚙ is a shortcut to its page) */
export interface SettingsApi { open: (page?: SettingsPage) => void }

export const SettingsContext = createContext<SettingsApi>({ open: () => {} });
export const useSettings = () => useContext(SettingsContext);

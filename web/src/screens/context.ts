import type { AppConfig, ConfigStore } from '../config/config';
import type { AppServices } from '../services/appServices';

/** What every screen can reach: the current services and a way to apply new settings. */
export interface Ctx {
  services: AppServices;
  /** Rebuilds the services with `config` and saves it as the person's settings. */
  reconfigure(config: AppConfig): Promise<void>;
  /** Build-time defaults, for "Reset to defaults". */
  defaults: AppConfig;
  store: ConfigStore;
}

let current: Ctx | null = null;

export const setCtx = (c: Ctx): void => {
  current = c;
};

export function ctx(): Ctx {
  if (!current) throw new Error('The app has not started yet');
  return current;
}

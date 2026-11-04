/**
 * Project settings the dashboard can toggle. Each change is applied to the
 * running config (and router, where the feature is gated per RPC) and saved
 * to the project config file.
 */

import { ServerConfig } from '../types.js';
import { updateConfigFile } from '../config/config.js';
import { RPCRouter } from '../rpc/router.js';

/**
 * When a change takes effect:
 *   reconnect      - immediately, but the editor only refreshes its feature list on reconnect
 *   newConnections - for editors that connect from now on
 *   restart        - next time the CLI starts
 */
export type ApplyMode = 'reconnect' | 'newConnections' | 'restart';

export interface SettingDef {
  id: string;
  hotkey: string;
  labelKey: string;
  apply: ApplyMode;
  get(config: ServerConfig): boolean;
  set(config: ServerConfig, enabled: boolean): void;
  routerFeature?: 'terminal' | 'browserProxy' | 'acp';
}

export const SETTINGS: SettingDef[] = [
  {
    id: 'terminal', hotkey: 't', labelKey: 'dashboard.settingTerminal', apply: 'reconnect', routerFeature: 'terminal',
    get: (c) => c.terminal.enabled,
    set: (c, v) => { c.terminal.enabled = v; },
  },
  {
    id: 'browserProxy', hotkey: 'b', labelKey: 'dashboard.settingBrowserProxy', apply: 'reconnect', routerFeature: 'browserProxy',
    get: (c) => c.browserProxy?.enabled ?? true,
    set: (c, v) => { c.browserProxy = { ...c.browserProxy, enabled: v }; },
  },
  {
    id: 'acp', hotkey: 'a', labelKey: 'dashboard.settingAcp', apply: 'reconnect', routerFeature: 'acp',
    get: (c) => c.acp?.enabled ?? true,
    set: (c, v) => { c.acp = { ...c.acp, enabled: v }; },
  },
  {
    id: 'languageServer', hotkey: 's', labelKey: 'dashboard.settingLanguageServer', apply: 'restart',
    get: (c) => c.languageServer?.enabled ?? true,
    set: (c, v) => { c.languageServer = { ...c.languageServer, enabled: v }; },
  },
  {
    id: 'userAuth', hotkey: 'u', labelKey: 'dashboard.settingUserAuth', apply: 'newConnections',
    get: (c) => c.security.userAuthenticationEnabled,
    set: (c, v) => { c.security.userAuthenticationEnabled = v; },
  },
  {
    // Turning it off refuses new offers right away; turning it on needs the
    // relay to be told at sign-in, so both directions are reported as restart.
    id: 'fastLane', hotkey: 'f', labelKey: 'dashboard.settingFastLane', apply: 'restart',
    get: (c) => c.fastLane?.enabled ?? true,
    set: (c, v) => { c.fastLane = { ...c.fastLane, enabled: v }; },
  },
];

/**
 * Flip a setting in memory and on disk. Throws if the config file can't be
 * written; the in-memory change is kept so the session still reflects it.
 */
export function toggleSetting(setting: SettingDef, config: ServerConfig, configPath?: string): boolean {
  const enabled = !setting.get(config);
  setting.set(config, enabled);
  if (setting.routerFeature) RPCRouter.setFeatureEnabled(setting.routerFeature, enabled);
  updateConfigFile((fileConfig) => setting.set(fileConfig, enabled), configPath);
  return enabled;
}

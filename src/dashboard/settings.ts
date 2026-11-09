/**
 * Project settings the dashboard can toggle. Each change is applied to the
 * running config (and router, where the feature is gated per RPC) and saved
 * to the project config file.
 */

import { ServerConfig } from '../types.js';
import { updateConfigFile } from '../config/config.js';
import { RPCRouter } from '../rpc/router.js';
import { getLocale, t } from '../i18n/index.js';
import { pinSettingLabel, setRequirePin } from './pin-settings.js';

// These strings belong only to the compact-prompt setting.
const promptText: Record<string, { label: string; hint: string }> = {
  en: { label: 'Compact shell prompt', hint: 'applies to new terminals' },
  es: { label: 'Prompt compacto', hint: 'se aplica a nuevos terminales' },
  fr: { label: 'Invite compacte', hint: "s’applique aux nouveaux terminaux" },
  id: { label: 'Prompt shell ringkas', hint: 'berlaku untuk terminal baru' },
  ja: { label: '短いシェルプロンプト', hint: '新しいターミナルに適用' },
  ko: { label: '간결한 셸 프롬프트', hint: '새 터미널에 적용' },
  pt: { label: 'Prompt compacto', hint: 'aplica-se a novos terminais' },
  'zh-Hans': { label: '精简 Shell 提示符', hint: '对新终端生效' },
};
const compactPromptText = () => promptText[getLocale()] ?? promptText.en;
export const newTerminalsHint = () => compactPromptText().hint;

/**
 * When a change takes effect:
 *   reconnect      - immediately, but the editor only refreshes its feature list on reconnect
 *   newConnections - for editors that connect from now on
 *   newTerminals   - for terminal sessions created from now on
 *   restart        - next time the CLI starts
 */
export type ApplyMode = 'reconnect' | 'newConnections' | 'newTerminals' | 'restart';

export interface SettingDef {
  id: string;
  hotkey: string;
  label(): string;
  apply: ApplyMode;
  get(config: ServerConfig): boolean;
  set(config: ServerConfig, enabled: boolean): void;
  routerFeature?: 'terminal' | 'browserProxy' | 'acp';
}

export const SETTINGS: SettingDef[] = [
  {
    id: 'terminal', hotkey: 't', label: () => t('dashboard.settingTerminal'), apply: 'reconnect', routerFeature: 'terminal',
    get: (c) => c.terminal.enabled,
    set: (c, v) => { c.terminal.enabled = v; },
  },
  {
    id: 'compactPrompt', hotkey: 'p', label: () => compactPromptText().label, apply: 'newTerminals',
    get: (c) => c.terminal.compactPrompt ?? true,
    set: (c, v) => { c.terminal.compactPrompt = v; },
  },
  {
    id: 'browserProxy', hotkey: 'b', label: () => t('dashboard.settingBrowserProxy'), apply: 'reconnect', routerFeature: 'browserProxy',
    get: (c) => c.browserProxy?.enabled ?? true,
    set: (c, v) => { c.browserProxy = { ...c.browserProxy, enabled: v }; },
  },
  {
    id: 'acp', hotkey: 'a', label: () => t('dashboard.settingAcp'), apply: 'reconnect', routerFeature: 'acp',
    get: (c) => c.acp?.enabled ?? true,
    set: (c, v) => { c.acp = { ...c.acp, enabled: v }; },
  },
  {
    id: 'languageServer', hotkey: 's', label: () => t('dashboard.settingLanguageServer'), apply: 'restart',
    get: (c) => c.languageServer?.enabled ?? true,
    set: (c, v) => { c.languageServer = { ...c.languageServer, enabled: v }; },
  },
  {
    id: 'userAuth', hotkey: 'u', label: () => t('dashboard.settingUserAuth'), apply: 'newConnections',
    get: (c) => c.security.userAuthenticationEnabled,
    set: (c, v) => { c.security.userAuthenticationEnabled = v; },
  },
  {
    id: 'requirePin', hotkey: 'i', label: pinSettingLabel, apply: 'newConnections',
    get: (c) => c.security.requirePin ?? false,
    set: setRequirePin,
  },
  {
    // Turning it off refuses new offers right away; turning it on needs the
    // relay to be told at sign-in, so both directions are reported as restart.
    id: 'fastLane', hotkey: 'f', label: () => t('dashboard.settingFastLane'), apply: 'restart',
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
  if (setting.id === 'compactPrompt') RPCRouter.setCompactPrompt(enabled);
  updateConfigFile((fileConfig) => setting.set(fileConfig, enabled), configPath);
  return enabled;
}

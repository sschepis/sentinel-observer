/**
 * Voice settings — where the observer's TTS behavior is configured.
 *
 * The ElevenLabs API key is a SECRET: it lives only in the browser's
 * localStorage (the same pattern as the chaperone endpoint key) and is sent
 * only to api.elevenlabs.io. It is never committed, never logged, and never
 * included in exported learning records. The voice id is public
 * (non-secret) and ships as the default.
 */
import type { VoiceService } from './voice';

export type TtsProvider = 'browser' | 'elevenlabs';

export interface ElevenLabsSettings {
  /** The secret API key — stored in localStorage only (never committed). */
  apiKey: string;
  /** A public voice identifier on the account. */
  voiceId: string;
}

export interface VoiceSettings {
  /** Master switch: speak answers aloud at all. */
  enabled: boolean;
  /** Which TTS engine speaks. */
  provider: TtsProvider;
  elevenlabs: ElevenLabsSettings;
}

export const VOICE_SETTINGS_KEY = 'sentinel-voice-settings';

/** The shipped default voice (public identifier, not a secret). */
export const ELEVENLABS_DEFAULT_VOICE_ID = 'Ls8oWxsHfCU3H9WHIoPb';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  provider: 'browser',
  elevenlabs: { apiKey: '', voiceId: ELEVENLABS_DEFAULT_VOICE_ID }
};

export function normalizeVoiceSettings(raw: unknown): VoiceSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_VOICE_SETTINGS };
  const settings = raw as Partial<VoiceSettings>;
  const eleven = (settings.elevenlabs ?? {}) as Partial<ElevenLabsSettings>;
  return {
    enabled: settings.enabled === true,
    provider: settings.provider === 'elevenlabs' ? 'elevenlabs' : 'browser',
    elevenlabs: {
      apiKey: typeof eleven.apiKey === 'string' ? eleven.apiKey : '',
      voiceId: typeof eleven.voiceId === 'string' && eleven.voiceId.trim().length > 0 ? eleven.voiceId : ELEVENLABS_DEFAULT_VOICE_ID
    }
  };
}

/** Whether a voice setting can actually speak — honest, never faked. */
export function canSpeak(settings: VoiceSettings, service: VoiceService): boolean {
  return settings.enabled && service.ttsAvailable(settings);
}

export function loadVoiceSettings(storage: Pick<Storage, 'getItem'> = globalThis.localStorage): VoiceSettings {
  try {
    const raw = storage.getItem(VOICE_SETTINGS_KEY);
    return normalizeVoiceSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function saveVoiceSettings(
  settings: VoiceSettings,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage
): void {
  storage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
}

import type { DeckWord } from '../teacher/deck';
import type { VoiceSettings } from './voiceSettings';
import { DEFAULT_VOICE_SETTINGS, ELEVENLABS_DEFAULT_VOICE_ID } from './voiceSettings';

/**
 * The voice layer: the human speaks to the observer (STT via the Web Speech
 * API), the observer answers aloud (TTS — browser speechSynthesis, or
 * ElevenLabs when configured with an API key).
 *
 * Honest degradation contract: browser speech support varies — Chrome/Edge
 * have it, Safari/Firefox are weaker, headless browsers have none. The UI
 * must report the real status and fall back to typed quizzes; it never fakes
 * audio or transcripts. ElevenLabs availability is reported honestly too:
 * it requires a configured key AND an audio element constructor, and a
 * failed request reports through the same false path as missing browser
 * speech — never a fabricated utterance.
 */

export interface VoiceDeps {
  /** The SpeechRecognition constructor (webkit-prefixed in some browsers). */
  recognitionCtor?: unknown;
  /** The speechSynthesis handle. */
  synthesis?: SpeechSynthesis;
  /** The utterance constructor. */
  utteranceCtor?: unknown;
  /** The Audio constructor (ElevenLabs playback). */
  audioCtor?: unknown;
}

export interface ListeningCallbacks {
  onTranscript: (transcript: string) => void;
  onError: (error: string) => void;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}

export class VoiceService {
  private recognition: SpeechRecognitionLike | null = null;
  private readonly recognitionCtor: (new () => SpeechRecognitionLike) | null;
  private readonly synthesis: SpeechSynthesis | null;
  private readonly utteranceCtor: (new (text: string) => SpeechSynthesisUtterance) | null;
  private readonly audioCtor: (new () => HTMLAudioElement) | null;
  /** The current voice configuration (null = browser synthesis only). */
  private settings: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
  private speakingAudio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private speakController: AbortController | null = null;

  constructor(deps: VoiceDeps = {}) {
    const g = globalThis as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      speechSynthesis?: SpeechSynthesis;
      SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance;
      Audio?: new () => HTMLAudioElement;
    };
    this.recognitionCtor =
      (deps.recognitionCtor as (new () => SpeechRecognitionLike) | undefined) ??
      g.SpeechRecognition ??
      g.webkitSpeechRecognition ??
      null;
    this.synthesis = (deps.synthesis as SpeechSynthesis | undefined) ?? g.speechSynthesis ?? null;
    this.utteranceCtor =
      (deps.utteranceCtor as (new (text: string) => SpeechSynthesisUtterance) | undefined) ??
      g.SpeechSynthesisUtterance ??
      null;
    this.audioCtor = (deps.audioCtor as (new () => HTMLAudioElement) | undefined) ?? g.Audio ?? null;
  }

  /** Configure how the observer speaks (provider + credentials). */
  configure(settings: VoiceSettings): void {
    this.settings = { ...settings, elevenlabs: { ...settings.elevenlabs } };
    if (settings.provider !== 'elevenlabs') this.stopSpeaking();
  }

  /** Speech-to-text availability (browser-dependent — report honestly). */
  get sttAvailable(): boolean {
    return this.recognitionCtor !== null;
  }

  /** Text-to-speech availability for the given configuration — honest, and
   *  provider-specific: browser synthesis needs the speech APIs; ElevenLabs
   *  needs a configured key and an audio element. */
  ttsAvailable(settings: VoiceSettings = this.settings): boolean {
    if (settings.provider === 'elevenlabs') {
      return settings.elevenlabs.apiKey.trim().length > 0 && this.audioCtor !== null;
    }
    return this.synthesis !== null && this.utteranceCtor !== null;
  }

  /** Begin listening; false when STT is unavailable (never faked). */
  startListening(callbacks: ListeningCallbacks): boolean {
    if (this.recognitionCtor === null) return false;
    try {
      const recognition = new this.recognitionCtor();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        const first = event.results[0]?.[0]?.transcript;
        if (first) callbacks.onTranscript(first);
      };
      recognition.onerror = (event) => callbacks.onError(event.error);
      recognition.onend = () => {
        this.recognition = null;
      };
      this.recognition = recognition;
      recognition.start();
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the active listening session (no-op when idle). */
  stopListening(): void {
    try {
      this.recognition?.abort();
    } catch {
      // Abort on a finished session is harmless.
    }
    this.recognition = null;
  }

  /**
   * Speak text aloud; returns false when the configured TTS is unavailable
   * (never faked). Interrupts any utterance in progress — one voice at a
   * time. ElevenLabs requests are dispatched asynchronously: the return
   * value reports dispatch, and a failed request is silent (the UI never
   * claims an answer was spoken).
   */
  speak(text: string, options: { rate?: number; onEnd?: () => void } = {}): boolean {
    if (this.settings.provider === 'elevenlabs') {
      return this.speakElevenLabs(text, options);
    }
    return this.speakBrowser(text, options);
  }

  private speakBrowser(text: string, options: { rate?: number; onEnd?: () => void } = {}): boolean {
    if (this.synthesis === null || this.utteranceCtor === null) return false;
    try {
      this.synthesis.cancel();
      const utterance = new this.utteranceCtor(text);
      utterance.lang = 'en-US';
      utterance.rate = options.rate ?? 1;
      if (options.onEnd) {
        utterance.onend = options.onEnd;
      }
      this.synthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  private speakElevenLabs(text: string, options: { rate?: number; onEnd?: () => void } = {}): boolean {
    const apiKey = this.settings.elevenlabs.apiKey.trim();
    const voiceId = this.settings.elevenlabs.voiceId.trim() || ELEVENLABS_DEFAULT_VOICE_ID;
    if (apiKey.length === 0 || this.audioCtor === null) return false;
    try {
      this.stopSpeaking();
      const controller = new AbortController();
      this.speakController = controller;
      void (async () => {
        try {
          const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg'
            },
            body: JSON.stringify({ text }),
            signal: controller.signal
          });
          if (!response.ok) return;
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          const audio = new this.audioCtor!();
          this.audioUrl = url;
          this.speakingAudio = audio;
          audio.src = url;
          if (options.onEnd) {
            audio.onended = () => {
              options.onEnd?.();
              this.releaseAudio();
            };
          }
          await audio.play();
        } catch {
          // A failed or cancelled synthesis is silent — never fabricated.
        }
      })();
      return true;
    } catch {
      return false;
    }
  }

  private releaseAudio(): void {
    if (this.audioUrl !== null) {
      try {
        URL.revokeObjectURL(this.audioUrl);
      } catch {
        // Revoking a released URL is harmless.
      }
      this.audioUrl = null;
    }
    this.speakingAudio = null;
  }

  /** Cancel any utterance in progress. */
  stopSpeaking(): void {
    try {
      this.synthesis?.cancel();
    } catch {
      // No synthesis session to cancel.
    }
    this.speakController?.abort();
    this.speakController = null;
    try {
      this.speakingAudio?.pause();
    } catch {
      // No audio session to pause.
    }
    this.releaseAudio();
  }
}

/**
 * Match a spoken utterance to a deck word.
 *
 * A real speech recognizer returns loose transcripts, so the matcher looks
 * for whole-word occurrences (word boundaries, case-insensitive) and picks
 * the LONGEST matching word to avoid prefix confusions. Returns null when
 * the utterance contains no known word — the observer must honestly say it
 * does not recognize the word rather than guess.
 */
export function matchSpokenWord(transcript: string, deck: readonly DeckWord[]): DeckWord | null {
  const text = transcript.toLowerCase();
  const matches = deck.filter((entry) => {
    const escaped = entry.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
  });
  if (matches.length === 0) return null;
  return matches.reduce((longest, entry) => (entry.word.length > longest.word.length ? entry : longest));
}

/** What the observer says aloud: the recalled answer, trimmed to the meaning. */
export function spokenAnswer(recalledContent: string): string {
  // Trace content is "word: definition. example" — speak the first sentence.
  const firstSentence = recalledContent.split('. ')[0] ?? recalledContent;
  return firstSentence.trim();
}

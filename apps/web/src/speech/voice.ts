import type { DeckWord } from '../teacher/deck';

/**
 * The voice layer: the human speaks to the observer (STT via the Web Speech
 * API), the observer answers aloud (TTS via speechSynthesis).
 *
 * Honest degradation contract: browser speech support varies — Chrome/Edge
 * have it, Safari/Firefox are weaker, headless browsers have none. The UI
 * must report the real status and fall back to typed quizzes; it never fakes
 * audio or transcripts.
 */

export interface VoiceDeps {
  /** The SpeechRecognition constructor (webkit-prefixed in some browsers). */
  recognitionCtor?: unknown;
  /** The speechSynthesis handle. */
  synthesis?: SpeechSynthesis;
  /** The utterance constructor. */
  utteranceCtor?: unknown;
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

  constructor(deps: VoiceDeps = {}) {
    const g = globalThis as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      speechSynthesis?: SpeechSynthesis;
      SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance;
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
  }

  /** Speech-to-text availability (browser-dependent — report honestly). */
  get sttAvailable(): boolean {
    return this.recognitionCtor !== null;
  }

  /** Text-to-speech availability. */
  get ttsAvailable(): boolean {
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
   * Speak text aloud; returns false when TTS is unavailable (never faked).
   * Interrupts any utterance in progress — one voice at a time.
   */
  speak(text: string, options: { rate?: number; onEnd?: () => void } = {}): boolean {
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

  /** Cancel any utterance in progress. */
  stopSpeaking(): void {
    try {
      this.synthesis?.cancel();
    } catch {
      // No synthesis session to cancel.
    }
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

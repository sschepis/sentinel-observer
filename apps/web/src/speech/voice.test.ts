/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { VoiceService, matchSpokenWord, spokenAnswer } from './voice';
import { DECK_100 } from '../teacher/decks/en-100';

/** Minimal fake speech stack for node tests. */
function fakeVoiceStack() {
  const listeners: Array<{
    start: () => void;
    abort: () => void;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
  }> = [];
  const spoken: Array<{ text: string; rate: number }> = [];
  let lastResult: string | null = null;
  let lastError: string | null = null;

  class FakeRecognition {
    lang = '';
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start(): void {
      listeners.push(this);
    }
    abort(): void {
      const index = listeners.indexOf(this);
      if (index >= 0) listeners.splice(index, 1);
    }
  }

  class FakeUtterance {
    lang = '';
    rate = 1;
    onend: (() => void) | null = null;
    constructor(public readonly text: string) {}
  }

  const synthesis = {
    cancel: () => {},
    speak: (utterance: FakeUtterance) => {
      spoken.push({ text: utterance.text, rate: utterance.rate });
      // Synthesize instantly for tests.
      setTimeout(() => utterance.onend?.(), 0);
    }
  };

  return {
    listeners,
    spoken,
    FakeRecognition,
    FakeUtterance,
    synthesis,
    setResult: (text: string) => {
      lastResult = text;
      for (const listener of listeners.splice(0)) {
        listener.onresult?.({ results: [[{ transcript: text }]] });
        listener.onend?.();
      }
    },
    setError: (error: string) => {
      lastError = error;
      for (const listener of listeners.splice(0)) {
        listener.onerror?.({ error });
        listener.onend?.();
      }
    },
    lastResult: () => lastResult,
    lastError: () => lastError
  };
}

describe('VoiceService', () => {
  it('reports availability honestly when the browser lacks speech APIs', () => {
    const voice = new VoiceService({
      recognitionCtor: undefined,
      synthesis: undefined,
      utteranceCtor: undefined
    });
    expect(voice.sttAvailable).toBe(false);
    expect(voice.ttsAvailable).toBe(false);
    expect(voice.startListening({ onTranscript: () => {}, onError: () => {} })).toBe(false);
    expect(voice.speak('hello')).toBe(false);
  });

  it('routes transcripts and errors through the callbacks', async () => {
    const stack = fakeVoiceStack();
    const voice = new VoiceService({
      recognitionCtor: stack.FakeRecognition,
      synthesis: stack.synthesis as never,
      utteranceCtor: stack.FakeUtterance
    });
    expect(voice.sttAvailable).toBe(true);
    expect(voice.ttsAvailable).toBe(true);

    const transcripts: string[] = [];
    const errors: string[] = [];
    const started = voice.startListening({
      onTranscript: (t) => transcripts.push(t),
      onError: (e) => errors.push(e)
    });
    expect(started).toBe(true);
    expect(stack.listeners).toHaveLength(1);

    stack.setResult('apple');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(transcripts).toEqual(['apple']);
    expect(stack.listeners).toHaveLength(0);

    voice.startListening({ onTranscript: () => {}, onError: (e) => errors.push(e) });
    stack.setError('no-speech');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(errors).toEqual(['no-speech']);
  });

  it('speaks via the synthesis handle and fires onEnd', async () => {
    const stack = fakeVoiceStack();
    const voice = new VoiceService({
      recognitionCtor: stack.FakeRecognition,
      synthesis: stack.synthesis as never,
      utteranceCtor: stack.FakeUtterance
    });
    let ended = false;
    const ok = voice.speak('the observer speaks', { rate: 0.9, onEnd: () => (ended = true) });
    expect(ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stack.spoken).toEqual([{ text: 'the observer speaks', rate: 0.9 }]);
    expect(ended).toBe(true);
  });
});

describe('matchSpokenWord', () => {
  it('finds a deck word inside a loose transcript (case-insensitive, word-boundary)', () => {
    expect(matchSpokenWord('Apple', DECK_100)?.word).toBe('apple');
    expect(matchSpokenWord('tell me about the word apple please', DECK_100)?.word).toBe('apple');
    expect(matchSpokenWord('I like WATER', DECK_100)?.word).toBe('water');
  });

  it('returns null for words the observer does not know (no guessing)', () => {
    expect(matchSpokenWord('flabbergasted', DECK_100)).toBeNull();
    expect(matchSpokenWord('', DECK_100)).toBeNull();
  });

  it('prefers the longest matching word', () => {
    // 'answer' contains no deck word as a whole-word prefix; use a deck pair:
    // 'new' vs any longer match — 'new' must not win when a longer word is
    // also present in the transcript.
    const match = matchSpokenWord('a beautiful new morning', DECK_100);
    expect(match?.word).toBe('beautiful'); // longest whole-word match
  });
});

describe('spokenAnswer', () => {
  it('trims the recalled lesson to its meaning sentence', () => {
    expect(spokenAnswer('apple: a round red or green fruit. I eat an apple every morning.')).toBe(
      'apple: a round red or green fruit'
    );
    expect(spokenAnswer('water: the clear liquid we drink')).toBe('water: the clear liquid we drink');
  });
});

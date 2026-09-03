import { useEffect, useRef, useState } from 'react';
import type { ConversationMessage } from '../teacher/conversations';
import type { ChatController } from '../chat/useChat';
import type { VoiceService } from '../speech/voice';
import { CREATIVE_UNLOCK_THRESHOLD } from '../teacher/conversation';

export interface ChatViewProps {
  chat: ChatController;
  /** Null until the observer is awake. */
  ready: boolean;
  creativeUnlocked: boolean;
  voice: VoiceService;
  onStartObserver?: () => void;
}

const MODE_BADGE: Record<NonNullable<ConversationMessage['mode']>, { label: string; tone: string } | null> = {
  memorized: null,
  operator: { label: 'computed', tone: 'text-sky-300' },
  creative: { label: 'composed', tone: 'text-amber-300' },
  ask: { label: 'asking', tone: 'text-fuchsia-300' },
  hybrid: { label: 'from the teacher', tone: 'text-violet-300' },
  decline: { label: 'not learned yet', tone: 'text-slate-500' }
};

const STARTERS = ['hello', 'what is your name?', 'how are you?', 'tell me something new'];

function ObserverMessage({ message }: { message: ConversationMessage }) {
  const badge = message.mode !== undefined ? MODE_BADGE[message.mode] : null;
  const [showWork, setShowWork] = useState(false);
  const derived = message.derivation !== undefined && message.derivation.length > 0;
  return (
    <div className="group flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-semibold uppercase text-emerald-300">
        ob
      </span>
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-100">{message.text}</p>
        {(badge !== null || message.confidence != null || message.score != null) && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
            {badge !== null && <span className={badge.tone}>{badge.label}</span>}
            {message.confidence != null && <span>confidence {message.confidence.toFixed(2)}</span>}
            {message.score != null && <span>graded {message.score.toFixed(2)}</span>}
          </p>
        )}
        {derived && (
          <button
            onClick={() => setShowWork((open) => !open)}
            className="mt-1.5 text-[11px] font-medium text-sky-400/80 transition hover:text-sky-300"
            aria-expanded={showWork}
          >
            {showWork ? 'hide the derivation' : `show the work (${message.steps ?? message.derivation!.length} rewrites)`}
          </button>
        )}
        {derived && showWork && (
          <div className="mt-2 overflow-x-auto rounded-lg border border-slate-800/80 bg-slate-950/60 p-2.5 font-mono text-[10.5px] leading-relaxed text-slate-400">
            {message.derivation!.map((step, index) => (
              <div key={index} className="whitespace-nowrap">
                <span className="text-slate-600">{index + 1}.</span>{' '}
                <span className="text-sky-400/80">{step.ruleId}</span>{' '}
                <span className="text-slate-600">→</span> {step.after}
              </div>
            ))}
            {message.steps !== undefined && message.derivation!.length < message.steps && (
              <p className="mt-1 text-slate-600">… {message.steps - message.derivation!.length} more steps</p>
            )}
          </div>
        )}
        {message.feedback != null && message.feedback.length > 0 && (
          <p className="mt-1.5 border-l-2 border-slate-800 pl-3 text-xs italic text-slate-500">{message.feedback}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The chat surface: a single scrolling transcript with the composer pinned
 * to the bottom — the conventional assistant layout. The conversation list
 * lives in the app sidebar; the model summary lives in the strip above.
 */
export function ChatView({ chat, ready, creativeUnlocked, voice, onStartObserver }: ChatViewProps) {
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, [chat.messages, chat.status]);

  useEffect(() => () => voice.stopSpeaking(), [voice]);

  // Grow the composer with its content, up to a ceiling.
  useEffect(() => {
    const field = inputRef.current;
    if (field === null) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 180)}px`;
  }, [input]);

  const submit = () => {
    if (input.trim().length === 0 || !ready) return;
    chat.send(input);
    setInput('');
  };

  const toggleMic = () => {
    if (listening) {
      voice.stopListening();
      setListening(false);
      return;
    }
    const started = voice.startListening({
      onTranscript: (heard) => {
        setInput(heard);
        setListening(false);
      },
      onError: () => setListening(false)
    });
    setListening(started);
  };

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <h2 className="text-lg font-medium text-slate-100">The observer is asleep</h2>
          <p className="mt-2 text-sm text-slate-400">
            Wake it to chat. Its memory is restored from this browser, so nothing is lost.
          </p>
          {onStartObserver !== undefined && (
            <button
              onClick={onStartObserver}
              className="mt-5 rounded-lg bg-emerald-500 px-5 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400"
            >
              Wake the observer
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-8">
          {chat.messages.length === 0 ? (
            <div className="flex flex-col items-center py-20 text-center">
              <h2 className="text-xl font-medium text-slate-200">Say something to the observer</h2>
              <p className="mt-2 max-w-md text-sm text-slate-500">
                It answers only from what it has actually learned. When it cannot, it says so — and asks.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {STARTERS.map((starter) => (
                  <button
                    key={starter}
                    onClick={() => {
                      chat.send(starter);
                      setInput('');
                    }}
                    className="rounded-full border border-slate-800 bg-slate-900/60 px-4 py-1.5 text-sm text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {chat.messages.map((message) =>
                message.role === 'user' ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-slate-800 px-4 py-2.5 text-[15px] leading-relaxed text-slate-100">
                      {message.text}
                    </div>
                  </div>
                ) : (
                  <ObserverMessage key={message.id} message={message} />
                )
              )}
            </div>
          )}

          {chat.pending && (
            <div className="mt-6 flex items-center gap-3 text-xs text-slate-500">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-600 [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-600 [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-600" />
              </span>
              {chat.status.length > 0 ? chat.status : 'thinking…'}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-slate-800/80 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-6 py-4">
          <div className="flex items-end gap-2 rounded-2xl border border-slate-800 bg-slate-900/70 p-2 transition focus-within:border-slate-600">
            <button
              onClick={toggleMic}
              disabled={!voice.sttAvailable}
              title={voice.sttAvailable ? (listening ? 'Stop listening' : 'Speak') : 'Speech input is unavailable in this browser'}
              aria-label={listening ? 'Stop listening' : 'Speak'}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm transition ${
                listening
                  ? 'bg-rose-600 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30'
              }`}
            >
              {listening ? '■' : '🎙'}
            </button>
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Message the observer…"
              aria-label="Message the observer"
              className="max-h-44 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] text-slate-100 outline-none placeholder:text-slate-600"
            />
            <button
              onClick={() => {
                chat.compose(input);
                setInput('');
              }}
              disabled={!creativeUnlocked}
              title={
                creativeUnlocked
                  ? 'Ask the observer to compose a new sentence from its own memories'
                  : `Composing unlocks at ${Math.round(CREATIVE_UNLOCK_THRESHOLD * 100)}% recall competency`
              }
              className="h-9 shrink-0 rounded-xl px-3 text-xs font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              Compose
            </button>
            <button
              onClick={submit}
              disabled={input.trim().length === 0}
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-900 transition hover:bg-white disabled:bg-slate-800 disabled:text-slate-600"
            >
              ↑
            </button>
          </div>
          <p className="mt-2 h-4 text-center text-[11px] text-slate-600">
            {!chat.pending && chat.status.length > 0
              ? chat.status
              : 'The observer answers from its own memory. Enter to send, Shift+Enter for a new line.'}
          </p>
        </div>
      </div>
    </div>
  );
}

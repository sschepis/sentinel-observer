import { useEffect, useRef, useState } from 'react';
import type { ConversationMessage } from '../teacher/conversations';
import type { ChatController } from '../chat/useChat';
import type { VoiceService } from '../speech/voice';
import { CREATIVE_UNLOCK_THRESHOLD } from '../teacher/conversation';

export interface ChatViewProps {
  chat: ChatController;
  /** Null until the observer is awake. */
  ready: boolean;
  /** TRUE WHEN THE SERVER CANNOT BE REACHED AT ALL — a different thing from
   *  an observer that is merely asleep, and the panel must not confuse
   *  them: nothing in the browser can wake a process that is not running,
   *  and offering a button that cannot work is the app lying about what it
   *  knows. */
  unreachable?: boolean;
  /** Where the observer server is expected to be, for the offline panel. */
  serverUrl?: string;
  creativeUnlocked: boolean;
  voice: VoiceService;
  onStartObserver?: () => void;
  /** The "have the teacher answer" affordance: asks the server's chaperone
   *  to answer an outstanding gap; the learned answer is appended by the
   *  caller. */
  onTeacherAnswer?: (cue: string) => Promise<void>;
}

const MODE_BADGE: Record<NonNullable<ConversationMessage['mode']>, { label: string; tone: string } | null> = {
  memorized: null,
  operator: { label: 'computed', tone: 'text-sky-300' },
  creative: { label: 'composed', tone: 'text-amber-300' },
  ask: { label: 'asking', tone: 'text-fuchsia-300' },
  hybrid: { label: 'from the teacher', tone: 'text-violet-300' },
  decline: { label: 'not learned yet', tone: 'text-slate-500' }
};

/** What the routing badge already implies about the deviation meter. The
 *  meter badge (TASKS.md #17) is shown only when the READING disagrees: an
 *  ask-layer reply that asserted what the observer read ("Zeus is a god") is
 *  grounded speech, not an abstention; a composed reply whose claims cite
 *  edges is grounded; a composed reply that cites nothing is uncited. */
const IMPLIED_METER: Record<NonNullable<ConversationMessage['mode']>, ConversationMessage['meter'] | null> = {
  memorized: 'grounded',
  operator: 'grounded',
  creative: 'composed',
  ask: 'abstained',
  hybrid: null,
  decline: 'abstained'
};

const METER_BADGE: Record<NonNullable<ConversationMessage['meter']>, { label: string; tone: string }> = {
  grounded: { label: 'grounded — cites memory', tone: 'text-emerald-300' },
  composed: { label: 'uncited claim', tone: 'text-rose-300' },
  abstained: { label: 'abstained', tone: 'text-slate-400' }
};

function meterBadgeFor(message: ConversationMessage): { label: string; tone: string } | null {
  if (message.meter === undefined) return null;
  const implied = message.mode !== undefined ? IMPLIED_METER[message.mode] : null;
  if (implied === message.meter) return null;
  return METER_BADGE[message.meter];
}

/** Sample prompts shown on the empty chat. Grouped by the capability they
 *  exercise so a visitor can range across everything the observer can do —
 *  and honestly probe the boundary where it asks instead of guessing. */
interface PromptGroup {
  label: string;
  prompts: string[];
}

const PROMPT_GROUPS: PromptGroup[] = [
  {
    label: 'say hello',
    prompts: ['hello', 'what is your name?', 'how are you?', 'tell me something new']
  },
  {
    label: 'ask what a word means',
    prompts: [
      'what is water?',
      'what is music?',
      'what is a computer?',
      'what is a game?',
      'what is the weather?',
      'what is a star?',
      'what is food?'
    ]
  },
  {
    label: 'reason about what it knows',
    prompts: [
      'is water a liquid?',
      'is water used for drinking?',
      'is a game a contest?',
      'what is 7 + 5?',
      'what is 20 - 8?',
      'what is 36 / 6?',
      'what is 5 percent of 200?',
      'how many words do you know?'
    ]
  },
  {
    label: 'let it compose',
    prompts: [
      'tell me about water',
      'tell me about music',
      'tell me about the weather',
      'what can you tell me about a star?'
    ]
  },
  {
    label: 'ask it about itself',
    prompts: [
      'what are you trying to do?',
      'what do you know about water?',
      'what time is it?',
      "what is today's date?",
      'say hello'
    ]
  },
  {
    label: "probe its honesty (it should say it doesn't know)",
    prompts: [
      'what is a quasar?',
      'do you know calculus?',
      'is a cat a dog?',
      'what is 7 / 2?'
    ]
  }
];

/** One row of the unfolded derivation: a run of consecutive applications of
 *  the same rule, shown once with its count and the term it arrived at. A
 *  division by repeated subtraction applies `nat.lt-ss` thirty-five times
 *  in a row; thirty-five near-identical lines hide the shape of the work
 *  that six grouped lines show. */
interface DerivationGroup {
  /** 1-based index of the first step in the run. */
  first: number;
  ruleId: string;
  count: number;
  /** The term after the LAST step of the run. */
  after: string;
}

export function groupDerivation(steps: ReadonlyArray<{ ruleId: string; after: string }>): DerivationGroup[] {
  const groups: DerivationGroup[] = [];
  steps.forEach((step, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.ruleId === step.ruleId) {
      last.count += 1;
      last.after = step.after;
    } else {
      groups.push({ first: index + 1, ruleId: step.ruleId, count: 1, after: step.after });
    }
  });
  return groups;
}

function ObserverMessage({ message }: { message: ConversationMessage }) {
  const badge = message.mode !== undefined ? MODE_BADGE[message.mode] : null;
  const meterBadge = meterBadgeFor(message);
  const [showWork, setShowWork] = useState(false);
  const derived = message.derivation !== undefined && message.derivation.length > 0;
  return (
    <div className="group flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-semibold uppercase text-emerald-300">
        ob
      </span>
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-slate-100">{message.text}</p>
        {(badge !== null || meterBadge !== null || message.confidence != null || message.score != null) && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
            {badge !== null && <span className={badge.tone}>{badge.label}</span>}
            {meterBadge !== null && <span className={meterBadge.tone}>{meterBadge.label}</span>}
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
            {groupDerivation(message.derivation!).map((group) => (
              <div key={group.first} className="flex gap-2 whitespace-nowrap">
                <span className="w-12 shrink-0 text-right text-slate-600">
                  {group.count === 1 ? `${group.first}.` : `${group.first}–${group.first + group.count - 1}.`}
                </span>
                <span className="w-40 shrink-0 truncate text-sky-400/80" title={group.ruleId}>
                  {group.ruleId}
                  {group.count > 1 && <span className="text-slate-500"> ×{group.count}</span>}
                </span>
                <span className="text-slate-600">→</span>
                <span className="text-slate-300">{group.after}</span>
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
export function ChatView({ chat, ready, unreachable, serverUrl, creativeUnlocked, voice, onStartObserver, onTeacherAnswer }: ChatViewProps) {
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
    // UNREACHABLE IS NOT ASLEEP. The model lives in a server process; if
    // that process is not running there is nothing to wake, and the honest
    // panel says where the app is looking and what to start.
    if (unreachable === true) {
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <h2 className="text-lg font-medium text-slate-100">Can't reach the observer server</h2>
            <p className="mt-2 text-sm text-slate-400">
              The model lives in a server process, not in this page. Nothing is answering at{' '}
              <code className="rounded bg-slate-900 px-1 py-0.5 font-mono text-xs text-slate-300">{serverUrl ?? 'the configured address'}</code>.
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Start it with <code className="font-mono text-xs text-slate-400">npm run dev:all</code> (or{' '}
              <code className="font-mono text-xs text-slate-400">npm run server</code>) — this page keeps probing and connects on its own the moment it comes up.
            </p>
            {onStartObserver !== undefined && (
              <button
                onClick={onStartObserver}
                className="mt-5 rounded-lg border border-slate-700 px-5 py-2 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
              >
                Retry now
              </button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <h2 className="text-lg font-medium text-slate-100">The observer is asleep</h2>
          <p className="mt-2 text-sm text-slate-400">
            Wake it to chat. Its memory is restored from the server's own record, so nothing is lost.
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
            <div className="py-8">
              <h2 className="text-xl font-medium text-slate-200">Say something to the observer</h2>
              <p className="mt-2 max-w-lg text-sm text-slate-500">
                It answers only from what it has actually learned. When it cannot, it says so — and asks. Try a
                sample from any of the groups below.
              </p>
              <div className="mt-8 space-y-6">
                {PROMPT_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      {group.label}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {group.prompts.map((prompt) => (
                        <button
                          key={prompt}
                          onClick={() => {
                            chat.send(prompt);
                            setInput('');
                          }}
                          className="rounded-full border border-slate-800 bg-slate-900/60 px-4 py-1.5 text-sm text-slate-400 transition hover:border-slate-600 hover:text-slate-200"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {chat.messages.map((message, index) =>
                message.role === 'user' ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-slate-800 px-4 py-2.5 text-[15px] leading-relaxed text-slate-100">
                      {message.text}
                    </div>
                  </div>
                ) : (
                  <div key={message.id} className="flex flex-col items-start gap-1.5">
                    <ObserverMessage message={message} />
                    {onTeacherAnswer !== undefined && (message.mode === 'ask' || message.mode === 'decline') && (
                      <button
                        onClick={() => {
                          const cue = chat.messages[index - 1]?.role === 'user' ? chat.messages[index - 1].text : message.text;
                          void onTeacherAnswer(cue);
                        }}
                        className="ml-8 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-[11px] text-violet-300 transition hover:border-violet-400 hover:text-violet-200"
                      >
                        ask the teacher model to answer
                      </button>
                    )}
                  </div>
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

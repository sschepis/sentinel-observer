import { useCallback, useEffect, useRef, useState } from 'react';
import type { EdgeRef, TeacherAgent } from '../teacher/TeacherAgent';
import {
  Chaperone,
  OpenAICompatProvider,
  semanticGrader,
  type ChaperoneSettings
} from '../teacher/chaperone';
import { hybridAnswer } from '../teacher/hybrid';
import type { EpisodicFact } from '../teacher/episodic';
import { awaitable, isHybridCapable, type ChatTeacher } from '../server/client';
import {
  loadConversations,
  loadActiveConversationId,
  saveActiveConversationId,
  createConversation,
  appendMessage,
  deleteConversation,
  type Conversation,
  type ConversationMessage
} from '../teacher/conversations';

export interface ChatController {
  conversations: Conversation[];
  activeId: string | null;
  messages: ConversationMessage[];
  /** Transient one-line status under the transcript ("the observer is asking…"). */
  status: string;
  /** True while an LLM escalation or grading round-trip is in flight. */
  pending: boolean;
  send: (text: string) => void;
  compose: (text: string) => void;
  selectConversation: (id: string) => void;
  newConversation: () => void;
  removeConversation: (id: string) => void;
}

/** R11: only the LOCAL teacher closes the ask → told → own loop (the
 *  remote observer answers on the server; the teach-reply surface lives on
 *  the local session for now). */
function isTeachCapable(teacher: ChatTeacher | null): teacher is TeacherAgent {
  return teacher !== null && typeof (teacher as Partial<TeacherAgent>).tryTeachReply === 'function';
}

/**
 * Chat with the observer.
 *
 * Owned by the app shell rather than the chat view, so an in-flight LLM
 * escalation survives navigating to the training stream and back.
 *
 * `teacher` may be the real in-browser TeacherAgent or a remote teacher
 * backed by the observer server (server/client.ts) — the hook awaits either.
 */
export function useChat(
  teacher: ChatTeacher | null,
  settings: ChaperoneSettings,
  onTeacherChanged: () => void,
  speak?: (text: string) => void,
  /** New episodic facts this turn committed to long-term memory (surfaced
   *  to the learning stream by the shell). */
  onEpisodicStored?: (facts: EpisodicFact[]) => void
): ChatController {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const saved = loadActiveConversationId();
    const list = loadConversations();
    return saved !== null && list.some((c) => c.id === saved) ? saved : (list.slice(-1)[0]?.id ?? null);
  });
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const sync = useCallback((preferredId: string | null) => {
    const list = loadConversations();
    setConversations(list);
    const wanted = preferredId ?? activeIdRef.current;
    const conversation = list.find((c) => c.id === wanted) ?? list.slice(-1)[0] ?? null;
    setActiveId(conversation?.id ?? null);
    setMessages(conversation?.messages ?? []);
  }, []);

  useEffect(() => {
    sync(null);
  }, [sync, teacher]);

  const ensureConversation = useCallback((): string => {
    const current = activeIdRef.current;
    if (current !== null && conversationsRef.current.some((c) => c.id === current)) return current;
    const conversation = createConversation();
    setConversations((prev) => [...prev, conversation]);
    setActiveId(conversation.id);
    return conversation.id;
  }, []);

  /**
   * Append the exchange to an EXPLICIT conversation. The id is captured at
   * SEND time by every caller: the creative/hybrid/grade paths resolve after
   * an LLM round-trip, so routing by the then-current active conversation
   * would land the exchange in whatever conversation the user switched to.
   */
  const pushExchange = useCallback(
    (
      userText: string,
      reply: {
        text: string;
        mode?: ConversationMessage['mode'];
        confidence?: number | null;
        score?: number | null;
        feedback?: string | null;
        derivation?: ConversationMessage['derivation'];
        ruleIds?: string[];
        steps?: number;
      },
      conversationId: string
    ) => {
      appendMessage(conversationId, { role: 'user', text: userText });
      appendMessage(conversationId, {
        role: 'observer',
        text: reply.text,
        mode: reply.mode,
        confidence: reply.confidence ?? null,
        score: reply.score ?? null,
        feedback: reply.feedback ?? null,
        derivation: reply.derivation,
        ruleIds: reply.ruleIds,
        steps: reply.steps
      });
      sync(conversationId);
    },
    [sync]
  );

  /** Compose + LLM-grade + reinforce a creative answer. */
  const gradeCreative = useCallback(
    async (
      utterance: string,
      reply: { sentence: string; confidence: number | null; seedTraceIds: string[]; edges?: EdgeRef[]; templateIds: string[]; ruleIds?: string[] },
      conversationId: string
    ) => {
      if (teacher === null) return;
      setPending(true);
      setStatus('the observer is composing from its own memories…');
      let score: number | null = null;
      let feedback: string | null = null;
      if (settings.endpoint.trim().length > 0) {
        const grader = semanticGrader(new OpenAICompatProvider(settings));
        if (grader !== null) {
          try {
            const outcome = await grader.grade(utterance, reply.sentence);
            score = outcome?.score ?? null;
            feedback = outcome?.feedback ?? null;
          } catch (reason) {
            feedback = `grading unavailable: ${reason instanceof Error ? reason.message : String(reason)}`;
          }
        }
      } else {
        feedback = 'grading unavailable — configure a teacher model in Settings';
      }

      // GRADER RELIABILITY: the grade is bucketed (creative × seed
      // difficulty band × template × provider), cross-checked against the
      // composition grounding check, and applied with the bucket's feedback
      // weight. A disagreement schedules a re-grade — the confirmation UI
      // reads teacher.graderReliability().pendingRegrades(). P14: the cited
      // edges ride along so the world-feedback class is credited on them;
      // the template ids ride along so the learned-frame induction credits
      // the structures the accepted answer demonstrated.
      const graded = await awaitable(
        teacher.gradeCreativeWithReliability(
          { traceIds: reply.seedTraceIds, edges: reply.edges ?? [], templateIds: reply.templateIds, ruleIds: reply.ruleIds },
          score,
          utterance,
          reply.sentence,
          settings.model || settings.endpoint
        )
      );
      if (graded.regradeId !== null) {
        feedback = `${feedback !== null && feedback.length > 0 ? feedback : `graded ${score?.toFixed(2)}`} — the internal check disagrees (re-grade pending)`;
      }
      pushExchange(
        utterance,
        {
          text: reply.sentence,
          mode: 'creative',
          confidence: reply.confidence,
          score,
          feedback
        },
        conversationId
      );
      setStatus(
        score !== null && score >= 0.7
          ? 'good answer — the observer reinforced those memories'
          : score !== null && score <= 0.3
            ? 'weak answer — those memories were slightly weakened'
            : ''
      );
      setPending(false);
      onTeacherChanged();
    },
    [teacher, settings, pushExchange, onTeacherChanged]
  );

  const send = useCallback(
    async (raw: string) => {
      const utterance = raw.trim();
      if (teacher === null || utterance.length === 0) return;
      // The exchange's home is fixed at SEND time — the grade/hybrid paths
      // below resolve after an LLM round-trip, during which the user may
      // switch conversations. Routing by the push-time active conversation
      // would strand the exchange in the wrong thread.
      const conversationId = ensureConversation();
      // R11: CLOSE THE ASK → TOLD → OWN LOOP. When the observer is waiting
      // on a rule question ("what is the rule for gcf?") and this reply
      // parses as the procedure, the R10 pipeline validates and adopts it —
      // the observer answers with its own summary or the counterexample.
      // A reply that does not parse falls through to the normal dispatch.
      // (Local teacher only: the server's observer answers remotely, so the
      // teach-reply surface lives on the local session for now.)
      const teachCapable = isTeachCapable(teacher);
      if (teachCapable) {
        const taught = await awaitable(teacher.tryTeachReply(utterance));
        if (taught !== null) {
          const message = taught.message;
          speak?.(message);
          pushExchange(utterance, { text: message }, conversationId);
          setStatus('');
          onTeacherChanged();
          return;
        }
      }
      const answer = await awaitable(teacher.chatAnswer(utterance));
      // New episodic facts (user facts, topics, session gaps) flow to the
      // learning stream as "remembers" events.
      if (answer.stored !== undefined && answer.stored.length > 0) {
        onEpisodicStored?.(answer.stored);
      }

      if (answer.mode === 'creative') {
        void gradeCreative(utterance, {
          sentence: answer.response,
          confidence: answer.confidence,
          seedTraceIds: answer.seedTraceIds,
          edges: answer.provenance.edges,
          templateIds: answer.templateIds,
          ruleIds: answer.provenance.ruleIds
        }, conversationId);
        return;
      }

      const text = answer.mode === 'decline' ? "I haven't learned that yet." : answer.response;
      if (answer.mode !== 'decline') speak?.(text);
      // R8: rewrite derivations travel with the message — the chat can
      // unfold "show your work" (a bounded prefix of the trace: 32 steps
      // keep the stored conversation small; the whole derivation is
      // bounded at 200 by the engine anyway).
      const operator = answer.mode === 'operator' && answer.operator !== null ? answer.operator : null;
      // The stored trace keeps only what the UI renders (rule + result);
      // `before` roughly doubles the payload (measured ~3.8 KB per math
      // exchange at the 32-step cap) and ChatView never shows it.
      const derivation =
        operator !== null && operator.kind === 'rewrite'
          ? operator.trace.slice(0, 32).map((step) => ({ ruleId: step.ruleId, after: step.after }))
          : undefined;
      pushExchange(utterance, {
        text,
        mode: answer.mode,
        confidence: answer.mode === 'memorized' ? answer.confidence : null,
        derivation,
        ruleIds: operator !== null && operator.kind === 'rewrite' ? operator.ruleIds : undefined,
        steps: operator !== null && operator.kind === 'rewrite' ? operator.steps : undefined
      }, conversationId);
      setStatus('');
      onTeacherChanged();

      // HYBRID ESCALATION: when the observer had to ask, the LLM drafts an
      // answer conditioned on the observer's OWN memories; a strong draft
      // becomes a memory so no LLM is needed next time. This path reads the
      // teacher's memory internals (recallMemories / episodicRecall /
      // recordGap), so it runs only against a teacher that has them — the
      // remote teacher answers exactly what the server's observer knows and
      // escalates to an honest ask.
      if (answer.mode === 'ask' && settings.endpoint.trim().length > 0 && isHybridCapable(teacher)) {
        setPending(true);
        setStatus('the observer is asking its teacher…');
        void (async () => {
          try {
            const provider = new OpenAICompatProvider(settings);
            const hybrid = await hybridAnswer(
              teacher,
              new Chaperone(provider),
              semanticGrader(provider),
              utterance
            );
            if (hybrid !== null) {
              pushExchange(utterance, {
                text: hybrid.answer,
                mode: 'hybrid',
                score: hybrid.score,
                feedback: hybrid.feedback
              }, conversationId);
              setStatus(
                hybrid.stored
                  ? 'learned from the teacher — the observer can answer this from memory now'
                  : 'suggested by the teacher (not strong enough to memorize)'
              );
            }
          } catch (reason) {
            setStatus(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setPending(false);
            onTeacherChanged();
          }
        })();
      }
    },
    [teacher, settings, gradeCreative, pushExchange, onTeacherChanged, speak]
  );

  /** Force a composed (creative) answer regardless of what recall would do. */
  const compose = useCallback(
    async (raw: string) => {
      if (teacher === null) return;
      const utterance = raw.trim().length > 0 ? raw.trim() : 'tell me something new';
      const conversationId = ensureConversation();
      const reply = await awaitable(teacher.creativeReply(utterance));
      if (reply.sentence.trim().length === 0) {
        setStatus('the observer has no words to compose with yet');
        return;
      }
      void gradeCreative(utterance, reply, conversationId);
    },
    [teacher, gradeCreative, ensureConversation]
  );

  const selectConversation = useCallback(
    (id: string) => {
      saveActiveConversationId(id);
      setStatus('');
      sync(id);
    },
    [sync]
  );

  const newConversation = useCallback(() => {
    const conversation = createConversation();
    setConversations((prev) => [...prev, conversation]);
    setActiveId(conversation.id);
    setMessages([]);
    setStatus('');
  }, []);

  const removeConversation = useCallback(
    (id: string) => {
      deleteConversation(id);
      sync(null);
    },
    [sync]
  );

  return {
    conversations,
    activeId,
    messages,
    status,
    pending,
    send,
    compose,
    selectConversation,
    newConversation,
    removeConversation
  };
}

/**
 * The introspection view — a pure-client window into the observer's current
 * state: what it is trying to do and why, what it prioritizes, what it
 * wants to learn, what it believes about itself, how healthy its memory is,
 * how much of its own judgment it trusts, and what the training loop is up
 * to. Everything here reads the server's /api/introspection snapshot; the
 * view holds no model state of its own.
 */
import { useEffect, useState } from 'react';
import type { RemoteClient } from '../server/client';

interface IntrospectViewProps {
  client: RemoteClient;
  /** Bumped externally (SSE-driven) to refresh. */
  revision: number;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-4">
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-right text-xs text-slate-200" title={hint}>
        {value}
      </span>
    </div>
  );
}

export function IntrospectView({ client, revision }: IntrospectViewProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      client
        .introspection()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch((reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
        });
    };
    load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [client, revision]);

  if (error !== null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-rose-400">
        introspection unavailable — {error}
      </div>
    );
  }
  if (snapshot === null) {
    return <div className="flex flex-1 items-center justify-center text-sm text-slate-500">reading the observer's mind…</div>;
  }

  const objectives = snapshot.objectives as {
    goals: Array<{ target: string; type: string; priority: number; reason: string }>;
    stalled: Array<{ type: string; target: string }>;
    history: Record<string, { completed: number; abandoned: number }>;
  };
  const drives = snapshot.drives as {
    signals: Record<string, number>;
    behaviorWeights: Record<string, number | undefined>;
    outcomes: Record<string, { wins: number; losses: number }>;
  };
  const curiosity = snapshot.curiosity as { question: string | null; gaps: string[] };
  const beliefs = snapshot.beliefs as Array<{ about: string; content: string; beliefKind: string; contradicts: boolean; strength: number }>;
  const memory = snapshot.memory as Record<string, number | boolean>;
  const trust = snapshot.trust as {
    lambdas: Record<string, number>;
    dependence: number;
    calibration: Array<{ gate: string; report: { samples: number; positiveRate: number; separator: number | null } }>;
    /** TASKS.md #17 — absent from snapshots taken by an older server. */
    deviation?: { answers: number; grounded: number; composed: number; abstained: number; groundedShare: number; composedShare: number; abstainedShare: number };
    /** The grader check's verdicts — absent from older servers. */
    graders?: Record<string, { trusted: boolean; auc: number | null; goodPass: number | null; probes: number; at: number; reason: string }>;
  };
  const training = snapshot.training as Record<string, number | boolean | null> | null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-6 py-5 lg:grid-cols-2">
      <Section title="Objectives">
        {objectives.goals.length === 0 ? (
          <p className="text-xs text-slate-600">No active goals.</p>
        ) : (
          <ul className="space-y-2">
            {objectives.goals.map((goal) => (
              <li key={`${goal.type}:${goal.target}`} className="rounded-lg bg-slate-950/60 p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-slate-200">{goal.target}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">{goal.type}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{goal.reason}</p>
              </li>
            ))}
          </ul>
        )}
        {objectives.stalled.length > 0 && (
          <p className="mt-2 text-[11px] text-amber-400/80">
            stalled: {objectives.stalled.map((goal) => `${goal.type}:${goal.target}`).join(', ')}
          </p>
        )}
        <div className="mt-3 space-y-1 border-t border-slate-800/60 pt-2">
          {Object.entries(objectives.history).map(([type, record]) => (
            <Row key={type} label={type} value={`${record.completed} done · ${record.abandoned} abandoned`} />
          ))}
        </div>
      </Section>

      <Section title="Drives">
        {Object.entries(drives.signals).map(([name, value]) => (
          <div key={name} className="py-0.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-slate-400">{name}</span>
              <span className="text-slate-200">{value.toFixed(2)}</span>
            </div>
            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-emerald-500/70" style={{ width: `${Math.min(100, value * 100)}%` }} />
            </div>
          </div>
        ))}
        <div className="mt-3 space-y-1 border-t border-slate-800/60 pt-2">
          {Object.entries(drives.outcomes).map(([behavior, outcome]) => (
            <Row
              key={behavior}
              label={behavior}
              value={`weight ${(drives.behaviorWeights[behavior] ?? 0).toFixed(2)} · ${outcome.wins}✓ ${outcome.losses}✗`}
            />
          ))}
        </div>
      </Section>

      <Section title="Curiosity">
        <Row label="current question" value={curiosity.question ?? '—'} />
        {curiosity.gaps.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600">No unanswered gaps.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {curiosity.gaps.map((gap) => (
              <li key={gap} className="text-xs text-slate-500">
                {gap}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Memory">
        <Row label="words" value={`${memory.learned} / ${memory.total}`} />
        <Row label="healthy" value={String(memory.healthy)} />
        <Row label="due for review" value={String(memory.due)} />
        <Row label="consolidated" value={String(memory.consolidated)} />
        <Row label="conversation competency" value={`${(Number(memory.competency) * 100).toFixed(0)}%`} />
        <Row label="creative unlocked" value={memory.creativeUnlocked === true ? 'yes' : 'no'} />
        <Row label="taught phrases" value={String(memory.taughtPhrases)} />
        <Row label="hypothesis edges" value={String(memory.hypothesisEdges)} />
        <Row label="compiled rules" value={String(memory.compiledRules)} />
        <Row label="learned operator patterns" value={String(memory.learnedPatterns)} />
        <Row label="rewrite rules" value={String(memory.rewriteRules)} />
      </Section>

      <Section title="Trust & calibration">
        {trust.deviation !== undefined && trust.deviation.answers > 0 && (
          <div className="mb-2 border-b border-slate-800/60 pb-2">
            <Row
              label="deviation meter"
              value={`${(trust.deviation.groundedShare * 100).toFixed(0)}% grounded · ${(trust.deviation.composedShare * 100).toFixed(0)}% uncited · ${(trust.deviation.abstainedShare * 100).toFixed(0)}% abstained`}
              hint={`read from what was said, over ${trust.deviation.answers} answers this session`}
            />
          </div>
        )}
        {trust.graders !== undefined && Object.keys(trust.graders).length > 0 && (
          <div className="mb-2 space-y-1 border-b border-slate-800/60 pb-2">
            {Object.entries(trust.graders).map(([name, entry]) => (
              <div key={name} className="text-[11px] text-slate-500">
                <span className={entry.trusted ? 'text-emerald-300' : 'text-rose-300'}>{entry.trusted ? 'grader trusted' : 'grader untrusted'}</span>{' '}
                <span className="text-slate-400">{name}</span>
                {entry.auc !== null ? ` · AUC ${entry.auc.toFixed(2)}` : ''}
                {entry.goodPass !== null ? ` · ${(entry.goodPass * 100).toFixed(0)}% of correct answers graded strong` : ''}
                <div className="text-slate-600">{entry.reason}</div>
              </div>
            ))}
          </div>
        )}
        <Row label="teacher dependence" value={`${(trust.dependence * 100).toFixed(0)}%`} hint="traffic-weighted mean teacher share (1 − λ)" />
        <div className="mt-1 space-y-1 border-t border-slate-800/60 pt-2">
          {Object.entries(trust.lambdas).map(([cls, lambda]) => (
            <Row key={cls} label={`handover λ · ${cls}`} value={lambda.toFixed(2)} />
          ))}
        </div>
        {trust.calibration.length === 0 ? (
          <p className="mt-2 text-xs text-slate-600">No calibration evidence yet.</p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {trust.calibration.map((gate) => (
              <div key={gate.gate} className="text-[11px] text-slate-500">
                <span className="text-slate-400">{gate.gate}</span> · {gate.report.samples} samples ·{' '}
                {(gate.report.positiveRate * 100).toFixed(0)}% positive
                {gate.report.separator !== null ? ` · measured separator ${gate.report.separator.toFixed(2)}` : ''}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Training loop">
        {training === null ? (
          <p className="text-xs text-slate-600">The training loop is stopped.</p>
        ) : (
          <>
            <Row label="cycles" value={String(training.cycles)} />
            <Row label="words taught" value={String(training.wordsTaught)} />
            <Row label="reviews" value={String(training.wordsReviewed)} />
            <Row label="phrases taught" value={String(training.phrasesTaught)} />
            <Row label="self-answered" value={String(training.selfAnswered)} />
            <Row label="drills run / induced" value={`${training.drillsRun} / ${training.drillsInduced}`} />
            {training.graderChecks !== undefined && (
              <Row
                label="grader checks / trusted"
                value={`${training.graderChecks} / ${training.graderTrusted === null ? 'not yet measured' : training.graderTrusted ? 'yes' : 'NO'}`}
                hint="known-good vs known-bad answers, graded by the teacher model; an untrusted grader's grades are not applied"
              />
            )}
            {training.curriculumRows !== undefined && (
              <Row
                label="corpus rows fed / taken"
                value={`${training.curriculumRows} / ${training.curriculumAccepted}`}
                hint="outside corpora (ConceptNet, dialogue, passages, problems) ingested by the classroom under its budget"
              />
            )}
            {training.goalSteps !== undefined && (
              <Row
                label="goal steps / completed / stalled"
                value={`${training.goalSteps} / ${training.goalsCompleted} / ${training.goalsStalled}`}
                hint="the goal loop (TASKS.md #18): a stalled goal raises its target in the lesson queue"
              />
            )}
          </>
        )}
      </Section>
    </div>
  );
}

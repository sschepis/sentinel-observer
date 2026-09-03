/**
 * THE RULE STORE PANEL (R8) — the observer's procedures, read-only.
 *
 * Every rewrite rule in the store: the authored decks and the learned
 * rules, with their origin, strength, corroboration classes, bits, use
 * counts, denials, and stopped state. The world grades rules through the
 * chat — the UI never edits them. Learned rules (induced/taught) sort
 * first; the authored axioms follow.
 */

import { useMemo, useState } from 'react';
import type { TeacherAgent } from '../teacher/TeacherAgent';

/** The store → panel snapshot (read-only view of the observer's rules). */
export function ruleStoreSnapshot(teacher: TeacherAgent): RulesPanelSnapshot {
  const store = teacher.rewriteRuleStore();
  return {
    rules: store.all().map((rule) => ({
      id: rule.id,
      name: rule.name,
      origin: rule.origin,
      strength: rule.strength,
      sourceClasses: [...rule.sourceClasses],
      bits: rule.bits,
      useCount: rule.useCount,
      stopped: store.isStopped(rule.id),
      hedged: rule.origin !== 'authored' && !rule.sourceClasses.includes('world-feedback'),
      denials: store.denialsOf(rule.id).length,
      schema: rule.schema,
      evidence: rule.evidence
    })),
    compiledCount: teacher.compiledRuleCount(),
    resolutions: teacher.ruleResolutionsView()
  };
}

export interface RulesPanelRule {
  id: string;
  name: string;
  origin: string;
  strength: number;
  sourceClasses: string[];
  bits: number;
  useCount: number;
  stopped: boolean;
  hedged: boolean;
  denials: number;
  schema?: string;
  evidence?: number;
}

export interface RulesPanelSnapshot {
  rules: RulesPanelRule[];
  compiledCount: number;
  resolutions: string[];
}

const ORIGIN_LABEL: Record<string, string> = {
  authored: 'deck',
  induced: 'induced',
  taught: 'taught',
  chaperone: 'chaperone',
  consolidated: 'consolidated'
};

export function RulesPanel({ snapshot }: { snapshot: RulesPanelSnapshot | null }) {
  const [showDecks, setShowDecks] = useState(false);
  const learned = useMemo(
    () => (snapshot?.rules ?? []).filter((rule) => rule.origin !== 'authored'),
    [snapshot]
  );
  const decks = useMemo(
    () => (snapshot?.rules ?? []).filter((rule) => rule.origin === 'authored'),
    [snapshot]
  );
  if (snapshot === null) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-8 text-sm text-slate-500">
        The observer is not awake — its rule store will appear here.
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium text-slate-100">Rules</h2>
        <p className="text-xs text-slate-500">
          {learned.length} learned · {decks.length} authored deck rules · {snapshot.compiledCount} compiled DSL rules
        </p>
      </div>

      {learned.length === 0 && (
        <p className="mt-6 rounded-lg border border-slate-800/80 bg-slate-900/40 p-4 text-sm text-slate-400">
          Nothing learned yet — drill a family (gcf is the flagship) and the observer will induce its rule here. A
          learned rule speaks hedged (&ldquo;I think&hellip;&rdquo;) until the world&apos;s grades corroborate it.
        </p>
      )}

      {learned.length > 0 && (
        <table className="mt-4 w-full border-collapse text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-slate-600">
              <th className="py-1.5 pr-3 font-medium">rule</th>
              <th className="py-1.5 pr-3 font-medium">origin</th>
              <th className="py-1.5 pr-3 font-medium">strength</th>
              <th className="py-1.5 pr-3 font-medium">corroboration</th>
              <th className="py-1.5 pr-3 font-medium">bits</th>
              <th className="py-1.5 pr-3 font-medium">uses</th>
              <th className="py-1.5 pr-3 font-medium">state</th>
            </tr>
          </thead>
          <tbody>
            {learned.map((rule) => (
              <tr key={rule.id} className="border-t border-slate-800/60 align-top">
                <td className="py-2 pr-3 font-mono text-sky-300/90">{rule.name}</td>
                <td className="py-2 pr-3">{ORIGIN_LABEL[rule.origin] ?? rule.origin}</td>
                <td className="py-2 pr-3">{rule.strength.toFixed(2)}</td>
                <td className="py-2 pr-3 text-slate-500">
                  {rule.sourceClasses.length === 0 ? '—' : rule.sourceClasses.join(', ')}
                </td>
                <td className="py-2 pr-3 text-slate-500">{rule.bits}</td>
                <td className="py-2 pr-3 text-slate-500">{rule.useCount}</td>
                <td className="py-2 pr-3">
                  {rule.stopped ? (
                    snapshot.resolutions.includes(rule.id) ? (
                      <span className="text-rose-400">stopped by the world</span>
                    ) : (
                      <span className="text-slate-500">consolidated away</span>
                    )
                  ) : rule.hedged ? (
                    <span className="text-amber-300/90">hedged</span>
                  ) : (
                    <span className="text-emerald-400/90">confirmed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button
        onClick={() => setShowDecks((open) => !open)}
        className="mt-6 text-xs font-medium text-slate-500 transition hover:text-slate-300"
        aria-expanded={showDecks}
      >
        {showDecks ? `hide the authored decks (${decks.length})` : `show the authored decks (${decks.length})`}
      </button>
      {showDecks && (
        <table className="mt-2 w-full border-collapse text-left text-xs">
          <tbody>
            {decks.map((rule) => (
              <tr key={rule.id} className="border-t border-slate-800/60 align-top">
                <td className="py-1.5 pr-3 font-mono text-slate-400">{rule.id}</td>
                <td className="py-1.5 pr-3 text-slate-600">
                  uses {rule.useCount} · {rule.denials > 0 ? `${rule.denials} denials` : 'never denied'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {snapshot.resolutions.length > 0 && (
        <p className="mt-6 text-xs text-slate-600">
          stopped by denial, never deleted: {snapshot.resolutions.join(', ')}
        </p>
      )}
    </div>
  );
}

/**
 * THE RULE-STORE SNAPSHOT — the observer's procedures, flattened for a
 * reader.
 *
 * This lived inside `components/RulesPanel.tsx`, which meant the SERVER
 * imported a React component module to build it: `ServerSession.rulesSnapshot()`
 * reached across into the browser's half of the tree, dragging a component
 * file into a process that has no DOM. The direction is now the only one
 * that makes sense — the model's side owns the reading, the panel renders
 * what it is given, and neither imports the other.
 */
import type { TeacherAgent } from './TeacherAgent';

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

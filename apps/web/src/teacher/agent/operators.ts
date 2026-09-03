/**
 * OPERATORS FACULTY — learned-operator lifecycle (agent split refactor).
 *
 * The learned-operator library (relation-hole language templates induced
 * from accepted grounded answers, plus DSL-compiled patterns) is a VIEW over
 * the observer's stored creative memories. State: operatorLearner and
 * learnedFrames live on TeacherAgentCore.
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';

import { LearnedFrameStore } from '../learnedFrames';



export function OperatorsMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class OperatorsFaculty extends Base {

    /** The learned language templates (P5 extension) — audit view for the
     *  bench/CLI: which structures were induced, admitted, and how the world
     *  grades them. */
    learnedTemplateAudit(): ReturnType<LearnedFrameStore['audit']> {
      return this.learnedFrames.audit();
    }

    /** Number of learned language patterns that have cleared the bar. */
    learnedPatternCount(): number {
      return this.operatorLearner.fireableCount();
    }

    /** MDL audit view of the learned-operator library (gains, maturity). */
    operatorAuditView() {
      return this.operatorLearner.audit();
    }

    /**
     * Rebuild the learned-operator library from the observer's stored creative
     * memories — memory is the source of truth; the pattern library is a view.
     */
    rebuildLearnedOperators(): void {
      const bank = this.session.observer.getMemoryBank();
      for (const trace of bank.all()) {
        if (trace.metadata?.kind !== 'creative' || typeof trace.metadata.uttered !== 'string') continue;
        const score = typeof trace.metadata.score === 'number' ? trace.metadata.score : 0.7;
        this.operatorLearner.learn(trace.metadata.uttered, trace.content, score);
      }
    }
  };
}

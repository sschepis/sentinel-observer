/**
 * AUTOLOOP FACULTY — the autonomous teach loop (agent split refactor).
 *
 * Runs teach -> ask -> grade -> next continuously on a human-watchable
 * cadence, driven by the observer's own state (decaying traces first, then
 * untaught words; recognition until success, then production). The loop
 * state lives on TeacherAgentCore (autoLoopToken/autoLoopRunning/autoStep/
 * autoListeners).
 */
import { TeacherAgentCore, type Constructor, type CrossFacultyApi } from './base';
import { hasDefinition } from '../deck';
import { sleep, type AutoLoopOptions, type AutoLoopHandle, type AutoLoopStep } from './support';

export function AutoLoopMixin<TBase extends Constructor<TeacherAgentCore & CrossFacultyApi>>(Base: TBase) {
  return class AutoLoopFaculty extends Base {

    /**
     * Run the school automatically: teach → ask → grade → next, continuously.
     *
     * The observer's own state drives WHAT to learn (curiosity: decaying
     * traces first, then untaught words) and the quiz direction (recognition
     * until a word has a success, then production — asking it to speak the
     * word from its meaning). The teacher only decides WHEN, on a human-
     * watchable cadence. The loop stops when the deck is exhausted and
     * nothing is decaying, or on stop()/dispose.
     */
    startAutoLoop(options: AutoLoopOptions = {}): AutoLoopHandle {
      if (this.autoLoopRunning) {
        return { stop: () => this.stopAutoLoop(), get running() { return false; } };
      }

      const token = ++this.autoLoopToken;
      this.autoLoopRunning = true;
      const teachPauseMs = options.teachPauseMs ?? 1500;
      const askPauseMs = options.askPauseMs ?? 1500;
      const gradePauseMs = options.gradePauseMs ?? 2500;

      const setStep = (step: AutoLoopStep) => {
        if (token !== this.autoLoopToken) return;
        this.autoStep = step;
        for (const listener of [...this.autoListeners]) {
          try {
            listener(step);
          } catch {
            // An isolated UI listener can never break the teaching loop.
          }
        }
      };

      void (async () => {
        setStep({ phase: 'idle', word: null, cue: null, answer: null, grade: null, message: 'the school begins' });
        try {
          while (token === this.autoLoopToken) {
            const word = this.nextReview() ?? this.nextNewWord();
            if (word === null) {
              setStep({
                phase: 'done',
                word: null,
                cue: null,
                answer: null,
                grade: null,
                message: 'the deck is learned — nothing is decaying and nothing is new'
              });
              break;
            }

            // Teach only what is new; reviews exercise existing traces.
            if (this.requiredState(word).traceId === null) {
              const teachResult = this.teach(word);
              setStep({
                phase: 'teaching',
                word,
                cue: null,
                answer: null,
                grade: null,
                message: teachResult.traceId !== null
                  ? `teaching "${word}" — stored in the observer's memory`
                  : `teaching "${word}" — the field was quiescent, nothing stored`
              });
              await sleep(teachPauseMs);
              if (token !== this.autoLoopToken) break;
            }

            // Recognition first: what does the word mean?
            const recognition = this.ask(word, 'recognition');
            setStep({
              phase: 'asking',
              word,
              cue: recognition.cue,
              answer: recognition.answer,
              grade: null,
              message: 'asking it for the meaning of the word'
            });
            await sleep(askPauseMs);
            if (token !== this.autoLoopToken) break;
            const recognitionGrade = this.grade(word, recognition);
            setStep({
              phase: 'grading',
              word,
              cue: recognition.cue,
              answer: recognition.answer,
              grade: recognitionGrade,
              message: `graded ${recognitionGrade.verdict}${recognitionGrade.confidence !== null ? ` (confidence ${recognitionGrade.confidence.toFixed(2)})` : ''}`
            });
            await sleep(gradePauseMs);
            if (token !== this.autoLoopToken) break;

            // Production: speak the word from its meaning — only when a
            // meaning exists. Word-only words are practiced by recognition
            // until the Chaperone fills their definitions.
            if (!hasDefinition(this.requiredState(word).word)) continue;
            const production = this.ask(word, 'production');
            setStep({
              phase: 'asking',
              word,
              cue: production.cue,
              answer: production.answer,
              grade: null,
              message: 'asking it to speak the word from its meaning'
            });
            await sleep(askPauseMs);
            if (token !== this.autoLoopToken) break;
            const productionGrade = this.grade(word, production);
            setStep({
              phase: 'grading',
              word,
              cue: production.cue,
              answer: production.answer,
              grade: productionGrade,
              message: `graded ${productionGrade.verdict}${productionGrade.confidence !== null ? ` (confidence ${productionGrade.confidence.toFixed(2)})` : ''}`
            });
            await sleep(gradePauseMs);
          }
        } catch (error) {
          setStep({
            phase: 'error',
            word: null,
            cue: null,
            answer: null,
            grade: null,
            message: error instanceof Error ? error.message : String(error)
          });
        } finally {
          if (token === this.autoLoopToken) {
            this.autoLoopRunning = false;
          }
        }
      })();

      const agent = this;
      return {
        stop: () => agent.stopAutoLoop(),
        get running() {
          return token === agent.autoLoopToken && agent.autoLoopRunning;
        }
      };
    }

    stopAutoLoop(): void {
      this.autoLoopToken += 1;
      this.autoLoopRunning = false;
    }

    /** Subscribe to loop steps; returns an unsubscribe function. */
    onAutoStep(listener: (step: AutoLoopStep) => void): () => void {
      this.autoListeners.add(listener);
      if (this.autoStep !== null) {
        listener(this.autoStep);
      }
      return () => this.autoListeners.delete(listener);
    }

    /** The latest loop step (null when the loop has never run). */
    getAutoStep(): AutoLoopStep | null {
      return this.autoStep;
    }

    /** Whether the autonomous loop is currently running. */
    isAutoLoopRunning(): boolean {
      return this.autoLoopRunning;
    }
  };
}

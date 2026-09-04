/**
 * OBSERVER NETWORK — the resonant council.
 *
 * The field is already a resonant cavity: Kuramoto coupling IS oscillators
 * observing each other, and coherence is agreement. The council is the same
 * dynamics lifted one level — specialized observers are the oscillators of
 * a meta-field. Each observer recalls the stimulus alone; if the responses
 * agree, that agreement IS the integrated answer. If they diverge, the
 * observers OBSERVE EACH OTHER: each one's answers perturb the others'
 * fields (observeText — a transient excitation, never a stored memory), the
 * fields settle, and they answer again. Rounds continue until the responses
 * resonate (max pairwise agreement) or the cavity stops narrowing.
 *
 * Network honesty: a grounded answer (memorized/operator — computed from a
 * member's own memory) is accepted from ANY single member — specialization
 * means one domain expert answers where the others abstain. Creative
 * answers only become the word of the network through AGREEMENT across
 * members (collective composition); with no agreement, an abstaining member
 * makes the network ask. The network never fabricates a consensus.
 */
import { TeacherAgent } from './TeacherAgent';
import { tokenizeText, isContentWord } from './context';
import { readCde, type CdeReading } from './cde';

export interface CouncilMember {
  name: string;
  teacher: TeacherAgent;
}

export interface CouncilMemberVerdict {
  name: string;
  mode: string;
  response: string;
  confidence: number | null;
}

export interface CouncilResult {
  answer: string;
  /** grounded = from a member's memory/operators; composed = agreed creative
   *  consensus; ask = the network asks. */
  mode: 'grounded' | 'composed' | 'ask';
  /** Resonance rounds used (0 = round-0 agreement; >0 = observed each other). */
  rounds: number;
  /** Max pairwise token-overlap agreement among responses (0..1). */
  agreement: number;
  /** Shannon entropy (bits) of the response token distribution — the
   *  black-body claim: agreement rounds should LOWER it. */
  entropy: number;
  members: CouncilMemberVerdict[];
  contributors: string[];
  /** Entropy at round 0 (before any resonance). */
  entropyRoundZero: number;
  /**
   * §2 candidate-distribution entropy over the members' answers — H̃, the
   * top-two margin, and the regime, read from each member's answer
   * (confidence when stated, else the presence of a claim vs. abstention).
   * Kept separate from the token `entropy` (the black-body meter) and from
   * §4.5's edge-based agreement. Pure instrumentation; nothing routes on it.
   */
  cde: CdeReading;
}

/** A shared learning goal the network formed from its own collective
 *  ignorance: recurring unanimous abstention on an utterance. */
export interface NetworkGoal {
  /** The utterance the whole council could not answer. */
  target: string;
  /** How many times the council has abstained on it. */
  misses: number;
  /** Whether the gap has since been filled (any member now answers). */
  active: boolean;
  /** One-shot: the goal was promoted to an active shared curriculum. Once
   *  true it is never reset — an abandoned goal cannot be re-adopted by a
   *  later abstention (no ping-pong). */
  adopted: boolean;
}

/** The council's learned goal-type preference (Phase 6d) — which kinds of
 *  shared goals the network's niches have absorbed and completed. */
export interface NetworkGoalPreference {
  /** Completed shared goals per type (learned by outcome). */
  completed: Record<string, number>;
  /** Abandoned shared goals per type. */
  abandoned: Record<string, number>;
}

/** Shannon entropy (bits) of a token distribution across responses. */
function responseEntropy(responses: readonly string[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const response of responses) {
    for (const token of tokenizeText(response)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      total += 1;
    }
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return total === 0 ? 0 : entropy;
}

/** Max pairwise token-overlap agreement across the members' responses. */
function maxPairwiseAgreement(verdicts: readonly CouncilMemberVerdict[]): number {
  let best = 0;
  for (let i = 0; i < verdicts.length; i += 1) {
    for (let j = i + 1; j < verdicts.length; j += 1) {
      const a = new Set(tokenizeText(verdicts[i].response));
      const b = new Set(tokenizeText(verdicts[j].response));
      if (a.size === 0 || b.size === 0) continue;
      let overlap = 0;
      for (const token of a) if (b.has(token)) overlap += 1;
      best = Math.max(best, overlap / Math.max(a.size, b.size));
    }
  }
  return best;
}

const GROUNDED_MODES = new Set(['memorized', 'operator']);

/** The council's candidate distribution: H̃ over the members' answers —
 *  each member's stated confidence when it carries one (memorized /
 *  creative), 1 for a non-empty non-ask response (an operator answer that
 *  carries no confidence field still IS a claim), and 0 for an abstention
 *  (ask / empty) — an abstainer is a candidate with no support. */
function candidateDistributionCde(verdicts: readonly CouncilMemberVerdict[]): CdeReading {
  return readCde(
    verdicts.map((v) => {
      if (typeof v.confidence === 'number' && Number.isFinite(v.confidence)) return v.confidence;
      if (v.mode === 'ask' || v.response.trim().length === 0) return 0;
      return 1;
    })
  );
}

/** Network-level learned trust: which specialist to credit for which cue,
 *  revised by resonance outcomes rather than assigned by construction. */
export type NetworkTrust = Record<string, number>;

export class ObserverNetwork {
  /** Per-member learned trust — wins in the agreeing cluster raise it;
   *  contributing to a failed/abstained outcome lowers it. */
  private readonly trust: NetworkTrust = {};
  /** Shared learning goals formed from the council's own abstention. */
  private readonly goals: Map<string, NetworkGoal> = new Map();
  /** The council's goal-type preference, learned by outcome (Phase 6d). */
  private readonly goalPreference: NetworkGoalPreference = { completed: {}, abandoned: {} };
  /** Recurring abstention promotion threshold (misses before a goal forms). */
  private readonly goalMissThreshold: number;

  constructor(
    private readonly members: CouncilMember[],
    private readonly maxRounds = 3,
    private readonly agreementThreshold = 0.6,
    private readonly trustGain = 0.2,
    private readonly trustPenalty = 0.1,
    goalMissThreshold = 2
  ) {
    if (members.length < 2) throw new Error('ObserverNetwork requires at least 2 members');
    for (const member of members) this.trust[member.name] = 0.5;
    this.goalMissThreshold = Math.max(1, goalMissThreshold);
  }

  /** The learned trust per member (read-only snapshot). */
  networkTrust(): NetworkTrust {
    return { ...this.trust };
  }

  /** The shared learning goals (read-only snapshot, sorted by misses). */
  networkGoals(): NetworkGoal[] {
    return [...this.goals.values()].sort((a, b) => b.misses - a.misses);
  }

  /** The council's learned goal-type preference (read-only). */
  networkGoalPreference(): NetworkGoalPreference {
    return {
      completed: { ...this.goalPreference.completed },
      abandoned: { ...this.goalPreference.abandoned }
    };
  }

  /** Credit the council's goal-type preference from a shared-goal outcome. */
  private creditGoalPreference(type: string, completed: boolean): void {
    const target = completed ? this.goalPreference.completed : this.goalPreference.abandoned;
    target[type] = (target[type] ?? 0) + 1;
  }

  /** The expected value of pursuing a given goal type, from the council's
   *  own history — which kinds of shared goals the network has found
   *  worth pursuing. Laplace prior 0.5 on untried types. */
  goalTypeExpectedValue(type: string): number {
    const completed = this.goalPreference.completed[type] ?? 0;
    const abandoned = this.goalPreference.abandoned[type] ?? 0;
    const total = completed + abandoned;
    return total === 0 ? 0.5 : completed / total;
  }

  /** All members adopt the network's goals as their own fill-gap goals.
 *  Returns the number of (member, goal) recordings made. */
  adoptNetworkGoals(): number {
    let recorded = 0;
    for (const goal of this.goals.values()) {
      if (!goal.active) continue;
      const utterance = goal.target;
      // The goal is a gap each member should fill from its own teaching.
      for (const member of this.members) {
        if (!member.teacher.listGaps().includes(utterance)) {
          member.teacher.recordGap(utterance);
          recorded += 1;
        }
      }
    }
    return recorded;
  }

  private registerAbstention(utterance: string, grounded: boolean): void {
    const existing = this.goals.get(utterance);
    if (existing !== undefined) {
      existing.misses += 1;
      return;
    }
    // Only count when the network was NOT grounded — a grounded answer means
    // the council knows it, so there is no deficit to form a goal over.
    if (!grounded) {
      this.goals.set(utterance, { target: utterance, misses: 1, active: false, adopted: false });
    }
  }

  /** The council learned a gap: if every member can now answer it, the
   *  shared goal is complete. */
  private refreshGoalCompletion(utterance: string): void {
    const goal = this.goals.get(utterance);
    if (goal === undefined) return;
    const anyAnswers = this.members.some((m) => {
      const answer = m.teacher.chatAnswer(utterance);
      return (answer.mode === 'memorized' || answer.mode === 'operator') && 'response' in answer;
    });
    goal.active = anyAnswers; // filled when any member now answers
  }

  private creditTrust(names: readonly string[], win: boolean): void {
    for (const name of names) {
      const current = this.trust[name] ?? 0.5;
      const next = current + (win ? this.trustGain : -this.trustPenalty);
      this.trust[name] = Math.max(0.05, Math.min(1, next));
    }
  }

  private askAll(utterance: string): CouncilMemberVerdict[] {
    return this.members.map((member) => {
      const answer = member.teacher.chatAnswer(utterance);
      return {
        name: member.name,
        mode: answer.mode,
        response: 'response' in answer ? (answer.response ?? answer.mode) : `(${answer.mode})`,
        confidence: 'confidence' in answer ? answer.confidence ?? null : null
      };
    });
  }

  /** The observers observe each other: each member's field is perturbed by
   *  its peers' current answers (a transient excitation — observe, never
   *  store), settles, and answers the stimulus once more. */
  private resonanceRound(utterance: string, current: CouncilMemberVerdict[]): CouncilMemberVerdict[] {
    for (const member of this.members) {
      const peers = current.filter((v) => v.name !== member.name && v.response !== `(${v.mode})`);
      for (const peer of peers) member.teacher.perturb(peer.response);
    }
    return this.askAll(utterance);
  }

  /**
   * Respond to a stimulus through the whole network. Returns the integrated
   * answer plus the resonance trajectory (rounds, agreement, entropy) — the
   * deviation meter of the network.
   */
  respond(utterance: string): CouncilResult {
    let verdicts = this.askAll(utterance);
    const entropyRoundZero = responseEntropy(verdicts.map((v) => v.response));
    let agreement = maxPairwiseAgreement(verdicts);
    let rounds = 0;

    // A grounded answer from ANY member settles the question — the domain
    // expert speaks where the others abstain; the answer is computed from
    // that member's own memory, not invented. When several grounded answers
    // compete, learned trust breaks the tie: the specialist whose grounded
    // answers have reliably landed in the consensus speaks first.
    const grounded = verdicts.filter((v) => GROUNDED_MODES.has(v.mode) && v.response.trim().length > 0);
    if (grounded.length > 0) {
      const best = grounded.sort((a, b) => {
        const tie = (b.confidence ?? 0) - (a.confidence ?? 0);
        if (tie !== 0) return tie;
        return (this.trust[b.name] ?? 0.5) - (this.trust[a.name] ?? 0.5);
      })[0];
      // A grounded WIN: the credited specialist lands in the consensus.
      this.creditTrust([best.name], true);
      // A grounded answer means the council now knows it — any dangling
      // deficit goal on this utterance is resolved (a shared-goal success).
      const goal = this.goals.get(utterance);
      if (goal !== undefined) {
        this.creditGoalPreference('fill-gap', true);
        this.goals.delete(utterance);
      }
      return {
        answer: best.response,
        mode: 'grounded',
        rounds,
        agreement: 1,
        entropy: responseEntropy([best.response]),
        entropyRoundZero,
        members: verdicts,
        contributors: [best.name],
        cde: candidateDistributionCde(verdicts)
      };
    }

    // No grounded voice: the council must resonate — UNLESS everyone
    // already abstained. Agreement on ignorance is abstention, not
    // consensus: a unanimous ask is the network asking.
    const unanimousAsk = verdicts.every((v) => v.mode === 'ask');
    if (unanimousAsk) {
      // NETWORK GOAL FORMATION: a recurring unanimous abstention is the
      // council noticing its own collective ignorance. Once it recurs
      // enough times, the council forms a SHARED goal to learn the
      // utterance — collective curiosity becomes collective curriculum.
      // (A unanimous ask is BY DEFINITION not grounded — pass false or the
      // goal would never be created, the exact scenario this branch exists
      // for.)
      this.registerAbstention(utterance, false);
      const goal = this.goals.get(utterance);
      if (goal !== undefined && goal.misses >= this.goalMissThreshold && !goal.adopted) {
        goal.adopted = true;
        goal.active = true;
      }
      // A goal that recurs well past the threshold without any resolution
      // is ABANDONED — the council has tried and the collective curriculum
      // moves on, honestly recording the failure in its preference. The
      // one-shot `adopted` flag means an abandoned goal is NEVER re-promoted
      // by a later abstention (no adopt/abandon ping-pong).
      if (goal !== undefined && goal.adopted && goal.active && goal.misses >= this.goalMissThreshold + 3) {
        this.creditGoalPreference('fill-gap', false);
        goal.active = false;
      }
      return {
        answer: verdicts[0].response,
        mode: 'ask',
        rounds,
        agreement: 1,
        entropy: responseEntropy(verdicts.map((v) => v.response)),
        entropyRoundZero,
        members: verdicts,
        contributors: [],
        cde: candidateDistributionCde(verdicts)
      };
    }

    // No grounded voice and no unanimous ask: the council is composing without
    // certainty. This is still a deficit — register it so a recurring deficit
    // forms a goal even when one member can craft a plausible-sounding
    // composition (the network must not mistake fluency for knowledge).
    this.registerAbstention(utterance, false);

    // Members observe each other until their responses resonate, the rounds
    // run out, or everyone has abstained.
    let result: CouncilResult | null = null;
    while (rounds < this.maxRounds && agreement < this.agreementThreshold) {
      verdicts = this.resonanceRound(utterance, verdicts);
      rounds += 1;
      agreement = maxPairwiseAgreement(verdicts);
      if (verdicts.every((v) => v.mode === 'ask')) break;
      if (agreement >= this.agreementThreshold) break;
    }

    const abstainers = verdicts.filter((v) => v.mode === 'ask' && v.response.trim().length > 0);
    const cluster = agreement >= this.agreementThreshold ? this.agreeingCluster(verdicts, agreement) : null;
    const clusterIsAbstention = cluster !== null && cluster.every((v) => v.mode === 'ask');
    if (cluster !== null && !clusterIsAbstention) {
      // The cavity resonated: the agreeing cluster is the integrated response.
      // NETWORK TRUST: the agreeing cluster WINS; members who actively spoke
      // but did not land in the consensus LOSE (their answer competed and
      // lost), so the network learns which specialists cohere.
      this.creditTrust(cluster.map((v) => v.name), true);
      const losers = verdicts.filter((v) => v.mode !== 'ask' && !cluster.some((c) => c.name === v.name));
      this.creditTrust(losers.map((v) => v.name), false);
      // Any shared goal on this utterance is promoted once the council
      // reaches consensus on how to respond to it — a deficit is now a
      // formed goal. (Resolution — the goal actually being ANSWERABLE — is
      // credited as a success separately when a grounded answer appears.)
      const goal = this.goals.get(utterance);
      if (goal !== undefined && goal.misses >= this.goalMissThreshold && !goal.adopted) {
        goal.adopted = true;
        goal.active = true;
      }
      result = {
        answer: cluster[0].response,
        mode: 'composed',
        rounds,
        agreement,
        entropy: responseEntropy(cluster.map((v) => v.response)),
        entropyRoundZero,
        members: verdicts,
        contributors: cluster.map((v) => v.name),
        cde: candidateDistributionCde(verdicts)
      };
    } else if (abstainers.length > 0) {
      // No consensus and someone is honest about not knowing — the network
      // asks rather than fabricating a consensus.
      result = {
        answer: abstainers[0].response,
        mode: 'ask',
        rounds,
        agreement,
        entropy: responseEntropy(verdicts.map((v) => v.response)),
        entropyRoundZero,
        members: verdicts,
        contributors: [],
        cde: candidateDistributionCde(verdicts)
      };
    } else {
      // No agreement and no honest abstainer: the members SPOKE but nothing
      // resonated. A single member's composition is NOT the network's word —
      // creative answers become the council's answer only through AGREEMENT
      // (module contract, "never fabricates a consensus"). The network asks.
      result = {
        answer: 'I do not know.',
        mode: 'ask',
        rounds,
        agreement,
        entropy: responseEntropy(verdicts.map((v) => v.response)),
        entropyRoundZero,
        members: verdicts,
        contributors: [],
        cde: candidateDistributionCde(verdicts)
      };
    }
    return result;
  }

  private agreeingCluster(verdicts: CouncilMemberVerdict[], agreement: number): CouncilMemberVerdict[] {
    // The highest-similarity pair defines the consensus; members whose
    // response matches either member of the pair join the integrated answer.
    let best: [CouncilMemberVerdict, CouncilMemberVerdict] | null = null;
    let bestScore = 0;
    for (let i = 0; i < verdicts.length; i += 1) {
      for (let j = i + 1; j < verdicts.length; j += 1) {
        const a = new Set(tokenizeText(verdicts[i].response));
        const b = new Set(tokenizeText(verdicts[j].response));
        if (a.size === 0 || b.size === 0) continue;
        let overlap = 0;
        for (const token of a) if (b.has(token)) overlap += 1;
        const score = overlap / Math.max(a.size, b.size);
        if (score > bestScore) {
          bestScore = score;
          best = [verdicts[i], verdicts[j]];
        }
      }
    }
    if (best === null) return [verdicts[0]];
    const seed = new Set([best[0].response, best[1].response]);
    return verdicts.filter((v) => seed.has(v.response));
  }

  /** Names of the members (for reporting). */
  get memberNames(): string[] {
    return this.members.map((m) => m.name);
  }
}
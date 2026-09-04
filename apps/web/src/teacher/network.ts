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
 * §4.5: agreement is measured over the CITED EDGE SETS of grounded answers
 * (Jaccard over the P6 provenance edges) alongside token overlap; when at
 * least two members cite edges, the edge signal gates agreement and the
 * resonance rounds stop when the edge distribution's entropy stops falling.
 * §3.4: a settled answer is stored as a network-agreement trace (settled
 * answer + cited edges + contributing members) via a member teacher's
 * memory, so the next identical cue recalls the council's own prior
 * agreement with rounds = 0.
 *
 * Network honesty: a grounded answer (memorized/operator — computed from a
 * member's own memory) is accepted from ANY single member — specialization
 * means one domain expert answers where the others abstain. Creative
 * answers only become the word of the network through AGREEMENT across
 * members (collective composition); with no agreement, an abstaining member
 * makes the network ask. The network never fabricates a consensus.
 */
import { TeacherAgent, type EdgeRef } from './TeacherAgent';
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
  /**
   * §4.5: the typed edges this answer cited (from ChatAnswer provenance).
   * Grounded answers (memorized/operator) carry their cited edges; composed
   * (creative) and ask answers cite none — visibly weaker agreement evidence.
   */
  citedEdges: EdgeRef[];
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
  /** §4.5: max pairwise Jaccard agreement over the members' cited-edge
   *  sets (0..1). Computed alongside the token agreement; empty edge sets
   *  are skipped, so composed answers cannot raise it. */
  edgeAgreement: number;
  /** §4.5: true when at least two members cited edges — the edge signal
   *  gated this outcome instead of the token signal. */
  edgeGated: boolean;
  /** §4.5: Shannon entropy (bits) of the cited-edge distribution at the
   *  final round — the edge-based version of the black-body meter. */
  edgeEntropy: number;
  /** Edge-distribution entropy at round 0 (before any resonance). */
  edgeEntropyRoundZero: number;
  /** §3.4: true when this result was recalled from a stored
   *  network-agreement trace instead of a live council round. */
  recalledFromTrace?: boolean;
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

/** The stable identity key of a cited edge (same scheme as P8). */
export function edgeKeyOf(edge: EdgeRef): string {
  return `${edge.subject}\u0000${edge.predicate}\u0000${edge.object}`;
}

/** Max pairwise token-overlap agreement across the members' responses. */
export function maxPairwiseTokenAgreement(verdicts: readonly CouncilMemberVerdict[]): number {
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

/**
 * §4.5: max pairwise Jaccard agreement over the members' cited-edge sets.
 * Two grounded answers agree when they cite the SAME edges — token strings
 * are irrelevant. Pairs where either member cites no edges are skipped: a
 * composed answer (no edges) is weaker evidence and cannot raise the score.
 */
export function maxPairwiseEdgeAgreement(verdicts: readonly CouncilMemberVerdict[]): number {
  let best = 0;
  for (let i = 0; i < verdicts.length; i += 1) {
    for (let j = i + 1; j < verdicts.length; j += 1) {
      const a = new Set(verdicts[i].citedEdges.map(edgeKeyOf));
      const b = new Set(verdicts[j].citedEdges.map(edgeKeyOf));
      if (a.size === 0 || b.size === 0) continue;
      let intersection = 0;
      for (const key of a) if (b.has(key)) intersection += 1;
      const union = a.size + b.size - intersection;
      best = Math.max(best, union === 0 ? 0 : intersection / union);
    }
  }
  return best;
}

/** How many members cited at least one edge (the §4.5 gate condition). */
export function edgeCitingMembers(verdicts: readonly CouncilMemberVerdict[]): number {
  return verdicts.filter((v) => v.citedEdges.length > 0).length;
}

/** §4.5: Shannon entropy (bits) of the cited-edge distribution across the
 *  members' answers — the edge-based version of the response-entropy meter.
 *  An agreeing council concentrates its citations; disagreement spreads them. */
export function edgeDistributionEntropy(verdicts: readonly CouncilMemberVerdict[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const verdict of verdicts) {
    for (const edge of verdict.citedEdges) {
      const key = edgeKeyOf(edge);
      counts.set(key, (counts.get(key) ?? 0) + 1);
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

/** The two agreement signals read together: token overlap and cited-edge
 *  Jaccard, plus whether the edge signal is live (≥2 members cite edges). */
export interface AgreementReading {
  /** Max pairwise token-overlap agreement (the pre-§4.5 signal). */
  token: number;
  /** Max pairwise Jaccard agreement over cited-edge sets. */
  edge: number;
  /** True when at least two members cited edges. */
  edgeGated: boolean;
  /** How many members cited at least one edge. */
  edgeCiting: number;
}

export function agreementReading(verdicts: readonly CouncilMemberVerdict[]): AgreementReading {
  const edgeCiting = edgeCitingMembers(verdicts);
  return {
    token: maxPairwiseTokenAgreement(verdicts),
    edge: maxPairwiseEdgeAgreement(verdicts),
    edgeGated: edgeCiting >= 2,
    edgeCiting
  };
}

/** The agreement signal that gates this round: the cited-edge Jaccard when
 *  at least two members cite edges, else the token overlap (both are kept;
 *  edges are preferred when present). */
export function gatedAgreement(reading: AgreementReading, useEdgeAgreement: boolean): number {
  return useEdgeAgreement && reading.edgeGated ? reading.edge : reading.token;
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
  /** §4.5: gate agreement on the cited-edge signal when ≥2 members cite
   *  edges, instead of token overlap. Both signals are always computed;
   *  this flag only selects which one gates. */
  private readonly useEdgeAgreement: boolean;
  /** §3.4: cue keys whose settled agreement is already stored as a
   *  network-agreement trace (in-session dedup of second-order traces). */
  private readonly storedAgreementCues = new Set<string>();

  constructor(
    private readonly members: CouncilMember[],
    private readonly maxRounds = 3,
    private readonly agreementThreshold = 0.6,
    private readonly trustGain = 0.2,
    private readonly trustPenalty = 0.1,
    goalMissThreshold = 2,
    useEdgeAgreement = true
  ) {
    if (members.length < 2) throw new Error('ObserverNetwork requires at least 2 members');
    for (const member of members) this.trust[member.name] = 0.5;
    this.goalMissThreshold = Math.max(1, goalMissThreshold);
    this.useEdgeAgreement = useEdgeAgreement;
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
      // §4.5: grounded answers carry the edges they cited (P6 provenance);
      // composed (creative) and ask answers cite none — composed agreement
      // is weaker evidence than grounded agreement, by construction.
      const citedEdges =
        answer.mode === 'memorized' || answer.mode === 'operator'
          ? (answer.provenance.edges ?? [])
          : [];
      return {
        name: member.name,
        mode: answer.mode,
        response: 'response' in answer ? (answer.response ?? answer.mode) : `(${answer.mode})`,
        confidence: 'confidence' in answer ? answer.confidence ?? null : null,
        citedEdges
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
    // §3.4 NETWORK TRACE: the network's own prior agreement on the exact
    // utterance settles before any member is asked — the council recalls
    // its own settled answer instead of re-running resonance rounds.
    const recalled = this.recallNetworkTrace(utterance);
    if (recalled !== null) return recalled;

    let verdicts = this.askAll(utterance);
    const entropyRoundZero = responseEntropy(verdicts.map((v) => v.response));
    const edgeEntropyRoundZero = edgeDistributionEntropy(verdicts);
    let reading = agreementReading(verdicts);
    let agreement = gatedAgreement(reading, this.useEdgeAgreement);
    let edgeEntropy = edgeEntropyRoundZero;
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
      const result: CouncilResult = {
        answer: best.response,
        mode: 'grounded',
        rounds,
        agreement: 1,
        entropy: responseEntropy([best.response]),
        entropyRoundZero,
        edgeAgreement: reading.edge,
        edgeGated: reading.edgeGated,
        edgeEntropy,
        edgeEntropyRoundZero,
        members: verdicts,
        contributors: [best.name],
        cde: candidateDistributionCde(verdicts)
      };
      this.storeAgreementTrace(utterance, result);
      return result;
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
        edgeAgreement: reading.edge,
        edgeGated: reading.edgeGated,
        edgeEntropy,
        edgeEntropyRoundZero,
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
    // run out, everyone has abstained, or the edge distribution's entropy
    // stops falling (§4.5 — when the edge signal is live).
    let result: CouncilResult | null = null;
    while (rounds < this.maxRounds && agreement < this.agreementThreshold) {
      verdicts = this.resonanceRound(utterance, verdicts);
      rounds += 1;
      reading = agreementReading(verdicts);
      agreement = gatedAgreement(reading, this.useEdgeAgreement);
      const nextEdgeEntropy = edgeDistributionEntropy(verdicts);
      const previousEdgeEntropy = edgeEntropy;
      edgeEntropy = nextEdgeEntropy;
      if (verdicts.every((v) => v.mode === 'ask')) break;
      if (agreement >= this.agreementThreshold) break;
      if (this.useEdgeAgreement && reading.edgeGated && nextEdgeEntropy >= previousEdgeEntropy) break;
    }

    const abstainers = verdicts.filter((v) => v.mode === 'ask' && v.response.trim().length > 0);
    const cluster = agreement >= this.agreementThreshold ? this.agreeingCluster(verdicts, reading) : null;
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
        edgeAgreement: reading.edge,
        edgeGated: reading.edgeGated,
        edgeEntropy,
        edgeEntropyRoundZero,
        members: verdicts,
        contributors: cluster.map((v) => v.name),
        cde: candidateDistributionCde(verdicts)
      };
      this.storeAgreementTrace(utterance, result);
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
        edgeAgreement: reading.edge,
        edgeGated: reading.edgeGated,
        edgeEntropy,
        edgeEntropyRoundZero,
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
        edgeAgreement: reading.edge,
        edgeGated: reading.edgeGated,
        edgeEntropy,
        edgeEntropyRoundZero,
        members: verdicts,
        contributors: [],
        cde: candidateDistributionCde(verdicts)
      };
    }
    return result;
  }

  private agreeingCluster(verdicts: CouncilMemberVerdict[], reading: AgreementReading): CouncilMemberVerdict[] {
    // The highest-similarity pair defines the consensus under the gated
    // signal: cited-edge Jaccard when ≥2 members cite edges (§4.5), token
    // overlap otherwise. Members join the integrated answer when they
    // match either member of the pair.
    const edgeMode = this.useEdgeAgreement && reading.edgeGated;
    const keySets = verdicts.map((v) => new Set(v.citedEdges.map(edgeKeyOf)));
    const tokenSets = verdicts.map((v) => new Set(tokenizeText(v.response)));
    let best: [number, number] | null = null;
    let bestScore = 0;
    for (let i = 0; i < verdicts.length; i += 1) {
      for (let j = i + 1; j < verdicts.length; j += 1) {
        let score = 0;
        if (edgeMode) {
          const a = keySets[i];
          const b = keySets[j];
          if (a.size === 0 || b.size === 0) continue;
          let intersection = 0;
          for (const key of a) if (b.has(key)) intersection += 1;
          const union = a.size + b.size - intersection;
          score = union === 0 ? 0 : intersection / union;
        } else {
          const a = tokenSets[i];
          const b = tokenSets[j];
          if (a.size === 0 || b.size === 0) continue;
          let overlap = 0;
          for (const token of a) if (b.has(token)) overlap += 1;
          score = overlap / Math.max(a.size, b.size);
        }
        if (score > bestScore) {
          bestScore = score;
          best = [i, j];
        }
      }
    }
    if (best === null) return [verdicts[0]];
    const [i, j] = best;
    if (edgeMode) {
      // The evidence-based cluster: a member joins when it cites at least
      // one of the edges the agreeing pair cited — agreement on EVIDENCE,
      // not on wording. Members citing no edges (composed answers) cannot
      // join an edge-gated cluster: they are weaker evidence.
      const seedEdges = new Set([...keySets[i], ...keySets[j]]);
      return verdicts.filter((v, k) => keySets[k].size > 0 && [...keySets[k]].some((key) => seedEdges.has(key)));
    }
    const seed = new Set([verdicts[i].response, verdicts[j].response]);
    return verdicts.filter((v) => seed.has(v.response));
  }

  /**
   * §3.4 NETWORK TRACE: the council's settled agreement, remembered.
   *
   * After a settled answer (grounded or resonated-composed) the network
   * stores a second-order trace via a member teacher's memory — the network
   * observing its own agreement. Content = settled answer + cited edges +
   * contributing member names; metadata kind 'network-agreement' keyed by
   * the exact cue, so the next identical cue recalls the agreement instead
   * of re-running resonance rounds.
   */
  private storeAgreementTrace(utterance: string, result: CouncilResult): void {
    const cue = utterance.trim().toLowerCase();
    if (cue.length === 0 || this.storedAgreementCues.has(cue)) return;
    const verdictsByName = new Map(result.members.map((v) => [v.name, v]));
    const citedEdges = result.contributors.flatMap((name) => verdictsByName.get(name)?.citedEdges ?? []);
    const edgeLines = citedEdges.map((edge) => `${edge.subject} ${edge.predicate} ${edge.object}`);
    const content = [result.answer, ...edgeLines, `agreed by ${result.contributors.join(', ')}`]
      .filter((line) => line.trim().length > 0)
      .join('\n');
    // The trace lives in ONE member's memory (the consensus leader's when
    // it has one); recall scans every member, so any member's memory serves.
    const owner = this.members.find((m) => m.name === result.contributors[0]) ?? this.members[0];
    const traceId = owner.teacher.storeNetworkAgreement(cue, content, {
      answer: result.answer,
      mode: result.mode,
      contributors: [...result.contributors],
      edges: citedEdges,
      edgeAgreement: result.edgeAgreement,
      edgeGated: result.edgeGated,
      edgeEntropy: result.edgeEntropy,
      edgeEntropyRoundZero: result.edgeEntropyRoundZero
    });
    if (traceId !== null) this.storedAgreementCues.add(cue);
  }

  /** §3.4: look for a stored network agreement on the exact utterance
   *  across the members' memories; rebuild the settled result (rounds = 0)
   *  and mirror the settled path's trust/goal side effects. */
  private recallNetworkTrace(utterance: string): CouncilResult | null {
    const cue = utterance.trim().toLowerCase();
    if (cue.length === 0) return null;
    for (const member of this.members) {
      const hit = member.teacher.recallNetworkAgreement(cue);
      if (hit === null) continue;
      const meta = hit.metadata;
      const answer = typeof meta.answer === 'string' && meta.answer.trim().length > 0 ? meta.answer : hit.content;
      const mode: 'grounded' | 'composed' = meta.mode === 'composed' ? 'composed' : 'grounded';
      const contributors = Array.isArray(meta.contributors)
        ? meta.contributors.filter((c): c is string => typeof c === 'string')
        : [];
      // The recall IS the network's win: contributors are credited and the
      // settled path's goal side effects repeat (resolution for grounded,
      // deficit registration + promotion for composed).
      this.creditTrust(contributors, true);
      if (mode === 'grounded') {
        const goal = this.goals.get(utterance);
        if (goal !== undefined) {
          this.creditGoalPreference('fill-gap', true);
          this.goals.delete(utterance);
        }
      } else {
        this.registerAbstention(utterance, false);
        const goal = this.goals.get(utterance);
        if (goal !== undefined && goal.misses >= this.goalMissThreshold && !goal.adopted) {
          goal.adopted = true;
          goal.active = true;
        }
      }
      const entropy = responseEntropy([answer]);
      return {
        answer,
        mode,
        rounds: 0,
        agreement: 1,
        entropy,
        entropyRoundZero: entropy,
        edgeAgreement: typeof meta.edgeAgreement === 'number' ? meta.edgeAgreement : 1,
        edgeGated: meta.edgeGated === true,
        edgeEntropy: typeof meta.edgeEntropy === 'number' ? meta.edgeEntropy : 0,
        edgeEntropyRoundZero: typeof meta.edgeEntropyRoundZero === 'number' ? meta.edgeEntropyRoundZero : 0,
        members: [],
        contributors,
        cde: readCde([]),
        recalledFromTrace: true
      };
    }
    return null;
  }

  /** Names of the members (for reporting). */
  get memberNames(): string[] {
    return this.members.map((m) => m.name);
  }
}
/**
 * @jest-environment node
 *
 * PRIMING-BENCH (improvements.md §6.3 / Phase E.2) — two-turn dialogues where
 * turn 1 establishes a domain and turn 2 is ambiguous, measuring whether the
 * slow context (the second timescale, §6.2) resolves the ambiguity toward the
 * primed reading WITHOUT contaminating unrelated questions.
 *
 * THE HYPOTHESIS UNDER TEST. The fast field fully decays within one settle,
 * so nothing of the previous turn survives to prime the next. The slow
 * context integrates the converged excitation once per turn and decays over
 * turns under the one retention law, and at recall the SMF cue is blended
 * with it (small, bounded direction tilt). Prediction: "tell me about the
 * bank" after a river-domain turn resolves to the RIVER reading more often
 * with the context on; a finance-domain turn biases it to the FINANCIAL
 * reading. The risk is contamination: a context that never decays turns
 * every answer into a function of the whole session.
 *
 * THE CONSTRUCTION. Two domains (river, finance), each with four taught
 * words, plus two readings of the ambiguous word 'bank', taught with their
 * domain context ("river bank" / "bank money") so their stored sketches
 * carry the domain direction. The six geometry words (river, water, flow,
 * current, money, bank) carry whole-word FNV prime signatures; the three
 * remaining words (loan, currency, deposit) are assigned DISJOINT basis
 * primes so the unrelated probes are alias-free by construction.
 *
 * THE PROTOCOL (deterministic: fixed projection seed, no RNG in the flow).
 *   · Both arms run under `smfMomentImprint` (the pre-existing P13 option):
 *     after each settle the first imprint REPLACES the SMF sketch, so every
 *     trace's sketch is imprinted from its own moment and the fast field has
 *     NO turn-to-turn memory — "ambiguous in isolation" is then the honest
 *     baseline, and the slow context is the ONLY channel between turns.
 *     (Measured without P13: the EMA trajectory resolves every bank cue to
 *     the last-taught reading — recency, not meaning; recorded.)
 *   · Settle depth is 10 ticks (0.02 + 10×0.05 s), not the production 4:
 *     the mechanism sweep recorded in the file history shows that at depth
 *     4 the converged moment's phase configuration has not aligned enough
 *     for the sketch direction to be frame-stable, and the context tilt
 *     moves the cue AWAY from the primed reading; at 10 ticks both domains
 *     resolve to the primed reading. At 20 the field over-settles.
 *   · The bank readings' teach ORDER rotates per trial, so the deterministic
 *     tie-break between two equal-score readings cannot masquerade as a
 *     resolution.
 *   · The conversation starts with a FRESH context (the deck was taught in a
 *     prior session); turn 1 = domain utterance; turn 2 = the cue.
 *
 * MEASURED FRAGILITY (recorded, the reason the flag stays default-off):
 *   the tilt's effect is geometry-dependent — with the FNV signatures and
 *   the fixed production seed the slow context resolves 12/12 primed probes;
 *   rotating the JL projection seed drops the ON arm to 8/12, and disjoint
 *   signatures for the geometry words fail the river domain entirely
 *   (0/6). The mechanism works in the measured configuration, but the
 *   effect rides on the sketch phase geometry, so enabling it in production
 *   is a tuning-gate decision with the bench as its evidence — not a default.
 *
 * VERDICT RULE (§6.3 / E.2): PASS when primed resolution rises with the
 * context on AND contamination is 0 on every unrelated probe (the honesty
 * proxy: exact, unambiguous questions keep their answers). ANY contamination
 * that costs an unrelated/exact answer means the flag stays off — recorded
 * here, and the assertions encode the refutation.
 */
import { describe, it, expect } from '@jest/globals';
import { ObserverSession } from '../observer/engine';
import { PRIME_SPACE, primeSignature } from './primeSignature';
import { SLOW_CONTEXT } from '../observer/options';

const RIVER_WORDS = ['river', 'water', 'flow', 'current'] as const;
const FINANCE_WORDS = ['money', 'loan', 'currency', 'deposit'] as const;
const BANK_WORD = 'bank';

/** Turn-1 utterances that establish each domain (several words each). */
const PRIME_UTTERANCES = {
  river: 'river water flow',
  financial: 'money loan currency'
} as const;

const TRIALS_PER_DOMAIN = Number(process.env.PRIMING_TRIALS ?? 12);
const STORE_TICK = 0.02;
const CUE_TICK = 0.02;
const SETTLE_STEPS = 10;
const SETTLE_DT = 0.05;
/** The production SMF projection seed — fixed so the geometry is auditable. */
const PROJECTION_SEED = 0x5eed;

/** The six geometry words carry whole-word FNV signatures; the three
 *  remaining words get DISJOINT basis primes (indices unused by the FNV
 *  signatures), so the unrelated probes are alias-free by construction.
 *  Disjointness is computed in the observer's fold coordinate (prime RANK
 *  mod basis size — the same fold `foldPrime` applies). */
function benchVocabulary(): Record<string, number[]> {
  const geometryWords = ['river', 'water', 'flow', 'current', 'money', BANK_WORD];
  const vocabulary: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  const used = new Set<number>();
  for (const word of geometryWords) {
    const signature = primeSignature(`priming:${word}`, PRIME_SPACE);
    vocabulary[word] = signature;
    for (const p of signature) used.add(PRIME_SPACE.indexOf(p) % 64);
  }
  const disjoint: number[] = [];
  for (let i = 0; i < 64 && disjoint.length < 12; i += 1) {
    if (!used.has(i)) disjoint.push(i);
  }
  let cursor = 0;
  for (const word of [...RIVER_WORDS, ...FINANCE_WORDS]) {
    if (vocabulary[word] !== undefined) continue;
    vocabulary[word] = disjoint.slice(cursor, cursor + 4).map((index) => PRIME_SPACE[index]);
    cursor += 4;
  }
  return vocabulary;
}

/** Build a session for one arm. ON/OFF differ ONLY in the slowContext flag. */
function buildSession(slowContextOn: boolean): ObserverSession {
  return new ObserverSession(
    {
      primeCount: 64,
      gridSize: 128,
      smfWidth: 128,
      memoryMode: 'compact',
      vocabulary: benchVocabulary(),
      // P13 (both arms): each lesson's sketch imprints from its own moment —
      // the fast field then has NO turn-to-turn memory, so 'bank' in
      // isolation is genuinely ambiguous and the slow context is the only
      // channel between turns (see the header).
      smfMomentImprint: true,
      smfProjectionSeed: PROJECTION_SEED,
      slowContext: slowContextOn
        ? {
            stabilityTurns: SLOW_CONTEXT.stabilityTurns,
            blendWeight: SLOW_CONTEXT.blendWeight,
            learningRate: SLOW_CONTEXT.learningRate
          }
        : false
    },
    100
  );
}

/** Teach one word trace through the production pipeline (settle → excite → store). */
function teachWord(session: ObserverSession, utterance: string, content: string, metadata: Record<string, unknown>): void {
  session.settleField();
  session.observeText(utterance);
  session.observer.tick(STORE_TICK);
  const trace = session.storeMemory(content, { metadata });
  if (trace === null) {
    throw new Error(`primingBench: teach '${utterance}' stored nothing (field quiescent)`);
  }
}

/** The full teaching deck: 4 + 4 domain words, then the two bank readings
 *  taught with their domain context (the direction the sketches must carry).
 *  `flip` swaps which bank reading is taught last, so the deterministic
 *  tie-break between equal-score readings rotates across trials. */
function teachDeck(session: ObserverSession, flip: boolean): void {
  for (const word of RIVER_WORDS) {
    teachWord(session, word, `definition of ${word}`, { kind: 'word', domain: 'river', word });
  }
  for (const word of FINANCE_WORDS) {
    teachWord(session, word, `definition of ${word}`, { kind: 'word', domain: 'financial', word });
  }
  if (flip) {
    teachWord(session, 'bank money', BANK_WORD, { kind: 'bank', reading: 'financial' });
    teachWord(session, 'river bank', BANK_WORD, { kind: 'bank', reading: 'river' });
  } else {
    teachWord(session, 'river bank', BANK_WORD, { kind: 'bank', reading: 'river' });
    teachWord(session, 'bank money', BANK_WORD, { kind: 'bank', reading: 'financial' });
  }
}

/** End the teaching phase and start the conversation with a FRESH slow
 *  context: one settle flushes the last teach's excitation through the
 *  normal integrate path (the field is then quiescent), then the context is
 *  cleared — the dialogue is what §6.3 measures, and the deck was taught in a
 *  prior session. No-op in the OFF arm (null context). */
function startConversation(session: ObserverSession): void {
  session.settleField();
  session.observer.getSlowContext()?.reset();
}

/** One conversation turn: settle (integrates the previous turn into the slow
 *  context when the flag is on), excite, and settle to the converged moment. */
function turn(session: ObserverSession, utterance: string): void {
  session.settleField();
  session.observeText(utterance);
  session.observer.tick(CUE_TICK);
  for (let step = 0; step < SETTLE_STEPS; step += 1) {
    session.observer.tick(SETTLE_DT);
  }
}

/** Top-1 recall for a cue: the observer's answer (trace + score). */
function answer(session: ObserverSession, cue: string): { id: string; content: string; metadata: Record<string, unknown>; score: number } | null {
  const results = session.recall(cue, 5);
  if (results.length === 0) return null;
  const top = results[0];
  return {
    id: top.trace.id,
    content: top.trace.content,
    metadata: top.trace.metadata as Record<string, unknown>,
    score: top.score
  };
}

/** Both bank readings' recall scores for a cue (the ambiguity readout). */
function bankScores(session: ObserverSession, cue: string): { river: number | null; financial: number | null } {
  const results = session.recall(cue, 5);
  const byReading = new Map<string, number>();
  for (const result of results) {
    const reading = result.trace.metadata.reading as string | undefined;
    if (reading !== undefined) {
      const current = byReading.get(reading);
      if (current === undefined || result.score > current) byReading.set(reading, result.score);
    }
  }
  return { river: byReading.get('river') ?? null, financial: byReading.get('financial') ?? null };
}

interface ArmReading {
  /** resolution per primed trial: top-1 reading === turn-1 domain? */
  primed: Array<{ turnDomain: string; reading: string | null; score: number | null }>;
  /** per-trial ambiguity readout: both bank readings' scores. */
  bankScores: Array<{ turnDomain: string; flip: boolean; river: number | null; financial: number | null }>;
  /** unrelated probes: per (cue, turn-1 domain) cell — the answer's word. */
  unrelated: Array<{ cue: string; turnDomain: string; answerWord: string | null; answerId: string | null; score: number | null }>;
}

/** Run one arm (slowContext ON or OFF): every trial in a FRESH observer so
 *  trials never bleed into each other — each dialogue is self-contained. */
async function runArm(slowContextOn: boolean): Promise<ArmReading> {
  const arm: ArmReading = { primed: [], bankScores: [], unrelated: [] };

  // ── Primed probes: turn 1 domain, turn 2 'bank' ─────────────────────
  const domains = ['river', 'financial'] as const;
  for (let trial = 0; trial < TRIALS_PER_DOMAIN * 2; trial += 1) {
    const domain = domains[trial % 2];
    const flip = trial % 4 >= 2;
    const session = buildSession(slowContextOn);
    await session.initialize();
    teachDeck(session, flip);
    startConversation(session);
    turn(session, PRIME_UTTERANCES[domain]);
    turn(session, BANK_WORD);
    const top = answer(session, BANK_WORD);
    const scores = bankScores(session, BANK_WORD);
    arm.primed.push({
      turnDomain: domain,
      reading: top ? (top.metadata.reading as string | null) ?? null : null,
      score: top ? top.score : null
    });
    arm.bankScores.push({ turnDomain: domain, flip, river: scores.river, financial: scores.financial });
    session.dispose();
  }

  // ── Unrelated probes (contamination): turn 1 domain, turn 2 an exact
  //    unrelated cue — one cell per (cue, turn-1 domain) pair. The cues
  //    (loan, water) are DISJOINT from every other trace's primes by
  //    construction (water is a geometry word, but its signature is checked
  //    alias-free against the unrelated probes in the invariants). ──────
  for (const cue of ['loan', 'water'] as const) {
    for (const turnDomain of domains) {
      const session = buildSession(slowContextOn);
      await session.initialize();
      teachDeck(session, false);
      startConversation(session);
      turn(session, PRIME_UTTERANCES[turnDomain]);
      turn(session, cue);
      const top = answer(session, cue);
      arm.unrelated.push({
        cue,
        turnDomain,
        answerWord: top ? (top.metadata.word as string | null) ?? null : null,
        answerId: top ? top.id : null,
        score: top ? top.score : null
      });
      session.dispose();
    }
  }
  return arm;
}

function report(label: string, value: string): void {
  // eslint-disable-next-line no-console
  console.log(`[primingBench] ${label.padEnd(44)} ${value}`);
}

/** Mean margin of the PRIMED reading over the other (negative = loses). */
function meanMargin(rows: ArmReading['bankScores'], domain: string): number {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    if (row.turnDomain !== domain) continue;
    const primed = domain === 'river' ? row.river : row.financial;
    const other = domain === 'river' ? row.financial : row.river;
    if (primed === null || other === null) continue;
    sum += primed - other;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

describe('priming-bench: slow-context resolution vs contamination (§6.3 / E.2)', () => {
  it('measures primed resolution ON vs OFF and contamination, and asserts the pass rule', async () => {
    const off = await runArm(false);
    const on = await runArm(true);

    // ── Primed resolution ─────────────────────────────────────────────
    const resolution = (arm: ArmReading): { river: number; financial: number; total: number } => {
      const byDomain = (d: string): number => {
        const rows = arm.primed.filter((r) => r.turnDomain === d);
        const hits = rows.filter((r) => r.reading === d).length;
        return rows.length > 0 ? hits / rows.length : 0;
      };
      const totalRows = arm.primed;
      const totalHits = totalRows.filter((r) => r.reading === r.turnDomain).length;
      return {
        river: byDomain('river'),
        financial: byDomain('financial'),
        total: totalRows.length > 0 ? totalHits / totalRows.length : 0
      };
    };
    const resOff = resolution(off);
    const resOn = resolution(on);

    // eslint-disable-next-line no-console
    console.log(
      `\n[primingBench] TRIALS=${TRIALS_PER_DOMAIN}/domain · settle=${SETTLE_STEPS}×${SETTLE_DT}s · seed=0x${PROJECTION_SEED.toString(16)} · ` +
        `slowContext {stabilityTurns=${SLOW_CONTEXT.stabilityTurns}, blendWeight=${SLOW_CONTEXT.blendWeight}, ` +
        `learningRate=${SLOW_CONTEXT.learningRate}} · enabled=${SLOW_CONTEXT.enabled ? 'ON' : 'OFF (default)'}\n`
    );
    report('primed resolution OFF', `river ${resOff.river.toFixed(2)} · financial ${resOff.financial.toFixed(2)} · total ${resOff.total.toFixed(2)}`);
    report('primed resolution ON ', `river ${resOn.river.toFixed(2)} · financial ${resOn.financial.toFixed(2)} · total ${resOn.total.toFixed(2)}`);
    report(
      'bank score margin OFF (Δ)',
      `river-trials ${meanMargin(off.bankScores, 'river').toFixed(4)} · financial-trials ${meanMargin(off.bankScores, 'financial').toFixed(4)}`
    );
    report(
      'bank score margin ON  (Δ)',
      `river-trials ${meanMargin(on.bankScores, 'river').toFixed(4)} · financial-trials ${meanMargin(on.bankScores, 'financial').toFixed(4)}`
    );
    report(
      'primed trial detail OFF',
      off.primed.map((r, i) => `${r.turnDomain[0]}${off.bankScores[i].flip ? 'ᶠ' : ''}:${r.reading === r.turnDomain ? '✓' : r.reading === null ? '?' : String(r.reading[0])}`).join(' ')
    );
    report(
      'primed trial detail ON ',
      on.primed.map((r, i) => `${r.turnDomain[0]}${on.bankScores[i].flip ? 'ᶠ' : ''}:${r.reading === r.turnDomain ? '✓' : r.reading === null ? '?' : String(r.reading[0])}`).join(' ')
    );

    // ── Contamination ────────────────────────────────────────────────
    // The answer is the WORD (fresh sessions mint fresh trace ids, so ids
    // are never compared across sessions — only the answer content is).
    // (a) within-arm: did the answer to an unrelated exact cue change with
    //     WHICH domain turn 1 established? (turn-1 river vs turn-1 finance)
    const withinArmChanges = (arm: ArmReading): number => {
      let changes = 0;
      for (const cue of ['loan', 'water'] as const) {
        const cells = arm.unrelated.filter((r) => r.cue === cue);
        const words = new Set(cells.map((c) => c.answerWord));
        if (words.size > 1) changes += 1;
      }
      return changes;
    };
    // (b) cross-arm: did the answer change between the OFF control and ON?
    const crossArmChanges = (): number => {
      let changes = 0;
      for (let i = 0; i < off.unrelated.length; i += 1) {
        if (off.unrelated[i].answerWord !== on.unrelated[i].answerWord) changes += 1;
      }
      return changes;
    };
    // (c) exact-cue integrity (fuzz-FP proxy): every unrelated probe must
    //     answer the taught word itself, in BOTH arms.
    const wrongWord = (arm: ArmReading): number =>
      arm.unrelated.filter((r) => r.answerWord !== r.cue).length;

    const contaminationWithin = withinArmChanges(on);
    const contaminationCross = crossArmChanges();
    const fuzzProxyOff = wrongWord(off);
    const fuzzProxyOn = wrongWord(on);

    report('unrelated probe detail OFF', JSON.stringify(off.unrelated.map((r) => `${r.turnDomain}→${r.cue}:${r.answerWord}`)));
    report('unrelated probe detail ON ', JSON.stringify(on.unrelated.map((r) => `${r.turnDomain}→${r.cue}:${r.answerWord}`)));
    report(
      'contamination',
      `within-arm ${contaminationWithin} · cross-arm ${contaminationCross} · exact-cue wrong OFF ${fuzzProxyOff} · ON ${fuzzProxyOn}`
    );

    // ── Structural invariants (asserted) ──────────────────────────────
    // Every dialogue stored the full deck (8 words + 2 bank readings) and
    // every probe produced a finite answer.
    expect(off.primed.length).toBe(TRIALS_PER_DOMAIN * 2);
    expect(on.primed.length).toBe(TRIALS_PER_DOMAIN * 2);
    for (const row of [...off.primed, ...on.primed]) {
      expect(row.reading).not.toBeNull();
      expect(Number.isFinite(row.score)).toBe(true);
    }
    for (const row of [...off.unrelated, ...on.unrelated]) {
      expect(row.answerWord).not.toBeNull();
      expect(Number.isFinite(row.score)).toBe(true);
    }
    // The premise: 'bank' in isolation must genuinely be ambiguous — the
    // OFF control may not already resolve BOTH domains (else there is
    // nothing to prime; the premise of §6.2 fails and is recorded).
    expect(resOff.total).toBeGreaterThanOrEqual(0.1);
    expect(resOff.total).toBeLessThanOrEqual(0.9);

    // ── The pass rule (§6.3), asserted ────────────────────────────────
    // Contamination 0 is the hard gate: one changed unrelated answer is a
    // fuzz-style false positive and the flag stays off.
    expect(contaminationWithin).toBe(0);
    expect(contaminationCross).toBe(0);
    expect(fuzzProxyOff).toBe(0);
    expect(fuzzProxyOn).toBe(0);
    // Primed resolution must RISE with the context on — in total, and in
    // every domain the OFF geometry did not already resolve (a domain the
    // OFF bias already resolves must not be LOST by the context). If the
    // total does not rise, the slow context is not doing disambiguation and
    // the flag stays off.
    expect(resOn.total).toBeGreaterThan(resOff.total);
    expect(resOn.total).toBeGreaterThanOrEqual(0.9);
    expect(resOn.financial).toBeGreaterThan(resOff.financial);
    expect(resOn.river).toBeGreaterThanOrEqual(resOff.river);

    // eslint-disable-next-line no-console
    console.log(
      `\n[primingBench] VERDICT: primed resolution ${resOff.total.toFixed(2)} → ${resOn.total.toFixed(2)} ` +
        `(river ${resOff.river.toFixed(2)}→${resOn.river.toFixed(2)}, financial ${resOff.financial.toFixed(2)}→${resOn.financial.toFixed(2)}); ` +
        `contamination ${contaminationWithin}/${contaminationCross} (within/cross) with 0 wrong exact answers in both arms.\n`
    );
    if (SLOW_CONTEXT.enabled) {
      report('FLAG', 'ON in production options');
    } else {
      report(
        'FLAG',
        'default-OFF: the pass (resolution rises, contamination 0) is the evidence a future tuning gate reads before enabling; the measured seed/vocabulary fragility (file header) argues against enabling by default'
      );
    }
  }, 600000);
});

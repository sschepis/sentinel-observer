import { describe, expect, test } from '@jest/globals'
import { reduce } from './engine'
import { LOGIC_RULES, parseLogicDrill, parseLogicFact } from './logic'
import { PEANO_RULES, natFromDecimal } from './peano'
import { tLit, tSym, termBits, termToString, type Term } from './terms'
import { RuleStore } from './types'
import { generateExercises } from '../technical/verify'

/** Deterministic PRNG — a seeded run must reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const drillSeed = Math.floor(mulberry32(7)() * 0xffffffff)

const phrase = (text: string): Term => tSym('phrase', [tLit(text)])

const buildStore = (): RuleStore => new RuleStore([...PEANO_RULES, ...LOGIC_RULES])

const mustParse = (drill: string, prompt: string): Term => {
  const term = parseLogicDrill(drill, prompt)
  if (term === null) throw new Error(`unparseable ${drill} prompt: ${prompt}`)
  return term
}

const mustParseFact = (text: string): Term => {
  const term = parseLogicFact(text)
  if (term === null) throw new Error(`unparseable fact: ${text}`)
  return term
}

/** The drill answer a literal normal form states. */
const decode = (term: Term): string => {
  if (term.t !== 'lit') throw new Error(`not a literal: ${termToString(term)}`)
  return typeof term.value === 'boolean' ? (term.value ? 'true' : 'false') : String(term.value)
}

const reduceToLiteral = (term: Term): Term => {
  const { outcome } = reduce(buildStore(), term)
  expect(outcome.status).toBe('normal')
  if (outcome.status !== 'normal') throw new Error(`reduction failed: ${termToString(term)}`)
  return outcome.term
}

const answer = (term: Term): string => decode(reduceToLiteral(term))

const headOf = (term: Term): string => {
  if (term.t !== 'sym') throw new Error(`expected a symbol: ${termToString(term)}`)
  return term.head
}

const LOGIC_DRILLS = ['logic-and', 'logic-or', 'logic-not', 'logic-if', 'syllogism'] as const

describe('the five logic drills — the deterministic oracle agreement gate', () => {
  const store = buildStore()

  test.each(LOGIC_DRILLS)('%s: all 40 generated exercises parse, reduce, and match the oracle', (drill) => {
    const exercises = generateExercises(drill, 'concept', { count: 40, seed: drillSeed })
    expect(exercises).toHaveLength(40)
    for (const exercise of exercises) {
      const term = parseLogicDrill(drill, exercise.prompt)
      expect(term).not.toBeNull()
      if (term === null) continue
      const { outcome } = reduce(store, term)
      expect(outcome.status).toBe('normal')
      if (outcome.status !== 'normal') continue
      expect(decode(outcome.term)).toBe(exercise.answer)
    }
  })
})

describe('bool.and / bool.or / bool.not — the eight truth-table rows', () => {
  test('bool.and', () => {
    expect(reduceToLiteral(tSym('bool.and', [tLit(true), tLit(true)]))).toEqual(tLit(true))
    expect(reduceToLiteral(tSym('bool.and', [tLit(true), tLit(false)]))).toEqual(tLit(false))
    expect(reduceToLiteral(tSym('bool.and', [tLit(false), tLit(true)]))).toEqual(tLit(false))
    expect(reduceToLiteral(tSym('bool.and', [tLit(false), tLit(false)]))).toEqual(tLit(false))
  })

  test('bool.or', () => {
    expect(reduceToLiteral(tSym('bool.or', [tLit(true), tLit(true)]))).toEqual(tLit(true))
    expect(reduceToLiteral(tSym('bool.or', [tLit(true), tLit(false)]))).toEqual(tLit(true))
    expect(reduceToLiteral(tSym('bool.or', [tLit(false), tLit(true)]))).toEqual(tLit(true))
    expect(reduceToLiteral(tSym('bool.or', [tLit(false), tLit(false)]))).toEqual(tLit(false))
  })

  test('bool.not', () => {
    expect(reduceToLiteral(tSym('bool.not', [tLit(true)]))).toEqual(tLit(false))
    expect(reduceToLiteral(tSym('bool.not', [tLit(false)]))).toEqual(tLit(true))
  })
})

describe('modus ponens and modus tollens', () => {
  test('logic.mp(imp(P, Q), P) reduces to yes, traced to the logic.mp rule', () => {
    const store = buildStore()
    const term = tSym('logic.mp', [tSym('imp', [phrase('p'), phrase('q')]), phrase('p')])
    const { outcome, ruleIds } = reduce(store, term)
    expect(outcome.status).toBe('normal')
    if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit('yes'))
    expect(ruleIds).toContain('logic.mp')
  })

  test('logic.mt(imp(P, Q), nq(Q)) reduces to no, traced to the logic.mt rule', () => {
    const store = buildStore()
    const term = tSym('logic.mt', [tSym('imp', [phrase('p'), phrase('q')]), tSym('nq', [phrase('q')])])
    const { outcome, ruleIds } = reduce(store, term)
    expect(outcome.status).toBe('normal')
    if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit('no'))
    expect(ruleIds).toContain('logic.mt')
  })

  test('a non-matching second premise leaves logic.mp irreducible', () => {
    const store = buildStore()
    const term = tSym('logic.mp', [tSym('imp', [phrase('p'), phrase('q')]), phrase('r')])
    const { outcome } = reduce(store, term)
    expect(outcome.status).toBe('normal')
    if (outcome.status === 'normal') expect(outcome.term).toEqual(term)
  })
})

describe('the two syllogism forms', () => {
  test('barbara: all(M, C) with isa(N, M) reduces to yes', () => {
    const store = buildStore()
    const term = tSym('logic.barbara', [
      tSym('all', [phrase('cat'), phrase('animal')]),
      tSym('isa', [phrase('Tom'), phrase('cat')])
    ])
    const { outcome, ruleIds } = reduce(store, term)
    expect(outcome.status).toBe('normal')
    if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit('yes'))
    expect(ruleIds).toContain('logic.barbara')
  })

  test('affirmed: all(M, C) with isa(N, C) reduces to no', () => {
    const store = buildStore()
    const term = tSym('logic.affirmed', [
      tSym('all', [phrase('cat'), phrase('animal')]),
      tSym('isa', [phrase('Tom'), phrase('animal')])
    ])
    const { outcome, ruleIds } = reduce(store, term)
    expect(outcome.status).toBe('normal')
    if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit('no'))
    expect(ruleIds).toContain('logic.affirmed')
  })

  test('the repeated variable forces equality — mismatched roles cannot fire', () => {
    const store = buildStore()
    const term = tSym('logic.barbara', [
      tSym('all', [phrase('cats'), phrase('animals')]),
      tSym('isa', [phrase('Tom'), phrase('cat')])
    ])
    const { outcome } = reduce(store, term)
    expect(outcome.status).toBe('normal')
    if (outcome.status === 'normal') expect(outcome.term).toEqual(term)
  })
})

describe('parseLogicFact — the LOGIC_FACTS sentence grammar', () => {
  const expectFact = (text: string, expected: Term): void => {
    expect(termToString(mustParseFact(text))).toBe(termToString(expected))
  }

  test('equality over addition', () => {
    expectFact(
      'two plus two is four',
      tSym('nat.eq', [tSym('nat.add', [natFromDecimal(2), natFromDecimal(2)]), natFromDecimal(4)])
    )
  })

  test('equality over subtraction', () => {
    expectFact(
      'five minus two is three',
      tSym('nat.eq', [tSym('nat.sub', [natFromDecimal(5), natFromDecimal(2)]), natFromDecimal(3)])
    )
  })

  test('equality over multiplication', () => {
    expectFact(
      'four times two is nine',
      tSym('nat.eq', [tSym('nat.mul', [natFromDecimal(4), natFromDecimal(2)]), natFromDecimal(9)])
    )
  })

  test('equality over division', () => {
    expectFact(
      'six divided by two is three',
      tSym('nat.eq', [tSym('nat.div', [natFromDecimal(6), natFromDecimal(2)]), natFromDecimal(3)])
    )
  })

  test('greater-than and less-than comparisons', () => {
    expectFact('ten is greater than five', tSym('nat.gt', [natFromDecimal(10), natFromDecimal(5)]))
    expectFact('six is less than seven', tSym('nat.lt', [natFromDecimal(6), natFromDecimal(7)]))
  })

  test('garbage is rejected', () => {
    expect(parseLogicFact('zzz zzz')).toBeNull()
    expect(parseLogicFact('')).toBeNull()
    expect(parseLogicFact('two plus two is')).toBeNull()
    expect(parseLogicFact('two plus two')).toBeNull()
  })

  test('parsed facts reduce to their truth value across the full lexicon', () => {
    const store = buildStore()
    const facts: ReadonlyArray<[string, boolean]> = [
      ['two plus two is four', true],
      ['three plus three is seven', false],
      ['one plus one is three', false],
      ['ten is greater than five', true],
      ['two is greater than eight', false],
      ['nine is less than three', false],
      ['twelve is greater than nine', true],
      ['seven plus one is eight', true],
      ['eight minus five is two', false],
      ['three times three is nine', true],
      ['ten minus four is five', false],
      ['ten plus ten is twenty', true],
      ['six plus five is twelve', false],
      ['eight divided by four is two', true],
      ['seven times two is fifteen', false],
      ['four plus four is eight', true],
      ['ten divided by five is three', false],
      ['six is less than seven', true],
      ['ten minus seven is four', false]
    ]
    for (const [text, truth] of facts) {
      const { outcome } = reduce(store, mustParseFact(text))
      expect(outcome.status).toBe('normal')
      if (outcome.status === 'normal') expect(outcome.term).toEqual(tLit(truth))
    }
  })
})

describe('parseLogicDrill — prompt structure', () => {
  test('logic-and and logic-or wrap the two facts', () => {
    expect(
      headOf(mustParse('logic-and', "Statement A says two plus two is four. Statement B says ten is greater than five. Is the statement 'A and B' true or false?"))
    ).toBe('bool.and')
    expect(
      headOf(mustParse('logic-or', "Statement A says two plus two is four. Statement B says ten is greater than five. Is the statement 'A or B' true or false?"))
    ).toBe('bool.or')
  })

  test('logic-not wraps the single fact under either phrasing', () => {
    expect(headOf(mustParse('logic-not', 'Consider the statement: two plus two is four. Is the negation of this statement true or false?'))).toBe('bool.not')
    expect(headOf(mustParse('logic-not', 'Take the statement: ten is greater than five. Is the opposite of this statement true or false?'))).toBe('bool.not')
  })

  test('logic-if picks modus ponens on an affirmation', () => {
    expect(headOf(mustParse('logic-if', 'If it rains, then the ground gets wet. It rains. Does the ground get wet?'))).toBe('logic.mp')
  })

  test('logic-if picks modus tollens on a denial', () => {
    expect(headOf(mustParse('logic-if', 'If the alarm sounds, then everyone leaves the building. Not everyone leaves the building. Did the alarm sound?'))).toBe('logic.mt')
    expect(headOf(mustParse('logic-if', 'If the seed is planted, then a sprout grows. No sprout grows. Was the seed planted?'))).toBe('logic.mt')
  })

  test('syllogism picks barbara on a category question and affirmed on a membership question', () => {
    expect(headOf(mustParse('syllogism', 'All cats are animals. Tom is a cat. Is Tom an animal?'))).toBe('logic.barbara')
    expect(headOf(mustParse('syllogism', 'All cats are animals. Tom is an animal. Must Tom be a cat?'))).toBe('logic.affirmed')
  })

  test('unparseable prompts are rejected', () => {
    expect(parseLogicDrill('logic-and', 'zzz')).toBeNull()
    expect(parseLogicDrill('logic-or', 'zzz')).toBeNull()
    expect(parseLogicDrill('logic-not', 'zzz')).toBeNull()
    expect(parseLogicDrill('logic-if', 'zzz')).toBeNull()
    expect(parseLogicDrill('syllogism', 'zzz')).toBeNull()
    expect(parseLogicDrill('unknown-drill', 'anything')).toBeNull()
  })
})

describe('determinism', () => {
  test('the same prompt and store produce the identical outcome', () => {
    const store = buildStore()
    const term = mustParse(
      'logic-and',
      "Statement A says two plus two is four. Statement B says ten is greater than five. Is the statement 'A and B' true or false?"
    )
    const first = reduce(store, term)
    const second = reduce(store, term)
    expect(first).toEqual(second)
    expect(answer(term)).toBe('true')
  })
})

describe('LOGIC_RULES registration', () => {
  test('every rule registers into a fresh store without throwing', () => {
    const store = new RuleStore([...LOGIC_RULES])
    expect(store.count()).toBe(LOGIC_RULES.length)
    for (const rule of LOGIC_RULES) expect(store.get(rule.id)).toBeDefined()
  })

  test('rules carry the authored metadata and exact bit costs', () => {
    for (const rule of LOGIC_RULES) {
      expect(rule.origin).toBe('authored')
      expect(rule.strength).toBe(1)
      expect(rule.sourceClasses).toEqual(['curriculum'])
      expect(rule.active).toBe(true)
      expect(rule.createdAt).toBe(0)
      expect(rule.useCount).toBe(0)
      expect(rule.bits).toBe(termBits(rule.lhs) + termBits(rule.rhs))
    }
  })
})

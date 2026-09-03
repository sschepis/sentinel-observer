/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { ObserverSession } from '../../observer/engine';
import { OBSERVER_OPTIONS } from '../../observer/options';
import { TeacherAgent } from '../TeacherAgent';
import { ACTIVE_DECK } from '../decks';
import { SCIENCE_CONCEPTS, TECHNICAL_CONCEPTS } from './index';

const SCIENCE_STRANDS = [
  'scientific-practice',
  'physics',
  'chemistry',
  'biology',
  'earth-science',
  'astronomy'
] as const;

describe('the comprehensive science curriculum', () => {
  it('has substantial, prerequisite-ordered coverage in every domain', () => {
    const position = new Map(TECHNICAL_CONCEPTS.map((concept, index) => [concept.word, index]));
    for (const strand of SCIENCE_STRANDS) {
      expect(SCIENCE_CONCEPTS.filter((concept) => concept.strand === strand).length).toBeGreaterThan(20);
    }
    for (const concept of SCIENCE_CONCEPTS) {
      for (const prerequisite of concept.dependsOn) {
        expect(position.get(prerequisite)).toBeLessThan(position.get(concept.word) as number);
      }
    }
  });

  it('replaces stale English senses with authored science definitions', () => {
    const definition = (word: string): string => ACTIVE_DECK.find((entry) => entry.word === word)?.definition ?? '';
    expect(definition('atom')).toContain('smallest unit of an element');
    expect(definition('planet')).toContain('orbiting a star');
    expect(definition('weather')).toContain('short-term conditions');
    expect(definition('evolution')).toContain('inherited characteristics');
  });

  it('answers representative authored relations through the live teacher', async () => {
    const session = new ObserverSession(OBSERVER_OPTIONS, 100);
    await session.initialize();
    const teacher = new TeacherAgent(session, ACTIVE_DECK);
    for (const word of [
      'photosynthesis',
      'kinetic energy',
      'ionic bond',
      'cell',
      'cell membrane',
      'earth system',
      'atmosphere',
      'red giant',
      'star',
      'light year',
      'unit',
      'classical mechanics',
      'heat',
      'entropy',
      'second law of thermodynamics',
      'photon',
      'quantum mechanics',
      'wave particle duality',
      'electron',
      'relativity',
      'speed of light'
    ]) {
      teacher.teach(word);
    }

    const questions = [
      'is kinetic energy an energy',
      'is an ionic bond a chemical bond',
      'does a cell have a cell membrane',
      'does the earth system have an atmosphere',
      'is a red giant a star',
      'is a light year a unit',
      'is classical mechanics a physics',
      'is quantum mechanics a physics',
      'is the second law of thermodynamics a scientific law',
      'is the first law of thermodynamics a scientific law',
      'is thermal energy an energy',
      'is thermal radiation an electromagnetic wave',
      'is a quark a particle',
      'is relativity a physics'
    ];
    for (const question of questions) {
      const answer = teacher.chatAnswer(question);
      expect(answer.mode).toBe('operator');
      if (answer.mode === 'operator') expect(answer.response).toMatch(/^Yes/);
    }
    const definition = teacher.chatAnswer('what is photosynthesis');
    expect(definition.mode).toBe('operator');
    if (definition.mode === 'operator') expect(definition.response).toContain('light energy');
    const speed = teacher.chatAnswer('what is the speed of light');
    expect(speed.mode).toBe('operator');
    if (speed.mode === 'operator') expect(speed.response).toContain('300 million meters');
    session.dispose();
  }, 30000);
});

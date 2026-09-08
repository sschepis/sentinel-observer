/**
 * @jest-environment node
 *
 * Dialogue and passage adapters (src/curriculum/text.ts): the deck-shape
 * filter on multi-turn dialogue, and the reader-shape filter on prose.
 */
import { describe, it, expect } from '@jest/globals';
import { articleLead, cueFromTurn, pairsFromDialogue, passageFrom } from './text';
import { readText } from '../teacher/reading';

describe('dialogue → deck pairs', () => {
  it('cuts a dialogue into short single-turn (cue, response) pairs in the cue grammar', () => {
    const pairs = pairsFromDialogue(
      [
        'Say , Jim , how about going for a few beers after dinner ?',
        'You know that is tempting but is really not good for our fitness .',
        'What do you mean ? It will help us to relax .',
        "Do you really think so ? I don't . It will just make us fat and act silly .",
        'How was your weekend ?',
        'It was great . I went hiking with my sister .',
        'I suggest a walk over to the gym .',
        'That is a good idea .'
      ],
      'dailydialog'
    );
    // Only turns that are ONE sentence and reply-complete survive.
    for (const pair of pairs) {
      expect(pair.cue).toMatch(/^[a-z][a-z0-9 ,'?!.-]*$/);
      expect(pair.cue.split(' ').length).toBeLessThanOrEqual(12);
      expect(pair.response).toMatch(/[.!?]$/);
      expect(pair.source).toBe('dailydialog');
    }
    expect(pairs.map((p) => p.cue)).toEqual(['how was your weekend?', 'i suggest a walk over to the gym']);
    expect(pairs[0].response).toBe('It was great. I went hiking with my sister.');
    // A name ("Jim"), a two-sentence cue and a 13-word turn are refused.
    expect(pairs.some((p) => p.cue.includes('jim'))).toBe(false);
    expect(pairs.some((p) => p.cue.startsWith('what do you mean'))).toBe(false);
  });

  it('cueFromTurn keeps ? and !, drops the period, refuses long or out-of-grammar turns', () => {
    expect(cueFromTurn('How are you ?')).toBe('how are you?');
    expect(cueFromTurn('That is a good idea .')).toBe('that is a good idea');
    expect(cueFromTurn('Well I think that on balance we should probably consider the other option first tonight')).toBeNull();
    expect(cueFromTurn('¿Qué tal?')).toBe('qu tal?');
  });
});

describe('prose → passages', () => {
  it('cuts a wiki article to its lead, strips markup and parentheticals, and refuses list-shaped text', () => {
    const article = `Zeus (Greek: Ζεύς) is the king of the gods in [[Greek mythology|Greek myths]]. He is the god of the sky and thunder. {{Infobox deity}}\n\n== Family ==\nZeus married Hera.`;
    expect(articleLead(article)).toBe('Zeus is the king of the gods in Greek myths. He is the god of the sky and thunder.');
    const passage = passageFrom('Zeus', article, 'simplewiki', { lead: true });
    expect(passage?.text).toBe('Zeus is the king of the gods in Greek myths. He is the god of the sky and thunder.');
    expect(passageFrom('List', '| 1 | 2 | 3 |\n| 4 | 5 | 6 |', 'simplewiki')).toBeNull();
    expect(passageFrom('Short', 'One sentence only.', 'tinystories')).toBeNull();
  });

  it('bounds a long passage at a sentence end', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} says a plain thing about a robin.`).join(' ');
    const passage = passageFrom('story', long, 'tinystories');
    expect(passage).not.toBeNull();
    expect(passage!.text.length).toBeLessThanOrEqual(1600);
    expect(passage!.text).toMatch(/\.$/);
  });

  it('a Simple-Wikipedia-shaped lead yields claims the reader can hold; a story yields fewer', () => {
    const vocabulary = new Set(['god', 'king', 'sky', 'thunder', 'bird', 'animal', 'wing', 'feather', 'girl', 'park', 'ball']);
    const wiki = readText('The Greeks worshipped the god Zeus. Zeus is a god. Zeus is the king of the sky. Zeus has thunder.', { vocabulary, source: 'test' });
    expect(wiki.relations.length).toBeGreaterThanOrEqual(2);
    const story = readText('Lily went to the park. She saw a ball. She was happy and ran home.', { vocabulary, source: 'test' });
    expect(story.relations.length).toBeLessThan(wiki.relations.length);
  });
});

/**
 * DOMAIN DECKS — the specialized sub-networks.
 *
 * The council is a network of observers, each the expert of a domain. A
 * domain is defined by ANCHOR WORDS: a deck word belongs to a domain when
 * its WordNet definition (or the word itself) contains one of the domain's
 * anchors. Deterministic given the deck — the same word list every run —
 * which is what makes the council bench reproducible.
 */
import { ACTIVE_DECK } from './decks';
import type { DeckWord } from './deck';

export type DomainName = 'nature' | 'daily' | 'mind';

export const DOMAIN_ANCHORS: Record<DomainName, readonly string[]> = {
  nature: [
    'animal', 'bird', 'fish', 'plant', 'tree', 'flower', 'leaf', 'root', 'seed',
    'water', 'sea', 'river', 'lake', 'ocean', 'mountain', 'hill', 'forest',
    'sky', 'weather', 'sun', 'moon', 'star', 'storm', 'rain', 'snow', 'wind',
    'cloud', 'stone', 'soil', 'wing', 'feather', 'insect', 'mammal', 'reptile',
    'wild', 'grow', 'nest', 'claw', 'beak', 'fur'
  ],
  daily: [
    'house', 'home', 'kitchen', 'food', 'bread', 'milk', 'cheese', 'chair',
    'table', 'bed', 'room', 'door', 'window', 'car', 'road', 'street', 'city',
    'village', 'clothes', 'shirt', 'shoe', 'hat', 'coat', 'cook', 'meal',
    'drink', 'cup', 'plate', 'knife', 'fork', 'work', 'job', 'store', 'shop',
    'buy', 'sell', 'money', 'family', 'friend', 'child', 'baby'
  ],
  mind: [
    'thought', 'mind', 'idea', 'feeling', 'emotion', 'word', 'language',
    'speech', 'write', 'read', 'know', 'believe', 'understand', 'memory',
    'remember', 'learn', 'teach', 'dream', 'hope', 'wish', 'fear', 'love',
    'hate', 'question', 'answer', 'story', 'book', 'music', 'song', 'hear',
    'listen', 'speak', 'say', 'tell', 'name', 'meaning', 'imagine', 'reason'
  ]
};

const ANCHOR_RE: Record<DomainName, RegExp> = {
  nature: new RegExp(`\\b(${DOMAIN_ANCHORS.nature.join('|')})\\b`, 'i'),
  daily: new RegExp(`\\b(${DOMAIN_ANCHORS.daily.join('|')})\\b`, 'i'),
  mind: new RegExp(`\\b(${DOMAIN_ANCHORS.mind.join('|')})\\b`, 'i')
};

/** The deck, split into deterministic domain decks (frequency order, capped). */
export function domainDecks(cap = 2000): Record<DomainName, DeckWord[]> {
  const decks: Record<DomainName, DeckWord[]> = { nature: [], daily: [], mind: [] };
  const counts: Record<DomainName, number> = { nature: 0, daily: 0, mind: 0 };
  for (const entry of ACTIVE_DECK) {
    const definition = entry.definition.toLowerCase();
    for (const domain of Object.keys(ANCHOR_RE) as DomainName[]) {
      if (counts[domain] >= cap) continue;
      if (ANCHOR_RE[domain].test(definition) || ANCHOR_RE[domain].test(entry.word)) {
        decks[domain].push(entry);
        counts[domain] += 1;
      }
    }
  }
  return decks;
}
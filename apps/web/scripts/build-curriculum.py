#!/usr/bin/env python3.10
"""
BUILD CURRICULUM — select a reading corpus from Simple English Wikipedia.

Two selectors, both aimed at the sentence shape the observer's claim grammar
can READ and SAY:

  1. TITLE SEEDS — curated subjects (Zeus, Ancient Rome, Iliad, ...).
  2. OPENING-SENTENCE PATTERNS — Simple Wikipedia articles open with a
     definition ("Zeus is a god in Greek mythology", "Nero was a Roman
     emperor"), so an article whose FIRST sentence names a subject-matter
     kind is on-topic by construction.

Output: corpus/<subject>/<slug>.txt, one article per file, section headings
and reference tails stripped.

Source: wikimedia/wikipedia 20231101.simple (CC BY-SA 4.0) via Hugging Face.
"""
import os
import re
import sys
import pyarrow.parquet as pq

PARQUET = sys.argv[1] if len(sys.argv) > 1 else '/tmp/hf/simple.parquet'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/corpus'
PER_SUBJECT = int(os.environ.get('PER_SUBJECT', '400'))

TITLE_SEEDS = {
    'mythology': ['Zeus', 'Hera', 'Poseidon', 'Athena', 'Apollo', 'Artemis', 'Ares', 'Hermes',
                  'Hades', 'Heracles', 'Odin', 'Thor', 'Loki', 'Anubis', 'Osiris', 'Isis',
                  'Greek mythology', 'Norse mythology', 'Egyptian mythology', 'Dragon',
                  'Centaur', 'Minotaur', 'Phoenix (mythology)', 'Titan (mythology)'],
    'history': ['Ancient Rome', 'Roman Empire', 'Ancient Egypt', 'Ancient Greece', 'Julius Caesar',
                'Cleopatra VII', 'Alexander the Great', 'Pyramid', 'Great Wall of China', 'Castle',
                'Knight', 'Viking', 'Samurai', 'Silk Road', 'Middle Ages', 'Renaissance',
                'Pharaoh', 'Colosseum', 'Sparta', 'Athens', 'Byzantine Empire', 'Crusades'],
    'literature': ['Homer', 'Iliad', 'Odyssey', 'William Shakespeare', 'Hamlet', 'Macbeth',
                   'Romeo and Juliet', 'Novel', 'Poetry', 'Epic poetry', 'Fable', 'Aesop',
                   'Myth', 'Tragedy', 'Comedy', 'Book', 'Author', 'Poet', 'Playwright', 'Library'],
}

# An opening sentence naming one of these kinds puts the article on-topic.
OPENING_PATTERNS = {
    'mythology': re.compile(
        r'\b(?:is|was)\s+(?:a|an|the)\s+[^.]{0,60}?\b('
        r'god|goddess|deity|myth|mythology|mythical|legendary creature|hero of|titan|demigod'
        r')\b', re.I),
    'history': re.compile(
        r'\b(?:is|was)\s+(?:a|an|the)\s+[^.]{0,60}?\b('
        r'emperor|empire|pharaoh|dynasty|kingdom|civilization|civilisation|ancient city|'
        r'roman general|roman politician|battle|war fought|revolution|treaty'
        r')\b', re.I),
    'literature': re.compile(
        r'\b(?:is|was)\s+(?:a|an|the)\s+[^.]{0,60}?\b('
        r'poem|epic poem|play written|tragedy written|novel|novelist|poet|playwright|'
        r'writer|author|work of literature|literary'
        r')\b', re.I),
}

SECTION_TAIL = re.compile(
    r'\n==\s*(?:References|Other websites|Related pages|Sources|Notes|Further reading|External links|Bibliography)\s*==',
    re.I)


def clean(text: str) -> str:
    body = SECTION_TAIL.split(text)[0]
    body = re.sub(r'^==+.*?==+$', '', body, flags=re.M)      # headings
    body = re.sub(r'\([^)]*[^\x00-\x7F][^)]*\)', '', body)    # non-Latin parentheticals
    body = re.sub(r'\[[^\]]*\]', '', body)                    # bracket notes
    body = re.sub(r'[^\x00-\x7F]+', ' ', body)                # stray non-ASCII
    body = re.sub(r'[ \t]+', ' ', body)
    lines = [ln.strip() for ln in body.split('\n')]
    return '\n'.join(ln for ln in lines if len(ln) > 60)


def slug(title: str) -> str:
    return re.sub(r'^-|-$', '', re.sub(r'[^a-z0-9]+', '-', title.lower()))


def main() -> None:
    table = pq.read_table(PARQUET, columns=['title', 'text'])
    titles = table.column('title').to_pylist()
    texts = table.column('text').to_pylist()
    print(f'scanning {len(titles)} articles')

    seed_lookup = {}
    for subject, seeds in TITLE_SEEDS.items():
        for seed in seeds:
            seed_lookup.setdefault(seed.lower(), subject)

    chosen: dict[str, list[tuple[str, str]]] = {s: [] for s in TITLE_SEEDS}
    for title, text in zip(titles, texts):
        if not text:
            continue
        subject = seed_lookup.get(title.lower())
        if subject is None:
            opening = text[:400]
            for candidate, pattern in OPENING_PATTERNS.items():
                if len(chosen[candidate]) >= PER_SUBJECT:
                    continue
                if pattern.search(opening):
                    subject = candidate
                    break
        if subject is None:
            continue
        if len(chosen[subject]) >= PER_SUBJECT and title.lower() not in seed_lookup:
            continue
        body = clean(text)
        if len(body) < 300:
            continue
        chosen[subject].append((title, body))

    total_words = 0
    for subject, articles in chosen.items():
        directory = os.path.join(OUT, subject)
        os.makedirs(directory, exist_ok=True)
        for title, body in articles:
            with open(os.path.join(directory, f'{slug(title)}.txt'), 'w') as handle:
                handle.write(body + '\n')
            total_words += len(body.split())
        print(f'  {subject:11s} {len(articles):4d} articles')
    print(f'\n{sum(len(a) for a in chosen.values())} files, {total_words} words -> {OUT}/')
    print('Source: wikimedia/wikipedia 20231101.simple (CC BY-SA 4.0)')


if __name__ == '__main__':
    main()

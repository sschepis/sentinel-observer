#!/usr/bin/env node
/**
 * FETCH CURRICULUM — build a reading corpus for the observer.
 *
 * Pulls plain-text article extracts from Simple English Wikipedia (CC BY-SA)
 * across a curated set of subjects and writes them as .txt files the reader
 * can ingest. Simple English is deliberate: its prose is declarative
 * ("Zeus is a god", "Rome was a city"), which is the sentence shape the
 * observer's claim grammar can both READ and SAY. Narrative literature
 * yields almost nothing to that grammar — the corpus is chosen to match
 * what the observer can honestly learn, not to look impressive.
 *
 * Usage:
 *   npm run fetch-curriculum                    # all subjects -> corpus/
 *   npm run fetch-curriculum -- --topic myth    # one subject only
 *   npm run fetch-curriculum -- --out /tmp/x    # elsewhere
 *
 * Attribution: article text is CC BY-SA 4.0, from simple.wikipedia.org.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SUBJECTS: Record<string, string[]> = {
  mythology: [
    'Zeus', 'Hera', 'Poseidon', 'Athena', 'Apollo', 'Artemis', 'Ares', 'Hermes', 'Hades',
    'Heracles', 'Odin', 'Thor', 'Loki', 'Ra (mythology)', 'Anubis', 'Osiris',
    'Phoenix (mythology)', 'Dragon', 'Centaur', 'Minotaur', 'Greek mythology', 'Norse mythology'
  ],
  history: [
    'Ancient Rome', 'Roman Empire', 'Ancient Egypt', 'Ancient Greece', 'Julius Caesar',
    'Cleopatra VII', 'Alexander the Great', 'Pyramid', 'Great Wall of China', 'Castle',
    'Knight', 'Viking', 'Samurai', 'Silk Road', 'Middle Ages', 'Renaissance',
    'Pharaoh', 'Colosseum', 'Sparta', 'Athens'
  ],
  literature: [
    'Homer', 'Iliad', 'Odyssey', 'William Shakespeare', 'Hamlet', 'Romeo and Juliet',
    'Novel', 'Poetry', 'Epic poetry', 'Fable', 'Aesop', 'Myth', 'Tragedy', 'Comedy',
    'Library', 'Book', 'Author', 'Story'
  ]
}

const API = 'https://simple.wikipedia.org/w/api.php'

const flag = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

/**
 * Strip the apparatus an encyclopedia carries and the observer cannot use:
 * section headings, reference/see-also tails, pronunciation parentheticals
 * and non-Latin script. What remains is prose sentences.
 */
function clean(extract: string): string {
  const body = extract.split(/\n==\s*(?:References|Other websites|Related pages|Sources|Notes|Further reading|External links)\s*==/i)[0]
  return body
    .replace(/^==+.*?==+$/gm, '')                       // section headings
    .replace(/\([^)]*[^\x00-\x7F][^)]*\)/g, '')          // parentheticals with non-Latin script
    .replace(/\[[^\]]*\]/g, '')                          // bracketed notes
    .replace(/[^\x00-\x7F]+/g, ' ')                      // stray non-ASCII
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 40)                  // drop stubs and captions
    .join('\n')
}

/** Fetch extracts with backoff. The extracts API truncates multi-title
 *  requests, so titles are pulled one at a time with a polite delay. */
async function fetchBatch(titles: readonly string[], attempt = 0): Promise<Map<string, string>> {
  const url =
    `${API}?action=query&prop=extracts&explaintext=1&format=json&redirects=1` +
    `&titles=${encodeURIComponent(titles.join('|'))}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'sentient-observer/curriculum (local research; contact: local user)' }
  })
  const body = await response.text()
  if (!response.ok || body.startsWith('You are making too many requests')) {
    if (attempt >= 6) {
      console.log('  … still rate limited; skipping this title (re-run to resume)')
      return new Map()
    }
    const wait = 3000 * Math.pow(2, attempt)
    console.log(`  … rate limited, waiting ${wait / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, wait))
    return fetchBatch(titles, attempt + 1)
  }
  const data = JSON.parse(body) as {
    query?: { pages?: Record<string, { title?: string; extract?: string }> }
  }
  const out = new Map<string, string>()
  for (const page of Object.values(data.query?.pages ?? {})) {
    const extract = page.extract
    if (page.title === undefined || extract === undefined || extract.trim().length === 0) continue
    const cleaned = clean(extract)
    if (cleaned.length > 200) out.set(page.title, cleaned)
  }
  return out
}

const slug = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function main(): Promise<void> {
  const out = flag('out') ?? 'corpus'
  const only = flag('topic')
  const subjects = only === null ? Object.keys(SUBJECTS) : [only]

  let files = 0
  let words = 0
  for (const subject of subjects) {
    const titles = SUBJECTS[subject]
    if (titles === undefined) {
      console.error(`unknown subject "${subject}" (have: ${Object.keys(SUBJECTS).join(', ')})`)
      process.exit(1)
    }
    const directory = join(out, subject)
    mkdirSync(directory, { recursive: true })
    for (let i = 0; i < titles.length; i += 1) {
      const batch = titles.slice(i, i + 1)
      // Resume-friendly: an already-fetched article is never re-requested.
      if (existsSync(join(directory, `${slug(batch[0])}.txt`))) {
        console.log(`  have  ${subject}/${slug(batch[0])}.txt`)
        continue
      }
      const extracts = await fetchBatch(batch)
      for (const [title, text] of extracts) {
        writeFileSync(join(directory, `${slug(title)}.txt`), `${text}\n`)
        const count = text.split(/\s+/).length
        files += 1
        words += count
        console.log(`  ok    ${subject}/${slug(title)}.txt (${count} words)`)
      }
      for (const title of batch) {
        if (![...extracts.keys()].some((got) => slug(got) === slug(title))) {
          console.log(`  skip  ${subject}/${title} (no usable extract)`)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 4000))
    }
  }
  console.log(`\n${files} files, ${words} words -> ${out}/`)
  console.log('Text: Simple English Wikipedia, CC BY-SA 4.0.')
}

main().catch((reason) => {
  console.error(reason)
  process.exit(1)
})

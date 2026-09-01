#!/usr/bin/env python3
"""
Attach WordNet definitions + examples to the 20k frequency deck, with a
curated fallback dictionary for closed-class words WordNet lacks (articles,
pronouns, prepositions, conjunctions, auxiliaries).

Output: src/teacher/decks/en-20000.ts with definitions embedded.
Run from apps/web with the venv's OWN interpreter (its site-packages then
sits behind the standard library on sys.path — no path manipulation needed):
    python scripts/.venv/bin/python scripts/enrich-20000.py
"""
import json
import os
import re
import sys
from pathlib import Path


def _load_wn():
    """Import the `wn` module from the enrichment venv.

    Preferred: run the script with the venv's own interpreter, which places
    its site-packages on sys.path BEHIND the standard library automatically.
    Fallback: locate a venv under this repo or the user's home and APPEND
    its site-packages — never prepend — so stdlib always wins and a
    predictable world-writable location can never be planted ahead of it.
    """
    try:
        import wn
        return wn
    except ImportError:
        pass
    here = Path(__file__).resolve().parent
    trustedRoots = (str(here), str(Path.home()))
    venvRoots = [here / '.venv', Path.home() / '.venvs' / 'wnenv']
    for root in venvRoots:
        lib = root / 'lib'
        if not lib.is_dir():
            continue
        sitePackages = sorted(lib.glob('python*/site-packages'))
        if not sitePackages:
            continue
        site = sitePackages[0].resolve()
        if not str(site).startswith(trustedRoots):
            continue  # refuse a site-packages outside the repo and the user's home
        if os.stat(site).st_mode & 0o002:
            continue  # refuse a world-writable site-packages
        sys.path.append(str(site))
        try:
            import wn
            return wn
        except ImportError:
            sys.path.pop()
    raise SystemExit(
        'cannot import wn: run with the enrichment venv interpreter, e.g. '
        'python scripts/.venv/bin/python scripts/enrich-20000.py from apps/web'
    )


wn = _load_wn()

wnen = wn.Wordnet('oewn:2024')
DECK = '/Users/sschepis/Development/sentient-observer/apps/web/src/teacher/decks/en-20000.ts'

# Curated definitions for closed-class words absent from WordNet. These are
# the highest-frequency words in English — they must not be missing.
FUNCTION_WORDS = {
    'the': ('used before a noun to mean a specific person or thing', 'The sun is shining.'),
    'a': ('used before a noun to mean one person or thing, not a specific one', 'I saw a cat.'),
    'an': ('used before a vowel sound to mean one person or thing', 'She ate an apple.'),
    'of': ('showing that something belongs to or comes from something else', 'The color of the sky.'),
    'to': ('in the direction of; used before a verb', 'I am going to school.'),
    'and': ('joining two words or ideas together', 'Bread and butter.'),
    'for': ('showing purpose, reason, or time', 'This gift is for you.'),
    'in': ('inside a place or time', 'She is in the room.'),
    'on': ('touching a surface; happening at a time', 'The book is on the table.'),
    'with': ('together or using something', 'I go with my friend.'),
    'at': ('showing a place or time', 'We met at noon.'),
    'by': ('next to; done through someone', 'The house by the lake.'),
    'you': ('the person or people being spoken to', 'You are my friend.'),
    'i': ('the person who is speaking', 'I like apples.'),
    'he': ('a male person already mentioned', 'He is my brother.'),
    'she': ('a female person already mentioned', 'She is my sister.'),
    'it': ('a thing, animal, or idea already mentioned', 'It is raining.'),
    'we': ('the speaker and other people', 'We are learning.'),
    'they': ('people or things already mentioned', 'They are here.'),
    'me': ('the person speaking, as the object', 'Give it to me.'),
    'him': ('a male person, as the object', 'I saw him.'),
    'her': ('a female person or belonging to her', 'I called her; her book.'),
    'us': ('the speaker and others, as the object', 'Come with us.'),
    'them': ('people or things, as the object', 'I know them.'),
    'my': ('belonging to me', 'This is my pen.'),
    'your': ('belonging to you', 'Is this your coat?'),
    'his': ('belonging to him', 'That is his car.'),
    'its': ('belonging to it', 'The dog wagged its tail.'),
    'our': ('belonging to us', 'Our house is big.'),
    'their': ('belonging to them', 'Their garden is lovely.'),
    'mine': ('something belonging to me', 'The blue one is mine.'),
    'yours': ('something belonging to you', 'The choice is yours.'),
    'hers': ('something belonging to her', 'That seat is hers.'),
    'ours': ('something belonging to us', 'The victory is ours.'),
    'theirs': ('something belonging to them', 'The fault is theirs.'),
    'this': ('the thing here or now', 'This is my desk.'),
    'that': ('the thing there or already known', 'That is far away.'),
    'these': ('more than one thing here', 'These are my shoes.'),
    'those': ('more than one thing there', 'Those are your books.'),
    'who': ('asking or saying which person', 'Who is calling?'),
    'whom': ('which person, as an object', 'To whom should I speak?'),
    'whose': ('belonging to which person', 'Whose bag is this?'),
    'which': ('asking about one in a group', 'Which one do you want?'),
    'what': ('asking about a thing or idea', 'What is your name?'),
    'where': ('asking or saying a place', 'Where do you live?'),
    'when': ('asking or saying a time', 'When will you come?'),
    'why': ('asking or saying a reason', 'Why are you late?'),
    'how': ('asking about a way or manner', 'How are you?'),
    'but': ('showing a contrast', 'I am small but strong.'),
    'or': ('showing a choice between two things', 'Tea or coffee?'),
    'so': ('for that reason; to this degree', 'It was late, so I slept.'),
    'if': ('showing a condition', 'If it rains, we stay home.'),
    'because': ('for the reason that', 'I stayed because it was fun.'),
    'while': ('during the time that', 'She sang while she worked.'),
    'although': ('despite the fact that', 'Although tired, he smiled.'),
    'though': ('despite the fact that', 'It is small though strong.'),
    'unless': ('except if', 'We leave unless you stop.'),
    'until': ('up to a time', 'Wait until I return.'),
    'whether': ('if it is true or not', 'I asked whether he agreed.'),
    'nor': ('and not', 'Neither tea nor coffee.'),
    'yet': ('up to now; but still', 'It is early yet.'),
    'not': ('making a word or sentence negative', 'I am not ready.'),
    'no': ('not any; saying something is not so', 'No milk is left.'),
    'none': ('not any of them', 'None of us knew.'),
    'yes': ('saying something is so; agreement', 'Yes, I will come.'),
    'very': ('to a great degree', 'It is very hot.'),
    'just': ('only; exactly; a short time ago', 'I just arrived.'),
    'only': ('with nothing more; just', 'I want only water.'),
    'also': ('in addition', 'I also like tea.'),
    'too': ('also; more than enough', 'I want some too.'),
    'then': ('at that time; next', 'First rest, then go.'),
    'here': ('in or to this place', 'Come here.'),
    'there': ('in or to that place', 'The book is there.'),
    'now': ('at this time', 'We are leaving now.'),
    'today': ('this day', 'Today is sunny.'),
    'tomorrow': ('the day after today', 'See you tomorrow.'),
    'yesterday': ('the day before today', 'It rained yesterday.'),
    'always': ('at all times', 'She always smiles.'),
    'never': ('not at any time', 'He never lies.'),
    'often': ('many times', 'We often walk.'),
    'sometimes': ('at some times but not always', 'It sometimes snows.'),
    'usually': ('in most cases', 'I usually wake early.'),
    'again': ('one more time', 'Say it again.'),
    'already': ('before now or earlier than expected', 'He already left.'),
    'still': ('continuing up to now', 'She is still asleep.'),
    'ago': ('before now', 'Two days ago.'),
    'soon': ('in a short time', 'Dinner is soon.'),
    'late': ('after the expected time', 'The train was late.'),
    'early': ('before the expected time', 'We eat breakfast early.'),
    'soon': ('in a short time from now', 'I will be back soon.'),
    'away': ('to another place; not here', 'He walked away.'),
    'back': ('to or at an earlier place or time', 'Come back home.'),
    'out': ('away from inside', 'She went out.'),
    'up': ('toward a higher place', 'Look up at the sky.'),
    'down': ('toward a lower place', 'Sit down.'),
    'off': ('away from a surface or place', 'The cat jumped off.'),
    'be': ('to exist; to have a quality; the verb of being', 'Be kind.'),
    'am': ('the form of be used with I', 'I am happy.'),
    'is': ('the form of be for one person or thing', 'She is kind.'),
    'are': ('the form of be for you or many', 'They are ready.'),
    'was': ('the past form of be for one', 'He was tired.'),
    'were': ('the past form of be for many', 'We were young.'),
    'been': ('the past participle of be', 'I have been there.'),
    'being': ('existing; the quality of existing', 'A living being.'),
    'do': ('to perform an action; used for questions', 'Do your work.'),
    'does': ('the form of do for one person', 'She does her best.'),
    'did': ('the past form of do', 'I did my homework.'),
    'done': ('finished; the past participle of do', 'The work is done.'),
    'have': ('to own or hold', 'I have a book.'),
    'has': ('the form of have for one person', 'He has a car.'),
    'had': ('the past form of have', 'She had a dream.'),
    'having': ('owning; the act of owning', 'Having a plan helps.'),
    'will': ('used for the future; a wish', 'I will go tomorrow.'),
    'would': ('used for possible or polite actions', 'Would you help me?'),
    'shall': ('used for the future with I and we', 'We shall see.'),
    'should': ('used to say what is right or expected', 'You should rest.'),
    'can': ('to be able to; allowed to', 'I can swim.'),
    'could': ('was able to; possible', 'I could run fast.'),
    'may': ('possible; allowed', 'May I come in?'),
    'might': ('perhaps; possible but not sure', 'It might rain.'),
    'must': ('have to; certain', 'You must eat well.'),
    'ought': ('should', 'You ought to try.'),
    'some': ('an amount of; a few', 'Some bread, please.'),
    'any': ('one or some, no matter which', 'Do you have any water?'),
    'each': ('every one separately', 'Each child got a gift.'),
    'every': ('all of a group', 'Every day is new.'),
    'all': ('the whole of; every one', 'All are welcome.'),
    'both': ('the two together', 'Both hands are full.'),
    'few': ('a small number', 'A few birds sang.'),
    'many': ('a large number', 'Many people came.'),
    'much': ('a large amount', 'Much time passed.'),
    'several': ('more than two, but not many', 'Several friends arrived.'),
    'enough': ('as much as needed', 'We have enough food.'),
    'another': ('one more; a different one', 'Another cup, please.'),
    'other': ('a different person or thing', 'The other shoe is lost.'),
    'else': ('in addition; different', 'Who else is coming?'),
    'even': ('still more; including surprising cases', 'Even I can do it.'),
    'ever': ('at any time', 'Have you ever seen it?'),
    'without': ('not with; lacking', 'Tea without sugar.'),
    'within': ('inside; during', 'Within the hour.'),
    'across': ('from one side to the other', 'Walk across the bridge.'),
    'along': ('following the length of', 'Walk along the road.'),
    'among': ('in the middle of a group', 'A star among fans.'),
    'around': ('on all sides; near', 'A fence around the yard.'),
    'before': ('earlier than', 'Wash before dinner.'),
    'behind': ('at the back of', 'Behind the door.'),
    'below': ('lower than', 'Below the surface.'),
    'beneath': ('under', 'Beneath the tree.'),
    'beside': ('next to', 'Sit beside me.'),
    'beyond': ('further than', 'Beyond the hills.'),
    'despite': ('even though', 'Despite the rain, we played.'),
    'during': ('through the time of', 'During the lesson.'),
    'except': ('not including', 'All except me.'),
    'inside': ('in the inner part', 'Inside the box.'),
    'near': ('close to', 'Near the river.'),
    'outside': ('in the outer part', 'Outside the house.'),
    'past': ('beyond; after', 'Walk past the store.'),
    'since': ('from a time until now', 'Since Monday.'),
    'toward': ('in the direction of', 'Toward the sun.'),
    'upon': ('on; up to', 'Once upon a time.'),
    'after': ('following in time or place', 'After school.'),
    'oh': ('an exclamation of surprise or feeling', 'Oh, I see!'),
    'ah': ('an exclamation of understanding or joy', 'Ah, now I know!'),
    'hey': ('a greeting or call for attention', 'Hey, look here!'),
    'hi': ('a friendly greeting', 'Hi, how are you?'),
    'hello': ('a greeting when meeting someone', 'Hello, nice to see you.'),
    'okay': ('acceptable; agreement', 'Okay, let us go.'),
    'well': ('in a good way; a pause word', 'She sings well.'),
    'wow': ('an exclamation of wonder', 'Wow, that is big!'),
    'please': ('a polite word when asking', 'Please sit down.'),
    'thanks': ('a polite word for gratitude', 'Thanks for your help.'),
    'thank': ('to say you are grateful', 'I thank you.'),
    'sorry': ('feeling bad for a mistake', 'I am sorry.'),
    'goodbye': ('a word said when leaving', 'Goodbye, see you soon.'),
    'bye': ('a short form of goodbye', 'Bye, take care.'),
    'instead': ('in place of something else', 'Have tea instead.'),
    'maybe': ('perhaps', 'Maybe it will snow.'),
    'perhaps': ('possibly', 'Perhaps you are right.'),
    'together': ('with each other; in one group', 'We eat together.'),
    'alone': ('without others', 'He lives alone.'),
    'however': ('but; in spite of that', 'However, it was useful.'),
    'therefore': ('for that reason', 'It rained, therefore we stayed.'),
    'though': ('despite that', 'It was hard though worth it.'),
    'quite': ('to a fair degree; very', 'Quite good work.'),
    'enough': ('sufficient', 'That is enough.'),
    'such': ('of that kind', 'Such a nice day.'),
    'own': ('belonging to oneself', 'My own room.'),
    'sure': ('certain; without doubt', 'I am sure it works.'),
    'almost': ('nearly', 'Almost done.'),
    'about': ('on the subject of; around', 'A story about a cat.'),
    'above': ('higher than', 'Above the clouds.'),
    'against': ('opposing; touching', 'Lean against the wall.'),
    'into': ('to the inside of', 'Jump into the pool.'),
    'onto': ('to the top of', 'Climb onto the roof.'),
    'through': ('from one side to the other', 'Through the tunnel.'),
    'under': ('below', 'Under the table.'),
    'over': ('above; across', 'Over the bridge.'),
    'between': ('in the space separating two', 'Between the trees.'),
    'yeah': ('a casual yes', 'Yeah, that sounds good.'),
    'from': ('showing a starting place, time, or source', 'I am from New York.'),
    'than': ('used to compare two things', 'She is taller than me.'),
    'per': ('for each', 'Once per week.'),
    'something': ('an unknown or unnamed thing', 'I heard something outside.'),
    'anything': ('any thing at all', 'Ask me anything.'),
    'someone': ('an unknown person', 'Someone is at the door.'),
    'anyone': ('any person at all', 'Anyone can learn.'),
    'everyone': ('all people', 'Everyone is welcome.'),
    'everybody': ('all people', 'Everybody laughed.'),
    'nobody': ('no person', 'Nobody answered.'),
    'everything': ('all things', 'Everything is ready.'),
    'nothing': ('not anything', 'Nothing was missing.'),
    'somebody': ('an unknown person', 'Somebody called you.'),
    'everywhere': ('in all places', 'Sand was everywhere.'),
    'somewhere': ('in an unknown place', 'It is somewhere here.'),
    'anywhere': ('in any place', 'Sit anywhere you like.'),
    'nowhere': ('in no place', 'The key is nowhere.'),
    'whoever': ('any person who', 'Whoever comes first wins.'),
    'whatever': ('any thing that; no matter what', 'Take whatever you need.'),
    'whenever': ('at any time that', 'Come whenever you can.'),
    'wherever': ('in any place that', 'I will go wherever you go.'),
    'whichever': ('any one that', 'Pick whichever you like.'),
    'himself': ('the male person himself (reflexive)', 'He did it himself.'),
    'herself': ('the female person herself (reflexive)', 'She made it herself.'),
    'myself': ('the speaker himself/herself (reflexive)', 'I washed myself.'),
    'yourself': ('the person you (reflexive)', 'Help yourself.'),
    'ourselves': ('we, as the object of our own action', 'We taught ourselves.'),
    'themselves': ('they, as the object of their own action', 'They enjoyed themselves.'),
    'itself': ('it, as the object of its own action', 'The door opened itself.'),
    'oneself': ('any person, as the object of one\'s own action', 'One must care for oneself.'),
    'doesnt': ('does not', 'It doesn\'t matter.'),
    'didnt': ('did not', 'I didn\'t see it.'),
    'couldnt': ('could not', 'I couldn\'t come.'),
    'via': ('by way of', 'Travel via London.'),
    'ok': ('acceptable; good', 'Everything is ok.'),
}

def lookup(word):
    """Best-effort WordNet definition + example for a content word."""
    try:
        for sense in wnen.synsets(word):
            definition = sense.definition()
            if not definition:
                continue
            examples = sense.examples()
            example = examples[0] if examples else ''
            return definition, example
    except Exception:
        pass
    return None

# Irregular inflections WordNet does not index as forms.
IRREGULAR = {
    'women': 'woman', 'men': 'man', 'children': 'child', 'mice': 'mouse',
    'feet': 'foot', 'teeth': 'tooth', 'geese': 'goose', 'lice': 'louse',
    'people': 'person', 'oxen': 'ox', 'cacti': 'cactus', 'been': 'be',
    'went': 'go', 'better': 'good', 'best': 'good', 'worst': 'bad',
    'worse': 'bad', 'further': 'far', 'furthest': 'far',
    'bought': 'buy', 'brought': 'bring', 'thought': 'think',
    'caught': 'catch', 'taught': 'teach', 'sought': 'seek', 'fought': 'fight',
    'made': 'make', 'had': 'have', 'did': 'do', 'done': 'do', 'said': 'say',
    'told': 'tell', 'gave': 'give', 'given': 'give', 'got': 'get',
    'gotten': 'get', 'found': 'find', 'heard': 'hear', 'held': 'hold',
    'kept': 'keep', 'left': 'leave', 'lost': 'lose', 'met': 'meet',
    'paid': 'pay', 'put': 'put', 'ran': 'run', 'saw': 'see', 'seen': 'see',
    'sent': 'send', 'sold': 'sell', 'slept': 'sleep', 'spoke': 'speak',
    'spoken': 'speak', 'stood': 'stand', 'took': 'take', 'taken': 'take',
    'wrote': 'write', 'written': 'write', 'won': 'win', 'ate': 'eat',
    'eaten': 'eat', 'drank': 'drink', 'drunk': 'drink', 'drove': 'drive',
    'driven': 'drive', 'flew': 'fly', 'flown': 'fly', 'knew': 'know',
    'known': 'know', 'lay': 'lie', 'led': 'lead', 'rode': 'ride',
    'ridden': 'ride', 'rose': 'rise', 'risen': 'rise', 'sang': 'sing',
    'sung': 'sing', 'swam': 'swim', 'swum': 'swim', 'threw': 'throw',
    'thrown': 'throw', 'wore': 'wear', 'worn': 'wear', 'broke': 'break',
    'broken': 'break', 'chose': 'choose', 'chosen': 'choose', 'froze': 'freeze',
    'frozen': 'freeze', 'stole': 'steal', 'stolen': 'steal', 'woke': 'wake',
    'woken': 'wake', 'forgot': 'forget', 'forgotten': 'forget',
    'became': 'become', 'began': 'begin', 'begun': 'begin', 'blew': 'blow',
    'blew': 'blow', 'grew': 'grow', 'grown': 'grow', 'knew': 'know',
    'meant': 'mean', 'read': 'read', 'felt': 'feel', 'built': 'build',
    'cut': 'cut', 'hit': 'hit', 'hurt': 'hurt', 'let': 'let',
    'set': 'set', 'spent': 'spend', 'stood': 'stand', 'understood': 'understand',
}

def lemmatize(word):
    """Rule-based English lemmatization (oewn ships no lemmatizer). Returns
    candidate base forms; the caller tries each against WordNet."""
    if word in IRREGULAR:
        return [IRREGULAR[word]]
    candidates = [word]
    # -ies -> -y
    if word.endswith('ies') and len(word) > 4:
        candidates.append(word[:-3] + 'y')
    # -es -> drop es (boxes->box, includes->include, does->do)
    if word.endswith('es') and len(word) > 3:
        candidates.append(word[:-2])
    # -s -> drop s
    if word.endswith('s') and len(word) > 3:
        candidates.append(word[:-1])
    # -ed -> drop ed / -ied -> -y / doubled consonant
    if word.endswith('ed') and len(word) > 4:
        base = word[:-2]
        candidates.append(base)
        candidates.append(base + 'e')
        if base.endswith('i'):
            candidates.append(base[:-1] + 'y')
        if len(base) >= 3 and base[-1] == base[-2]:
            candidates.append(base[:-1])
    # -ing -> drop ing / +e / doubled consonant
    if word.endswith('ing') and len(word) > 4:
        base = word[:-3]
        candidates.append(base)
        candidates.append(base + 'e')
        if len(base) >= 3 and base[-1] == base[-2]:
            candidates.append(base[:-1])
    # -er/-est
    if word.endswith('er') and len(word) > 4:
        candidates.append(word[:-2])
    if word.endswith('est') and len(word) > 4:
        candidates.append(word[:-3])
    # dedupe, keep order
    seen = set()
    return [c for c in candidates if not (c in seen or seen.add(c))]

def main():
    src = open(DECK).read()
    words = re.findall(r'word: "([a-z]+)"', src)
    enriched = {}
    stats = {'wordnet': 0, 'function': 0, 'missing': 0}
    for w in words:
        # Curated closed-class words WIN: WordNet's rare senses (e.g. 'a' as
        # a unit of length) would poison a learner dictionary.
        if w in FUNCTION_WORDS:
            enriched[w] = FUNCTION_WORDS[w]
            stats['function'] += 1
            continue
        result = lookup(w)
        if not result:
            for base in lemmatize(w):
                if base == w:
                    continue
                result = lookup(base)
                if result:
                    break
        if result:
            enriched[w] = result
            stats['wordnet'] += 1
            continue
        stats['missing'] += 1

    rows = []
    for w in words:
        definition, example = enriched.get(w, ('', ''))
        rows.append(f"  {{ word: {json.dumps(w)}, definition: {json.dumps(definition)}, example: {json.dumps(example)} }},")

    template = """/**
 * The 20,000-word frequency deck: the most common English words by corpus
 * frequency (Norvig's public-domain count_1w list, filtered to plain A-Z
 * words — {total} unique). Definitions and examples are generated from
 * WordNet (Open English WordNet) plus a curated fallback dictionary for
 * closed-class function words; the Chaperone can fill any remaining gaps.
 */

export const DECK_20000: ReadonlyArray<{{ word: string; definition: string; example: string }}> = [
{rows}
];
"""
    open(DECK, 'w').write(template.format(total=len(words), rows='\n'.join(rows)))
    total = len(words)
    covered = stats['wordnet'] + stats['function']
    print(f'words: {total}')
    print(f'wordnet: {stats["wordnet"]} ({stats["wordnet"]/total*100:.1f}%)')
    print(f'function-word fallback: {stats["function"]} ({stats["function"]/total*100:.1f}%)')
    print(f'covered: {covered} ({covered/total*100:.1f}%)')
    print(f'missing (Chaperone can fill): {stats["missing"]} ({stats["missing"]/total*100:.1f}%)')

if __name__ == '__main__':
    main()
/**
 * THE NARRATIVE CORPUS — multi-sentence stories for temporal ordering and
 * multi-trace binding.
 *
 * Nothing in the current curriculum exercises recall ACROSS traces: word
 * lessons and conversation pairs are each a single trace, cued and recalled
 * alone. A story is different — teaching stores EACH SENTENCE as its own
 * trace, and the questions cue recall across them: "who", "what", "where",
 * "when", and "why" answers live in different sentences, so answering
 * requires binding several traces around one narrative.
 *
 * Every answer is a literal word or phrase that appears verbatim in some
 * sentence of its story (exact-match gradable — no inference required), so
 * the grading loop stays as honest as word recall: either the observer
 * produced the stored phrase or it did not.
 */

export interface NarrativeStory {
  /** A short title naming the story. */
  title: string;
  /** Three to five short learner-English sentences told in order. */
  sentences: readonly string[];
  /** Questions whose answers appear verbatim in the sentences above. */
  questions: readonly { question: string; answer: string }[];
}

export const NARRATIVE_CORPUS: readonly NarrativeStory[] = [
  {
    title: 'The Lost Key',
    sentences: [
      'Anna lost her key in the park on Monday.',
      'She looked under the big tree near the gate.',
      'A kind boy found the key in the grass.',
      'Anna thanked the boy and walked home happy.'
    ],
    questions: [
      { question: 'Who lost her key?', answer: 'Anna' },
      { question: 'Where did Anna lose her key?', answer: 'in the park' },
      { question: 'When did Anna lose her key?', answer: 'on Monday' },
      { question: 'Who found the key?', answer: 'a kind boy' }
    ]
  },
  {
    title: 'The Red Bicycle',
    sentences: [
      'Tom bought a red bicycle in the spring.',
      'He rode it to school every morning.',
      'One day the front wheel broke on the hill.',
      'His father fixed the wheel in the evening.'
    ],
    questions: [
      { question: 'What did Tom buy?', answer: 'a red bicycle' },
      { question: 'When did Tom buy the bicycle?', answer: 'in the spring' },
      { question: 'What broke on the hill?', answer: 'the front wheel' },
      { question: 'Who fixed the wheel?', answer: 'his father' }
    ]
  },
  {
    title: 'The Rainy Market',
    sentences: [
      'Maria went to the market on Saturday.',
      'She wanted to buy apples and bread.',
      'It started to rain, so she opened her umbrella.',
      'She came home with a full basket.'
    ],
    questions: [
      { question: 'Who went to the market?', answer: 'Maria' },
      { question: 'When did Maria go to the market?', answer: 'on Saturday' },
      { question: 'What did Maria want to buy?', answer: 'apples and bread' },
      { question: 'What did Maria open when it rained?', answer: 'her umbrella' }
    ]
  },
  {
    title: 'The Small Garden',
    sentences: [
      'Ben planted seeds in his small garden.',
      'He watered them every day after school.',
      'In the summer, yellow flowers grew tall.',
      'Ben gave some flowers to his mother.'
    ],
    questions: [
      { question: 'What did Ben plant?', answer: 'seeds' },
      { question: 'When did Ben water the seeds?', answer: 'every day after school' },
      { question: 'What grew tall in the summer?', answer: 'yellow flowers' },
      { question: 'Who did Ben give some flowers to?', answer: 'his mother' }
    ]
  },
  {
    title: 'The Night Train',
    sentences: [
      'Sara took the night train to the city.',
      'She read a book about the ocean.',
      'The train arrived at the station at sunrise.',
      'Her uncle met her with a warm smile.'
    ],
    questions: [
      { question: 'Who took the night train?', answer: 'Sara' },
      { question: 'What did Sara read about?', answer: 'the ocean' },
      { question: 'When did the train arrive?', answer: 'at sunrise' },
      { question: 'Who met Sara at the station?', answer: 'her uncle' }
    ]
  },
  {
    title: 'The Hungry Cat',
    sentences: [
      'A gray cat sat by the kitchen door.',
      'It was hungry because it had not eaten all day.',
      'Emma gave the cat a bowl of milk.',
      'The cat drank the milk and slept in the sun.'
    ],
    questions: [
      { question: 'Where did the gray cat sit?', answer: 'by the kitchen door' },
      { question: 'Why was the cat hungry?', answer: 'it had not eaten all day' },
      { question: 'Who gave the cat a bowl of milk?', answer: 'Emma' },
      { question: 'Where did the cat sleep?', answer: 'in the sun' }
    ]
  },
  {
    title: 'The School Play',
    sentences: [
      'The class practiced a play about a king.',
      'David wore a gold paper crown.',
      'The play was in the school hall on Friday.',
      'Everyone clapped at the end.'
    ],
    questions: [
      { question: 'What was the play about?', answer: 'a king' },
      { question: 'What did David wear?', answer: 'a gold paper crown' },
      { question: 'Where was the play?', answer: 'in the school hall' },
      { question: 'When was the play?', answer: 'on Friday' }
    ]
  },
  {
    title: 'The Winter Bird',
    sentences: [
      'A small bird stayed in the cold garden all winter.',
      'Lena put seeds on the window each morning.',
      'The bird came to the window to eat.',
      'In the spring, the bird sang outside her room.'
    ],
    questions: [
      { question: 'Where did the small bird stay?', answer: 'in the cold garden' },
      { question: 'Who put seeds on the window?', answer: 'Lena' },
      { question: 'Why did the bird come to the window?', answer: 'to eat' },
      { question: 'When did the bird sing outside her room?', answer: 'in the spring' }
    ]
  },
  {
    title: 'The Broken Clock',
    sentences: [
      'The old clock in the hall stopped at noon.',
      'Grandfather opened it with a small tool.',
      'He found a bent wheel inside.',
      'The clock rang again at dinner time.'
    ],
    questions: [
      { question: 'When did the old clock stop?', answer: 'at noon' },
      { question: 'Who opened the clock?', answer: 'grandfather' },
      { question: 'What did grandfather find inside?', answer: 'a bent wheel' },
      { question: 'When did the clock ring again?', answer: 'at dinner time' }
    ]
  },
  {
    title: 'The Long Walk',
    sentences: [
      'Two friends walked to the lake in the afternoon.',
      'They carried water and a map.',
      'They rested under a tall pine tree.',
      'They reached the lake before dark and made a small fire.'
    ],
    questions: [
      { question: 'Where did the two friends walk?', answer: 'to the lake' },
      { question: 'What did they carry?', answer: 'water and a map' },
      { question: 'Where did they rest?', answer: 'under a tall pine tree' },
      { question: 'When did they reach the lake?', answer: 'before dark' }
    ]
  },
  {
    title: 'The New Neighbor',
    sentences: [
      'A new family moved into the blue house in June.',
      'Their daughter was named Rosa.',
      'Rosa shared her toys with the children next door.',
      'Soon they all played together in the yard.'
    ],
    questions: [
      { question: 'When did the new family move in?', answer: 'in June' },
      { question: 'Where did the new family move?', answer: 'into the blue house' },
      { question: 'What was the daughter named?', answer: 'Rosa' },
      { question: 'Where did they all play together?', answer: 'in the yard' }
    ]
  },
  {
    title: 'The Bread Shop',
    sentences: [
      'Mr. Lee opened his bread shop early in the morning.',
      'The smell of warm bread filled the street.',
      'A long line formed before eight.',
      'By noon, every loaf was sold.'
    ],
    questions: [
      { question: 'Who opened the bread shop?', answer: 'Mr. Lee' },
      { question: 'What filled the street?', answer: 'the smell of warm bread' },
      { question: 'When did a long line form?', answer: 'before eight' },
      { question: 'When was every loaf sold?', answer: 'by noon' }
    ]
  },
  {
    title: 'The Lost Dog',
    sentences: [
      'A brown dog ran away from the farm on Tuesday.',
      'It followed the river for many hours.',
      'A fisherman saw the dog near the bridge.',
      'He brought the dog back to the farm at night.'
    ],
    questions: [
      { question: 'When did the brown dog run away?', answer: 'on Tuesday' },
      { question: 'What did the dog follow?', answer: 'the river' },
      { question: 'Who saw the dog near the bridge?', answer: 'a fisherman' },
      { question: 'When did he bring the dog back?', answer: 'at night' }
    ]
  },
  {
    title: 'The Music Lesson',
    sentences: [
      'Nina practiced the piano every evening.',
      'Her teacher gave her a new song on Wednesday.',
      'The song was hard, so she played it slowly.',
      'After two weeks, she played it without a mistake.'
    ],
    questions: [
      { question: 'What did Nina practice?', answer: 'the piano' },
      { question: 'When did her teacher give her a new song?', answer: 'on Wednesday' },
      { question: 'Why did she play it slowly?', answer: 'the song was hard' },
      { question: 'When did she play it without a mistake?', answer: 'after two weeks' }
    ]
  },
  {
    title: 'The Paper Boat',
    sentences: [
      'Leo made a paper boat after the rain.',
      'He put the boat in the stream by the road.',
      'The boat floated past the stone bridge.',
      'It landed on the far bank, and Leo cheered.'
    ],
    questions: [
      { question: 'Who made a paper boat?', answer: 'Leo' },
      { question: 'When did Leo make the boat?', answer: 'after the rain' },
      { question: 'Where did he put the boat?', answer: 'in the stream' },
      { question: 'What did the boat float past?', answer: 'the stone bridge' }
    ]
  }
];

/** The whole story as one text: its sentences joined with spaces. */
export function storyText(story: NarrativeStory): string {
  return story.sentences.join(' ');
}

import type { DeckWord } from '../deck';
import { tokenizeText } from '../context';

/**
 * P13 semantic-recall corpus: comprehension cues for PRODUCTION recall.
 *
 * Each entry pairs a concrete high-frequency word with a plain learner-English
 * definition, a short example sentence, and exactly three hand-authored
 * paraphrases of the meaning. HARD CONSTRAINT: no paraphrase contains the
 * target word or any obvious inflection of it — every cue is comprehension,
 * never identity lookup. Paraphrases deliberately REUSE the definition's
 * content words (the comprehension path is content-overlap driven) while
 * varying the surface syntax ("a X that Y", "the thing you use to Y",
 * "what you call a Y that Z").
 *
 * Used for train/eval of the content-overlap comprehension path
 * (paraphrase -> word top-1), extending the tiny inline deck in
 * semanticRecall.test.ts to corpus scale. All content is hand-curated
 * (no licensing constraints).
 */
export interface ParaphraseEntry {
  /** The target word the paraphrases should recall. */
  word: string;
  /** Plain learner-English definition, phrased as a noun phrase. */
  definition: string;
  /** Short example sentence using the word. */
  example: string;
  /** Exactly three rephrased meanings, none containing the word. */
  paraphrases: readonly string[];
}

export const PARAPHRASE_CORPUS: readonly ParaphraseEntry[] = [
  // ---- Animals ----
  {
    word: 'cat',
    definition: 'a small furry animal that says meow and chases mice',
    example: 'The cat sleeps on the sofa.',
    paraphrases: [
      'a small furry pet that says meow',
      'the animal people keep that chases mice and purrs',
      'what you call a furry animal that meows'
    ]
  },
  {
    word: 'dog',
    definition: 'a common animal with four legs that barks and people keep as a pet',
    example: 'The dog barks at the door.',
    paraphrases: [
      'a four-legged pet animal that barks',
      'the loyal animal people keep that barks',
      'what you call a common pet with four legs that barks'
    ]
  },
  {
    word: 'bird',
    definition: 'a creature with wings and feathers that can fly and sing',
    example: 'A bird sings in the tree.',
    paraphrases: [
      'a flying creature covered in feathers',
      'the animal with wings that can fly and sing',
      'what you call a feathered creature that flies'
    ]
  },
  {
    word: 'fish',
    definition: 'an animal that lives in water and swims with fins',
    example: 'A fish swims in the pond.',
    paraphrases: [
      'an animal with fins that swims in water',
      'the creature that lives in water and swims',
      'what you call a swimming animal with fins'
    ]
  },
  {
    word: 'horse',
    definition: 'a large animal with a mane that people ride',
    example: 'The horse runs across the field.',
    paraphrases: [
      'a large animal people ride',
      'the big animal with a mane you can ride',
      'what you call a large riding animal with a mane'
    ]
  },
  {
    word: 'cow',
    definition: 'a large farm animal that gives milk and says moo',
    example: 'The cow eats grass in the field.',
    paraphrases: [
      'a big farm animal that gives milk',
      'the farm animal that says moo and gives milk',
      'what you call a large animal on a farm that gives milk'
    ]
  },
  {
    word: 'pig',
    definition: 'a pink farm animal with a curly tail that says oink',
    example: 'The pig rolls in the mud.',
    paraphrases: [
      'a pink farm animal with a curly tail',
      'the farm animal that says oink and loves mud',
      'what you call a pink animal with a curly tail on a farm'
    ]
  },
  {
    word: 'sheep',
    definition: 'a farm animal covered in wool that says baa',
    example: 'The sheep grazes on the hill.',
    paraphrases: [
      'a farm animal covered in wool',
      'the woolly animal that says baa',
      'what you call a wool-covered animal on a farm'
    ]
  },
  {
    word: 'goat',
    definition: 'a farm animal with horns that climbs and eats almost anything',
    example: 'The goat climbs on the rocks.',
    paraphrases: [
      'a horned farm animal that climbs rocks',
      'the farm animal with horns that eats almost anything',
      'what you call a climbing animal with horns on a farm'
    ]
  },
  {
    word: 'rabbit',
    definition: 'a small animal with long ears that hops and eats carrots',
    example: 'The rabbit hops across the grass.',
    paraphrases: [
      'a small animal with long ears that hops',
      'the hopping animal that loves carrots',
      'what you call a long-eared animal that hops'
    ]
  },
  {
    word: 'mouse',
    definition: 'a tiny grey animal with a long tail that squeaks',
    example: 'A mouse hides in the wall.',
    paraphrases: [
      'a tiny grey animal that squeaks',
      'the small animal with a long tail that squeaks',
      'what you call a tiny squeaking animal with a long tail'
    ]
  },
  {
    word: 'lion',
    definition: 'a large wild cat with a mane that roars',
    example: 'The lion roars in the grass.',
    paraphrases: [
      'a big wild cat with a mane',
      'the wild cat that roars and has a mane',
      'what you call a large roaring cat with a mane'
    ]
  },
  {
    word: 'tiger',
    definition: 'a large wild cat with orange fur and black stripes',
    example: 'The tiger walks through the jungle.',
    paraphrases: [
      'a big wild cat with orange fur and stripes',
      'the striped wild cat with orange fur',
      'what you call a large cat with black stripes and orange fur'
    ]
  },
  {
    word: 'elephant',
    definition: 'a huge grey animal with a long trunk and big ears',
    example: 'The elephant sprays water with its trunk.',
    paraphrases: [
      'a huge grey animal with a trunk',
      'the biggest land animal with a long trunk and big ears',
      'what you call a huge animal that has a trunk'
    ]
  },
  {
    word: 'monkey',
    definition: 'a clever animal with a long tail that climbs trees and eats bananas',
    example: 'The monkey swings from the branch.',
    paraphrases: [
      'a clever animal that climbs trees and eats bananas',
      'the long-tailed animal that swings in trees',
      'what you call a clever tree-climbing animal with a long tail'
    ]
  },
  {
    word: 'bear',
    definition: 'a big strong wild animal with thick fur that loves honey',
    example: 'The bear sleeps all winter.',
    paraphrases: [
      'a big strong animal with thick fur that loves honey',
      'the wild furry animal that sleeps all winter',
      'what you call a strong wild animal with thick fur'
    ]
  },
  {
    word: 'wolf',
    definition: 'a wild animal like a big dog that howls and hunts in packs',
    example: 'A wolf howls at the moon.',
    paraphrases: [
      'a wild animal like a big dog that howls',
      'the animal that hunts in packs and howls at the moon',
      'what you call a howling wild animal that hunts in packs'
    ]
  },
  {
    word: 'fox',
    definition: 'a small wild animal with red fur and a bushy tail',
    example: 'The fox sneaks through the bushes.',
    paraphrases: [
      'a small wild animal with red fur',
      'the clever animal with a bushy tail and red fur',
      'what you call a red-furred wild animal with a bushy tail'
    ]
  },
  {
    word: 'deer',
    definition: 'a gentle forest animal with long thin legs and antlers',
    example: 'A deer stands at the edge of the forest.',
    paraphrases: [
      'a gentle forest animal with antlers',
      'the shy animal with long thin legs that lives in the forest',
      'what you call a gentle animal with antlers in the forest'
    ]
  },
  {
    word: 'frog',
    definition: 'a small green animal that jumps and lives near water',
    example: 'The frog jumps into the pond.',
    paraphrases: [
      'a small green animal that jumps near water',
      'the green jumping animal that lives by the pond',
      'what you call a green animal that jumps and croaks'
    ]
  },
  {
    word: 'snake',
    definition: 'a long thin animal with no legs that slides on the ground',
    example: 'The snake slides through the grass.',
    paraphrases: [
      'a long thin animal with no legs',
      'the animal that slides on the ground without legs',
      'what you call a long legless animal that slides'
    ]
  },
  {
    word: 'spider',
    definition: 'a small creature with eight legs that spins webs',
    example: 'A spider spins a web in the corner.',
    paraphrases: [
      'a small creature with eight legs',
      'the eight-legged creature that spins webs',
      'what you call a creature that spins webs with eight legs'
    ]
  },
  {
    word: 'bee',
    definition: 'a small striped insect that makes honey and buzzes',
    example: 'A bee lands on the flower.',
    paraphrases: [
      'a small striped insect that makes honey',
      'the buzzing insect that makes honey from flowers',
      'what you call a striped buzzing insect that makes honey'
    ]
  },
  {
    word: 'ant',
    definition: 'a tiny insect that works hard and lives in a big group',
    example: 'An ant carries a crumb.',
    paraphrases: [
      'a tiny insect that works hard in a big group',
      'the small hard-working insect that lives in a group',
      'what you call a tiny insect that carries food to its group'
    ]
  },
  {
    word: 'duck',
    definition: 'a water bird with a flat beak that swims and quacks',
    example: 'The duck swims on the lake.',
    paraphrases: [
      'a water bird with a flat beak that quacks',
      'the swimming bird that quacks',
      'what you call a bird with a flat beak that swims on lakes'
    ]
  },
  // ---- Food ----
  {
    word: 'apple',
    definition: 'a round red or green fruit that grows on trees',
    example: 'I eat an apple every morning.',
    paraphrases: [
      'a round fruit that is red or green',
      'the crunchy fruit that grows on trees, red or green',
      'what you call a round tree fruit that can be red or green'
    ]
  },
  {
    word: 'banana',
    definition: 'a long curved yellow fruit with a soft inside',
    example: 'The monkey eats a banana.',
    paraphrases: [
      'a long curved fruit that is yellow',
      'the yellow fruit you peel that is soft inside',
      'what you call a curved yellow fruit with a peel'
    ]
  },
  {
    word: 'orange',
    definition: 'a round juicy fruit with a thick peel and sweet juice',
    example: 'She peels an orange for breakfast.',
    paraphrases: [
      'a round juicy fruit with a thick peel',
      'the fruit full of sweet juice that you peel',
      'what you call a round fruit with a thick peel and lots of juice'
    ]
  },
  {
    word: 'grape',
    definition: 'a small round fruit that grows in bunches on a vine',
    example: 'I picked a grape from the bunch.',
    paraphrases: [
      'a small round fruit that grows in bunches',
      'the tiny fruit from a vine that grows in a bunch',
      'what you call a small round vine fruit in a bunch'
    ]
  },
  {
    word: 'lemon',
    definition: 'a sour yellow fruit used for juice and flavor',
    example: 'She squeezes a lemon into the tea.',
    paraphrases: [
      'a sour yellow fruit you squeeze for juice',
      'the yellow fruit with very sour juice',
      'what you call a sour fruit that is yellow'
    ]
  },
  {
    word: 'bread',
    definition: 'a soft baked food made from flour that you slice',
    example: 'We eat bread with butter.',
    paraphrases: [
      'a soft baked food made from flour',
      'the baked food you slice for sandwiches',
      'what you call a baked flour food that you slice'
    ]
  },
  {
    word: 'cheese',
    definition: 'a solid yellow or white food made from milk',
    example: 'The mouse loves cheese.',
    paraphrases: [
      'a solid food made from milk',
      'the yellow or white milk food you put on sandwiches',
      'what you call a solid milk food that can be yellow or white'
    ]
  },
  {
    word: 'butter',
    definition: 'a soft yellow food made from cream that you spread on bread',
    example: 'Spread butter on the toast.',
    paraphrases: [
      'a soft yellow food you spread on bread',
      'the yellow spread made from cream',
      'what you call a soft cream food spread on toast'
    ]
  },
  {
    word: 'egg',
    definition: 'an oval food with a shell that comes from a hen',
    example: 'I boil an egg for breakfast.',
    paraphrases: [
      'an oval food with a shell from a hen',
      'the breakfast food a hen lays',
      'what you call an oval shelled food from a hen'
    ]
  },
  {
    word: 'milk',
    definition: 'a white drink that comes from a cow',
    example: 'The baby drinks warm milk.',
    paraphrases: [
      'a white drink from a cow',
      'the white liquid a cow gives that people drink',
      'what you call a white drink that comes from cows'
    ]
  },
  {
    word: 'rice',
    definition: 'small white grains that people cook and eat',
    example: 'We eat rice with dinner.',
    paraphrases: [
      'small white grains people cook',
      'the tiny white grains cooked as food',
      'what you call small white grains eaten with dinner'
    ]
  },
  {
    word: 'soup',
    definition: 'a hot liquid food made with vegetables or meat',
    example: 'She makes soup on cold days.',
    paraphrases: [
      'a hot liquid food with vegetables or meat',
      'the warm liquid food you eat with a spoon',
      'what you call a hot food that is liquid and eaten with a spoon'
    ]
  },
  {
    word: 'cake',
    definition: 'a sweet baked food eaten at birthdays and parties',
    example: 'We eat cake at the party.',
    paraphrases: [
      'a sweet baked food for birthdays',
      'the sweet treat with candles at a birthday party',
      'what you call a sweet baked party food'
    ]
  },
  {
    word: 'honey',
    definition: 'a sweet golden liquid that bees make',
    example: 'Bears love sweet honey.',
    paraphrases: [
      'a sweet golden liquid made by bees',
      'the golden sweet food from a beehive',
      'what you call a sweet sticky liquid that bees make'
    ]
  },
  {
    word: 'sugar',
    definition: 'small white sweet grains added to food and drinks',
    example: 'He puts sugar in his tea.',
    paraphrases: [
      'small white sweet grains for food and drinks',
      'the sweet white grains you stir into tea',
      'what you call sweet grains added to drinks'
    ]
  },
  {
    word: 'salt',
    definition: 'small white grains with a strong taste added to food',
    example: 'Add a little salt to the soup.',
    paraphrases: [
      'small white grains with a strong taste',
      'the white grains from the sea you shake on food',
      'what you call white grains that make food taste stronger'
    ]
  },
  {
    word: 'meat',
    definition: 'food that comes from the body of an animal',
    example: 'The lion eats meat.',
    paraphrases: [
      'food from the body of an animal',
      'the animal food that lions and wolves eat',
      'what you call food that comes from animals'
    ]
  },
  {
    word: 'chicken',
    definition: 'a farm bird that lays eggs and is eaten as food',
    example: 'We cook chicken for dinner.',
    paraphrases: [
      'a farm bird that lays eggs',
      'the bird from the farm that people cook for dinner',
      'what you call a farm bird eaten as food'
    ]
  },
  {
    word: 'potato',
    definition: 'a brown vegetable that grows under the ground',
    example: 'She boils a potato for lunch.',
    paraphrases: [
      'a brown vegetable that grows under the ground',
      'the vegetable dug from under the ground for fries',
      'what you call an underground brown vegetable'
    ]
  },
  {
    word: 'tomato',
    definition: 'a soft round red vegetable used in salads and sauce',
    example: 'Slice a tomato for the salad.',
    paraphrases: [
      'a soft round red vegetable for salads',
      'the red vegetable used in sauce and salads',
      'what you call a soft red vegetable in a salad'
    ]
  },
  {
    word: 'carrot',
    definition: 'a long orange vegetable that rabbits love',
    example: 'The rabbit eats a carrot.',
    paraphrases: [
      'a long orange vegetable rabbits love',
      'the orange vegetable that grows under the ground and rabbits eat',
      'what you call a long crunchy orange vegetable'
    ]
  },
  {
    word: 'onion',
    definition: 'a round vegetable with strong layers that makes you cry',
    example: 'Chopping an onion makes me cry.',
    paraphrases: [
      'a round vegetable with layers that makes you cry',
      'the strong vegetable that brings tears when you chop it',
      'what you call a layered vegetable that makes people cry'
    ]
  },
  {
    word: 'tea',
    definition: 'a hot drink made from dried leaves in water',
    example: 'She drinks tea in the afternoon.',
    paraphrases: [
      'a hot drink made from dried leaves',
      'the warm drink you make by putting leaves in hot water',
      'what you call a hot leaf drink'
    ]
  },
  {
    word: 'coffee',
    definition: 'a hot dark drink made from roasted beans that wakes you up',
    example: 'He drinks coffee every morning.',
    paraphrases: [
      'a hot dark drink made from roasted beans',
      'the dark morning drink that wakes you up',
      'what you call a hot bean drink people have in the morning'
    ]
  },
  {
    word: 'juice',
    definition: 'a sweet drink made by squeezing fruit',
    example: 'I drink orange juice at breakfast.',
    paraphrases: [
      'a sweet drink made by squeezing fruit',
      'the drink you get when you squeeze a fruit',
      'what you call a sweet fruit drink'
    ]
  },
  // ---- Household objects ----
  {
    word: 'table',
    definition: 'a flat piece of furniture with legs where you eat and work',
    example: 'Dinner is on the table.',
    paraphrases: [
      'a flat piece of furniture with legs for eating',
      'the furniture you sit at to eat and work',
      'what you call flat furniture with legs where meals are served'
    ]
  },
  {
    word: 'chair',
    definition: 'a piece of furniture with a back that one person sits on',
    example: 'Please sit on the chair.',
    paraphrases: [
      'a piece of furniture one person sits on',
      'the seat with a back and four legs',
      'what you call furniture with a back made for sitting'
    ]
  },
  {
    word: 'bed',
    definition: 'a soft piece of furniture where you sleep at night',
    example: 'I go to bed at ten.',
    paraphrases: [
      'a soft piece of furniture for sleeping',
      'the furniture you lie on to sleep at night',
      'what you call the soft place where you sleep'
    ]
  },
  {
    word: 'door',
    definition: 'a flat piece that swings open so you can enter a room',
    example: 'Please close the door.',
    paraphrases: [
      'a flat piece that swings open to enter a room',
      'the thing you open to walk into a room',
      'what you call the swinging piece you knock on to enter'
    ]
  },
  {
    word: 'window',
    definition: 'an opening with glass in a wall that lets in light',
    example: 'Open the window for fresh air.',
    paraphrases: [
      'an opening with glass that lets in light',
      'the glass part of a wall you look through',
      'what you call a glass opening in a wall'
    ]
  },
  {
    word: 'lamp',
    definition: 'an object with a bulb that gives light in a room',
    example: 'Turn on the lamp to read.',
    paraphrases: [
      'an object with a bulb that gives light',
      'the thing you switch on for light in a room',
      'what you call an object that lights a room with a bulb'
    ]
  },
  {
    word: 'mirror',
    definition: 'a piece of glass that shows your reflection',
    example: 'She looks in the mirror.',
    paraphrases: [
      'a piece of glass that shows your reflection',
      'the glass you look into to see your own face',
      'what you call glass that reflects your face'
    ]
  },
  {
    word: 'clock',
    definition: 'an object with hands or numbers that shows the time',
    example: 'The clock says it is noon.',
    paraphrases: [
      'an object with hands that shows the time',
      'the thing on the wall you check to know the time',
      'what you call an object with numbers that tells the time'
    ]
  },
  {
    word: 'spoon',
    definition: 'a small tool with a round end used to eat soup',
    example: 'Stir the tea with a spoon.',
    paraphrases: [
      'a small tool with a round end for eating soup',
      'the round-ended tool you stir and eat soup with',
      'what you call the eating tool with a round end'
    ]
  },
  {
    word: 'fork',
    definition: 'a small eating tool with sharp points for picking up food',
    example: 'Eat the salad with a fork.',
    paraphrases: [
      'a small eating tool with sharp points',
      'the pointed tool you pick up food with',
      'what you call an eating tool with points for picking up food'
    ]
  },
  {
    word: 'knife',
    definition: 'a sharp tool with a blade used to cut food',
    example: 'Cut the bread with a knife.',
    paraphrases: [
      'a sharp tool with a blade for cutting food',
      'the bladed tool you cut bread with',
      'what you call a sharp blade tool for cutting'
    ]
  },
  {
    word: 'plate',
    definition: 'a flat round dish that food is served on',
    example: 'Put the food on the plate.',
    paraphrases: [
      'a flat round dish for serving food',
      'the round dish your dinner is served on',
      'what you call a flat dish that holds your food'
    ]
  },
  {
    word: 'cup',
    definition: 'a small container with a handle used for drinking tea',
    example: 'She fills the cup with tea.',
    paraphrases: [
      'a small container with a handle for drinking',
      'the container you drink tea from',
      'what you call a small drinking container with a handle'
    ]
  },
  {
    word: 'bowl',
    definition: 'a deep round dish used for soup and cereal',
    example: 'Pour the soup into a bowl.',
    paraphrases: [
      'a deep round dish for soup and cereal',
      'the deep dish you eat cereal from',
      'what you call a deep dish that holds soup'
    ]
  },
  {
    word: 'bottle',
    definition: 'a tall container with a narrow neck that holds liquid',
    example: 'The bottle is full of water.',
    paraphrases: [
      'a tall container with a narrow neck for liquid',
      'the container with a narrow neck you pour water from',
      'what you call a narrow-necked container that holds liquid'
    ]
  },
  {
    word: 'towel',
    definition: 'a soft cloth used to dry your body after washing',
    example: 'Dry your hands with a towel.',
    paraphrases: [
      'a soft cloth for drying your body',
      'the cloth you dry yourself with after a bath',
      'what you call a soft drying cloth'
    ]
  },
  {
    word: 'pillow',
    definition: 'a soft cushion you rest your head on in bed',
    example: 'She sleeps with a soft pillow.',
    paraphrases: [
      'a soft cushion for your head in bed',
      'the cushion you rest your head on to sleep',
      'what you call a soft head cushion on a bed'
    ]
  },
  {
    word: 'blanket',
    definition: 'a warm soft cover that keeps you warm in bed',
    example: 'Pull the blanket over you.',
    paraphrases: [
      'a warm soft cover for a bed',
      'the soft cover that keeps you warm at night',
      'what you call a warm bed cover'
    ]
  },
  {
    word: 'broom',
    definition: 'a long-handled brush used to sweep the floor',
    example: 'Sweep the floor with a broom.',
    paraphrases: [
      'a long-handled brush for sweeping the floor',
      'the tool you sweep dust from the floor with',
      'what you call a brush with a long handle for the floor'
    ]
  },
  {
    word: 'key',
    definition: 'a small metal object that opens and locks a door',
    example: 'I lost my key again.',
    paraphrases: [
      'a small metal object that opens a lock',
      'the metal thing you turn to unlock a door',
      'what you call a small metal opener for locks'
    ]
  },
  // ---- Nature ----
  {
    word: 'tree',
    definition: 'a tall plant with a trunk, branches, and leaves',
    example: 'The bird sits in the tree.',
    paraphrases: [
      'a tall plant with a trunk and branches',
      'the tall plant with leaves and a wooden trunk',
      'what you call a tall plant that has branches and leaves'
    ]
  },
  {
    word: 'flower',
    definition: 'the colorful part of a plant that smells sweet',
    example: 'She picks a flower from the garden.',
    paraphrases: [
      'the colorful sweet-smelling part of a plant',
      'a colorful plant part that bees visit',
      'what you call the pretty part of a plant that smells sweet'
    ]
  },
  {
    word: 'grass',
    definition: 'the short green plants that cover the ground',
    example: 'The cow eats green grass.',
    paraphrases: [
      'the short green plants covering the ground',
      'the green ground cover that cows eat',
      'what you call the green plants that cover a lawn'
    ]
  },
  {
    word: 'leaf',
    definition: 'the flat green part of a plant that grows on a branch',
    example: 'A leaf falls from the tree.',
    paraphrases: [
      'the flat green part of a plant on a branch',
      'a flat green plant part that falls in autumn',
      'what you call the green flat thing growing on a branch'
    ]
  },
  {
    word: 'river',
    definition: 'a long stream of water that flows to the sea',
    example: 'The river flows past the town.',
    paraphrases: [
      'a long stream of water flowing to the sea',
      'the moving water that flows through the land',
      'what you call a wide stream of flowing water'
    ]
  },
  {
    word: 'lake',
    definition: 'a large area of water surrounded by land',
    example: 'We swim in the lake in summer.',
    paraphrases: [
      'a large area of water surrounded by land',
      'the big still water with land all around it',
      'what you call a wide water area with land around it'
    ]
  },
  {
    word: 'sea',
    definition: 'the huge area of salty water that covers much of the earth',
    example: 'Ships sail across the sea.',
    paraphrases: [
      'the huge area of salty water on the earth',
      'the great salty water that ships sail on',
      'what you call the vast salty water covering the earth'
    ]
  },
  {
    word: 'mountain',
    definition: 'a very high piece of land with a peak',
    example: 'Snow covers the top of the mountain.',
    paraphrases: [
      'a very high piece of land with a peak',
      'the highest kind of land that climbers climb',
      'what you call a very tall piece of land with a snowy peak'
    ]
  },
  {
    word: 'hill',
    definition: 'a raised area of land smaller than a mountain',
    example: 'We walk up the hill.',
    paraphrases: [
      'a raised area of land smaller than a mountain',
      'the small rise of land you walk up',
      'what you call a low raised piece of land'
    ]
  },
  {
    word: 'forest',
    definition: 'a large area of land covered with many trees',
    example: 'Deer live in the forest.',
    paraphrases: [
      'a large area covered with many trees',
      'the wild land full of trees where deer live',
      'what you call a big area with many trees'
    ]
  },
  {
    word: 'beach',
    definition: 'a sandy area of land next to the sea',
    example: 'The children play on the beach.',
    paraphrases: [
      'a sandy area next to the sea',
      'the sandy shore where children build castles',
      'what you call the sandy land at the edge of the sea'
    ]
  },
  {
    word: 'island',
    definition: 'a piece of land with water all around it',
    example: 'They sail to a small island.',
    paraphrases: [
      'a piece of land with water all around it',
      'the land surrounded by sea on every side',
      'what you call land that has water on all sides'
    ]
  },
  {
    word: 'stone',
    definition: 'a small hard piece of rock found on the ground',
    example: 'He throws a stone into the lake.',
    paraphrases: [
      'a small hard piece of rock',
      'the hard rock piece you find on the ground',
      'what you call a hard little piece of rock'
    ]
  },
  {
    word: 'sand',
    definition: 'the tiny loose grains of rock found on a beach',
    example: 'The sand is warm under my feet.',
    paraphrases: [
      'tiny loose grains of rock on a beach',
      'the soft grains covering a beach',
      'what you call the tiny grains you dig on a beach'
    ]
  },
  {
    word: 'fire',
    definition: 'the hot bright flames that burn wood',
    example: 'We sit around the fire at night.',
    paraphrases: [
      'the hot bright flames that burn wood',
      'the burning flames that give heat and light',
      'what you call hot flames burning wood'
    ]
  },
  {
    word: 'ice',
    definition: 'frozen water that is hard and cold',
    example: 'The lake turns to ice in winter.',
    paraphrases: [
      'frozen water that is hard and cold',
      'the hard cold thing water becomes when frozen',
      'what you call water after it freezes solid'
    ]
  },
  {
    word: 'moon',
    definition: 'the bright round object in the sky at night',
    example: 'The moon is full tonight.',
    paraphrases: [
      'the bright round object in the night sky',
      'the glowing circle you see in the sky at night',
      'what you call the round light in the sky after dark'
    ]
  },
  {
    word: 'sun',
    definition: 'the bright hot star in the sky that gives daylight',
    example: 'The sun rises in the east.',
    paraphrases: [
      'the bright hot star that gives daylight',
      'the hot star in the sky that warms the earth',
      'what you call the bright star that lights the day'
    ]
  },
  {
    word: 'star',
    definition: 'a tiny bright point of light in the night sky',
    example: 'We count every star in the sky.',
    paraphrases: [
      'a tiny bright point of light in the night sky',
      'the little light that twinkles in the sky at night',
      'what you call a small twinkling light in the dark sky'
    ]
  },
  {
    word: 'cloud',
    definition: 'a white or grey shape in the sky made of tiny water drops',
    example: 'A dark cloud hides the sun.',
    paraphrases: [
      'a white or grey shape in the sky made of water drops',
      'the fluffy white shape floating in the sky',
      'what you call a grey or white floating shape that brings rain'
    ]
  },
  // ---- Body ----
  {
    word: 'hand',
    definition: 'the part of your body at the end of your arm with five fingers',
    example: 'She waves her hand.',
    paraphrases: [
      'the body part at the end of your arm with fingers',
      'the part with five fingers you hold things with',
      'what you call the body part you grab and wave with'
    ]
  },
  {
    word: 'foot',
    definition: 'the part of your body at the end of your leg that you walk on',
    example: 'My foot hurts after the walk.',
    paraphrases: [
      'the body part at the end of your leg for walking',
      'the part with toes that you stand on',
      'what you call the body part you walk and stand on'
    ]
  },
  {
    word: 'head',
    definition: 'the top part of your body with your face and brain',
    example: 'He nods his head.',
    paraphrases: [
      'the top body part with your face and brain',
      'the part of the body that holds your brain and eyes',
      'what you call the top part of your body with the face'
    ]
  },
  {
    word: 'eye',
    definition: 'the part of your body that you see with',
    example: 'She closes one eye.',
    paraphrases: [
      'the body part you see with',
      'the round part of your face used for seeing',
      'what you call the part of your face that lets you see'
    ]
  },
  {
    word: 'ear',
    definition: 'the part of your body that you hear with',
    example: 'He covers his ear from the noise.',
    paraphrases: [
      'the body part you hear with',
      'the part on the side of your head used for hearing',
      'what you call the part of your head that lets you hear'
    ]
  },
  {
    word: 'nose',
    definition: 'the part of your face that you smell and breathe with',
    example: 'The dog sniffs with its nose.',
    paraphrases: [
      'the face part you smell and breathe with',
      'the middle part of your face used for smelling',
      'what you call the part of your face that smells things'
    ]
  },
  {
    word: 'mouth',
    definition: 'the part of your face that you eat and talk with',
    example: 'Open your mouth wide.',
    paraphrases: [
      'the face part you eat and talk with',
      'the opening in your face used for eating and talking',
      'what you call the part of your face you speak and chew with'
    ]
  },
  {
    word: 'tooth',
    definition: 'one of the hard white parts in your mouth used for chewing',
    example: 'The dentist checks my tooth.',
    paraphrases: [
      'a hard white part in your mouth for chewing',
      'one of the white things in your mouth that bite food',
      'what you call a hard white chewing part in the mouth'
    ]
  },
  {
    word: 'hair',
    definition: 'the soft strands that grow on top of your head',
    example: 'She brushes her long hair.',
    paraphrases: [
      'the soft strands growing on your head',
      'the strands on top of your head you brush and cut',
      'what you call the soft strands that grow from your head'
    ]
  },
  {
    word: 'heart',
    definition: 'the part inside your chest that pumps blood',
    example: 'My heart beats fast when I run.',
    paraphrases: [
      'the part inside your chest that pumps blood',
      'the organ in your chest that beats and pumps blood',
      'what you call the beating organ inside your chest'
    ]
  },
  // ---- Places ----
  {
    word: 'school',
    definition: 'a place where children go to learn from teachers',
    example: 'The children walk to school.',
    paraphrases: [
      'a place where children learn from teachers',
      'the building children go to for lessons',
      'what you call the place where teachers teach children'
    ]
  },
  {
    word: 'hospital',
    definition: 'a place where doctors and nurses care for sick people',
    example: 'The doctor works at the hospital.',
    paraphrases: [
      'a place where doctors care for sick people',
      'the building where nurses and doctors help the sick',
      'what you call the place sick people go for a doctor'
    ]
  },
  {
    word: 'farm',
    definition: 'a place with fields and animals where food is grown',
    example: 'Cows and pigs live on the farm.',
    paraphrases: [
      'a place with fields and animals where food grows',
      'the land where crops grow and cows live',
      'what you call the place with fields where food is grown'
    ]
  },
  {
    word: 'market',
    definition: 'a place where people buy and sell food and goods',
    example: 'We buy vegetables at the market.',
    paraphrases: [
      'a place where people buy and sell food',
      'the busy place with stalls selling fruit and goods',
      'what you call the place people go to buy and sell things'
    ]
  },
  {
    word: 'library',
    definition: 'a quiet place with many books that people borrow',
    example: 'I borrow books from the library.',
    paraphrases: [
      'a quiet place with many books to borrow',
      'the building full of books people can borrow',
      'what you call the quiet place where you borrow books'
    ]
  },
  {
    word: 'kitchen',
    definition: 'the room in a house where food is cooked',
    example: 'Mom cooks dinner in the kitchen.',
    paraphrases: [
      'the room in a house where food is cooked',
      'the room with a stove where meals are made',
      'what you call the room where you cook food'
    ]
  },
  {
    word: 'bathroom',
    definition: 'the room in a house where you wash and bathe',
    example: 'He brushes his teeth in the bathroom.',
    paraphrases: [
      'the room in a house where you wash',
      'the room with a bath where you wash yourself',
      'what you call the room where people bathe and wash'
    ]
  },
  {
    word: 'garden',
    definition: 'a piece of ground where flowers and vegetables grow',
    example: 'She plants roses in the garden.',
    paraphrases: [
      'a piece of ground where flowers and vegetables grow',
      'the ground behind a house where plants are grown',
      'what you call the place where you grow flowers and vegetables'
    ]
  },
  {
    word: 'park',
    definition: 'a public green place with grass and trees where people relax',
    example: 'The children play in the park.',
    paraphrases: [
      'a public green place with grass and trees',
      'the green public place where families relax and play',
      'what you call a public place with trees and grass for play'
    ]
  },
  {
    word: 'bridge',
    definition: 'a structure built over a river so people can cross',
    example: 'We cross the bridge over the river.',
    paraphrases: [
      'a structure built over a river for crossing',
      'the thing you walk across to get over a river',
      'what you call a structure that crosses over water'
    ]
  },
  {
    word: 'castle',
    definition: 'a large old stone building where kings and queens lived',
    example: 'The king lives in a castle.',
    paraphrases: [
      'a large old stone building where kings lived',
      'the great stone home of kings and queens',
      'what you call a big stone building with towers for a king'
    ]
  },
  {
    word: 'church',
    definition: 'a building where people gather to pray',
    example: 'The bells ring at the church.',
    paraphrases: [
      'a building where people gather to pray',
      'the building with a tower and bells where people pray',
      'what you call the building people pray in on Sunday'
    ]
  },
  // ---- Vehicles ----
  {
    word: 'car',
    definition: 'a road vehicle with four wheels and an engine that people drive',
    example: 'Dad drives the car to work.',
    paraphrases: [
      'a road vehicle with four wheels that people drive',
      'the vehicle with an engine you drive on roads',
      'what you call a four-wheeled vehicle that people drive'
    ]
  },
  {
    word: 'bus',
    definition: 'a long road vehicle that carries many passengers',
    example: 'We take the bus to town.',
    paraphrases: [
      'a long road vehicle carrying many passengers',
      'the big vehicle many people ride to town together',
      'what you call a large vehicle that carries many passengers'
    ]
  },
  {
    word: 'train',
    definition: 'a long vehicle that runs on rails and carries passengers',
    example: 'The train arrives at the station.',
    paraphrases: [
      'a long vehicle that runs on rails',
      'the vehicle on rails that stops at a station',
      'what you call a long vehicle pulling cars on rails'
    ]
  },
  {
    word: 'boat',
    definition: 'a small vehicle that floats and moves on water',
    example: 'We row the boat across the lake.',
    paraphrases: [
      'a small vehicle that floats on water',
      'the floating vehicle you row across a lake',
      'what you call a small floating vehicle on water'
    ]
  },
  {
    word: 'ship',
    definition: 'a very large boat that sails across the sea',
    example: 'The ship sails to another country.',
    paraphrases: [
      'a very large boat that sails the sea',
      'the huge boat that carries cargo across the sea',
      'what you call a great sea boat that sails far'
    ]
  },
  {
    word: 'plane',
    definition: 'a flying vehicle with wings and engines that carries people through the sky',
    example: 'The plane flies above the clouds.',
    paraphrases: [
      'a flying vehicle with wings and engines',
      'the vehicle with wings that carries people through the sky',
      'what you call a winged vehicle that flies in the sky'
    ]
  },
  {
    word: 'bicycle',
    definition: 'a vehicle with two wheels and pedals that you push with your feet',
    example: 'She rides her bicycle to school.',
    paraphrases: [
      'a vehicle with two wheels and pedals',
      'the two-wheeled ride you pedal with your feet',
      'what you call a pedal vehicle with two wheels'
    ]
  },
  {
    word: 'truck',
    definition: 'a large strong road vehicle that carries heavy goods',
    example: 'The truck delivers the boxes.',
    paraphrases: [
      'a large strong road vehicle for heavy goods',
      'the big vehicle that hauls heavy loads on roads',
      'what you call a heavy vehicle that carries goods'
    ]
  },
  {
    word: 'taxi',
    definition: 'a car with a driver that you pay to take you somewhere',
    example: 'We call a taxi to the airport.',
    paraphrases: [
      'a car with a driver you pay for a ride',
      'the hired car that takes you where you ask',
      'what you call a car you pay to ride in'
    ]
  },
  {
    word: 'wagon',
    definition: 'a wooden cart with four wheels pulled by a horse',
    example: 'The horse pulls the wagon.',
    paraphrases: [
      'a wooden cart with four wheels pulled by a horse',
      'the cart a horse pulls along a road',
      'what you call a four-wheeled cart that a horse pulls'
    ]
  },
  // ---- Clothing ----
  {
    word: 'shirt',
    definition: 'a piece of clothing with sleeves worn on the top of your body',
    example: 'He wears a clean shirt to work.',
    paraphrases: [
      'a piece of clothing with sleeves for the top of your body',
      'the top clothing with buttons and sleeves',
      'what you call clothing with sleeves worn on your chest'
    ]
  },
  {
    word: 'coat',
    definition: 'a warm piece of clothing worn outside over other clothes',
    example: 'Put on your coat; it is cold.',
    paraphrases: [
      'a warm piece of clothing worn over other clothes',
      'the heavy outer clothing for cold days',
      'what you call warm outer clothing for winter'
    ]
  },
  {
    word: 'hat',
    definition: 'a piece of clothing worn on top of your head',
    example: 'She wears a sun hat in summer.',
    paraphrases: [
      'a piece of clothing worn on your head',
      'the thing you put on your head to block the sun',
      'what you call head clothing that shades your face'
    ]
  },
  {
    word: 'shoe',
    definition: 'a strong covering worn on your foot for walking outside',
    example: 'Tie your shoe before you run.',
    paraphrases: [
      'a strong covering worn on your foot',
      'the foot covering you tie with laces',
      'what you call the covering you wear on each foot outside'
    ]
  },
  {
    word: 'sock',
    definition: 'a soft cloth covering worn on your foot inside a shoe',
    example: 'I wear one blue sock and one red.',
    paraphrases: [
      'a soft cloth covering worn on your foot',
      'the soft foot covering worn under a shoe',
      'what you call soft cloth for your foot inside a shoe'
    ]
  },
  {
    word: 'glove',
    definition: 'a covering for your hand with a place for each finger',
    example: 'He wears a warm glove on each hand.',
    paraphrases: [
      'a covering for your hand with a place for each finger',
      'the warm hand covering with separate fingers',
      'what you call a hand covering with room for every finger'
    ]
  },
  {
    word: 'scarf',
    definition: 'a long piece of cloth worn around your neck to keep warm',
    example: 'She wraps a scarf around her neck.',
    paraphrases: [
      'a long piece of cloth worn around your neck',
      'the warm cloth you wrap around your neck in winter',
      'what you call a long neck cloth for cold weather'
    ]
  },
  {
    word: 'belt',
    definition: 'a strip of leather worn around your waist to hold up trousers',
    example: 'He tightens his belt.',
    paraphrases: [
      'a strip of leather worn around your waist',
      'the leather strip that holds up your trousers',
      'what you call a waist strap that holds trousers up'
    ]
  },
  {
    word: 'skirt',
    definition: 'a piece of clothing that hangs from the waist worn by women and girls',
    example: 'She wears a long blue skirt.',
    paraphrases: [
      'a piece of clothing that hangs from the waist',
      'the clothing girls wear that hangs down from the waist',
      'what you call clothing hanging from the waist like a dress bottom'
    ]
  },
  {
    word: 'jacket',
    definition: 'a short light coat worn over a shirt',
    example: 'Take a jacket for the evening.',
    paraphrases: [
      'a short light coat worn over a shirt',
      'the light outer clothing shorter than a coat',
      'what you call a short coat for cool evenings'
    ]
  },
  // ---- Tools ----
  {
    word: 'hammer',
    definition: 'a heavy tool used to hit nails into wood',
    example: 'He hits the nail with a hammer.',
    paraphrases: [
      'a heavy tool used to hit nails into wood',
      'the tool you swing to drive nails into wood',
      'what you call a heavy tool for hitting nails'
    ]
  },
  {
    word: 'saw',
    definition: 'a tool with a toothed blade used to cut wood',
    example: 'Cut the board with a saw.',
    paraphrases: [
      'a tool with a toothed blade for cutting wood',
      'the toothed tool you pull back and forth to cut wood',
      'what you call a cutting tool with a blade full of teeth'
    ]
  },
  {
    word: 'ladder',
    definition: 'a set of steps you climb to reach high places',
    example: 'He climbs the ladder to the roof.',
    paraphrases: [
      'a set of steps you climb to reach high places',
      'the thing with rungs you climb to reach the roof',
      'what you call the steps you lean on a wall to climb'
    ]
  },
  {
    word: 'rope',
    definition: 'a thick strong cord used for tying and pulling things',
    example: 'Tie the boat with a rope.',
    paraphrases: [
      'a thick strong cord for tying and pulling',
      'the strong cord you tie things with',
      'what you call thick cord used to pull and tie'
    ]
  },
  {
    word: 'nail',
    definition: 'a small thin piece of metal with a point hit into wood',
    example: 'Hammer the nail into the board.',
    paraphrases: [
      'a small pointed piece of metal hit into wood',
      'the thin metal pin a hammer drives into wood',
      'what you call a pointed metal pin for joining wood'
    ]
  },
  {
    word: 'shovel',
    definition: 'a tool with a broad blade and long handle used for digging',
    example: 'Dig the hole with a shovel.',
    paraphrases: [
      'a tool with a broad blade for digging',
      'the long-handled tool you dig holes with',
      'what you call a digging tool with a broad blade'
    ]
  },
  {
    word: 'needle',
    definition: 'a very thin pointed piece of metal used for sewing with thread',
    example: 'Thread the needle carefully.',
    paraphrases: [
      'a very thin pointed piece of metal for sewing',
      'the tiny pointed tool you sew with thread',
      'what you call a thin sewing pin with an eye for thread'
    ]
  },
  {
    word: 'scissors',
    definition: 'a cutting tool with two blades joined together for cutting paper and cloth',
    example: 'Cut the paper with scissors.',
    paraphrases: [
      'a cutting tool with two blades joined together',
      'the two-bladed tool you cut paper and cloth with',
      'what you call a tool with two joined blades for cutting paper'
    ]
  },
  {
    word: 'bucket',
    definition: 'an open container with a handle used to carry water',
    example: 'Fill the bucket with water.',
    paraphrases: [
      'an open container with a handle for carrying water',
      'the container you carry water in by its handle',
      'what you call an open pail that carries water'
    ]
  },
  {
    word: 'wheel',
    definition: 'a round object that turns and lets a vehicle roll',
    example: 'The front wheel of the bicycle squeaks.',
    paraphrases: [
      'a round object that turns so a vehicle can roll',
      'the round turning part that lets a car roll',
      'what you call the round part a vehicle rolls on'
    ]
  },
  // ---- Weather ----
  {
    word: 'rain',
    definition: 'the drops of water that fall from clouds in the sky',
    example: 'The rain falls on the roof.',
    paraphrases: [
      'drops of water falling from clouds',
      'the water that falls from the sky on wet days',
      'what you call water drops falling from clouds'
    ]
  },
  {
    word: 'snow',
    definition: 'the soft white frozen flakes that fall from the sky in winter',
    example: 'Snow covers the ground in winter.',
    paraphrases: [
      'soft white frozen flakes falling in winter',
      'the cold white flakes that cover the ground in winter',
      'what you call frozen white flakes from the winter sky'
    ]
  },
  {
    word: 'wind',
    definition: 'the moving air that blows outside',
    example: 'The wind blows the leaves around.',
    paraphrases: [
      'the moving air that blows outside',
      'the air that blows and pushes the leaves',
      'what you call air that moves and blows things around'
    ]
  },
  {
    word: 'storm',
    definition: 'very bad weather with strong wind, rain, and thunder',
    example: 'The storm knocked down a tree.',
    paraphrases: [
      'very bad weather with strong wind and rain',
      'the violent weather with thunder and heavy rain',
      'what you call wild weather with wind, rain, and thunder'
    ]
  },
  {
    word: 'fog',
    definition: 'a thick low cloud near the ground that is hard to see through',
    example: 'The fog hides the road ahead.',
    paraphrases: [
      'a thick low cloud near the ground',
      'the grey mist that makes it hard to see the road',
      'what you call a ground cloud that hides everything'
    ]
  },
  {
    word: 'thunder',
    definition: 'the loud rumbling sound heard in the sky during a storm',
    example: 'Thunder booms after the flash.',
    paraphrases: [
      'the loud rumbling sound in the sky during a storm',
      'the deep booming sound that follows a flash in a storm',
      'what you call the loud sky rumble in a storm'
    ]
  },
  {
    word: 'lightning',
    definition: 'the bright flash of electricity in the sky during a storm',
    example: 'Lightning lit up the whole sky.',
    paraphrases: [
      'the bright flash of electricity in the sky',
      'the sudden electric flash you see in a storm',
      'what you call the bright electric flash before thunder'
    ]
  },
  {
    word: 'rainbow',
    definition: 'the arc of many colors seen in the sky after rain',
    example: 'A rainbow appeared after the storm.',
    paraphrases: [
      'the arc of many colors in the sky after rain',
      'the colorful arc that appears when sun follows rain',
      'what you call the colored arc across the sky after rain'
    ]
  }
];

/**
 * The corpus as a teachable deck: each entry maps to the DeckWord shape the
 * TeacherAgent consumes ({ word, definition, example }).
 */
export function paraphraseDeck(): DeckWord[] {
  return PARAPHRASE_CORPUS.map((entry) => ({
    word: entry.word,
    definition: entry.definition,
    example: entry.example
  }));
}

/**
 * Distinct lowercase tokens across all paraphrases AND definitions. Like
 * CONVERSATION_CUE_TOKENS: the session vocabulary is built from deck WORDS
 * only, so any cue token missing from the vocabulary is silently dropped at
 * recall time — these tokens must be added to the vocabulary for the
 * paraphrase cues to carry their content.
 */
export const PARAPHRASE_CUE_TOKENS: readonly string[] = [
  ...new Set(
    PARAPHRASE_CORPUS.flatMap((entry) => [
      ...tokenizeText(entry.definition),
      ...entry.paraphrases.flatMap((paraphrase) => tokenizeText(paraphrase))
    ])
  )
];

import type { TechnicalConcept } from './types';

/**
 * ARITHMETIC — the number and operation strands.
 *
 * Ordered by dependency, not by frequency. Every `dependsOn` entry names a
 * concept defined earlier in this file or in no file at all (a root). The
 * curriculum module verifies that closure, so a typo cannot silently create
 * an unteachable concept.
 *
 * Concepts with a `drill` key are checkable: verify.ts can generate an
 * unlimited supply of exercises for them and mark them exactly, with no
 * model in the loop.
 */
export const ARITHMETIC_CONCEPTS: readonly TechnicalConcept[] = [
  // ── Roots: counting and notation ────────────────────────────────────────
  {
    word: 'quantity',
    definition: 'how much of something there is',
    example: 'The quantity of water in the glass is small.',
    strand: 'number',
    dependsOn: []
  },
  {
    word: 'counting',
    definition: 'saying numbers in order to find how many things there are',
    example: 'Counting the apples gives five.',
    strand: 'number',
    dependsOn: ['quantity']
  },
  {
    word: 'digit',
    definition: 'any one of the ten symbols from 0 to 9',
    example: 'The number 47 has two digits.',
    strand: 'number',
    dependsOn: []
  },
  {
    word: 'numeral',
    definition: 'a written symbol that stands for a number',
    example: 'The numeral 7 stands for seven things.',
    strand: 'number',
    dependsOn: ['digit'],
    relations: [{ predicate: 'symbol-for', object: 'number' }]
  },
  {
    word: 'number',
    definition: 'a value that tells how many or how much',
    example: 'The number of days in a week is 7.',
    strand: 'number',
    dependsOn: ['counting', 'numeral']
  },
  {
    word: 'zero',
    definition: 'the number that means none at all',
    example: 'If you take 3 from 3 you get zero.',
    strand: 'number',
    dependsOn: ['number']
  },
  {
    word: 'place value',
    definition: 'the value a digit has because of its position in a number',
    example: 'In 342 the digit 3 has a place value of 300.',
    strand: 'number',
    dependsOn: ['digit', 'number'],
    drill: 'place-value'
  },
  {
    word: 'natural number',
    definition: 'one of the counting numbers 1, 2, 3 and so on',
    example: '5 is a natural number but -5 is not.',
    strand: 'number',
    dependsOn: ['counting', 'number'],
    relations: [{ predicate: 'special-case-of', object: 'number' }]
  },
  {
    word: 'whole number',
    definition: 'a natural number together with zero',
    example: '0, 1 and 2 are whole numbers.',
    strand: 'number',
    dependsOn: ['natural number', 'zero'],
    relations: [{ predicate: 'special-case-of', object: 'number' }]
  },

  // ── The four operations ─────────────────────────────────────────────────
  {
    word: 'addition',
    definition: 'putting two numbers together to find their total',
    example: 'The addition 2 + 3 = 5.',
    strand: 'operation',
    dependsOn: ['counting', 'number'],
    drill: 'addition'
  },
  {
    word: 'addend',
    definition: 'a number that is being added to another',
    example: 'In 2 + 3 = 5 the addends are 2 and 3.',
    strand: 'operation',
    dependsOn: ['addition']
  },
  {
    word: 'sum',
    definition: 'the result of adding numbers together',
    example: 'The sum of 2 and 3 is 5.',
    strand: 'operation',
    dependsOn: ['addition'],
    relations: [{ predicate: 'defined-as', object: 'addition' }]
  },
  {
    word: 'subtraction',
    definition: 'taking one number away from another to find what is left',
    example: 'The subtraction 5 - 3 = 2.',
    strand: 'operation',
    dependsOn: ['addition'],
    drill: 'subtraction'
  },
  {
    word: 'difference',
    definition: 'the result of subtracting one number from another',
    example: 'The difference between 9 and 4 is 5.',
    strand: 'operation',
    dependsOn: ['subtraction'],
    relations: [{ predicate: 'defined-as', object: 'subtraction' }]
  },
  {
    word: 'multiplication',
    definition: 'adding a number to itself a given number of times',
    example: 'The multiplication 4 * 3 = 12.',
    strand: 'operation',
    dependsOn: ['addition'],
    drill: 'multiplication'
  },
  {
    word: 'product',
    definition: 'the result of multiplying numbers together',
    example: 'The product of 4 and 3 is 12.',
    strand: 'operation',
    dependsOn: ['multiplication'],
    relations: [{ predicate: 'defined-as', object: 'multiplication' }]
  },
  {
    word: 'division',
    definition: 'splitting a number into equal parts',
    example: 'The division 12 / 3 = 4.',
    strand: 'operation',
    dependsOn: ['multiplication', 'subtraction'],
    drill: 'division'
  },
  {
    word: 'quotient',
    definition: 'the result of dividing one number by another',
    example: 'The quotient of 12 divided by 3 is 4.',
    strand: 'operation',
    dependsOn: ['division'],
    relations: [{ predicate: 'defined-as', object: 'division' }]
  },
  {
    word: 'dividend',
    definition: 'the number that is being divided',
    example: 'In 12 / 3 the dividend is 12.',
    strand: 'operation',
    dependsOn: ['division']
  },
  {
    word: 'divisor',
    definition: 'the number you are dividing by',
    example: 'In 12 / 3 the divisor is 3.',
    strand: 'operation',
    dependsOn: ['division']
  },
  {
    word: 'remainder',
    definition: 'the amount left over when one number does not divide another exactly',
    example: 'Dividing 7 by 2 leaves a remainder of 1.',
    strand: 'operation',
    dependsOn: ['division'],
    drill: 'remainder'
  },
  {
    word: 'inverse operation',
    definition: 'an operation that undoes another operation',
    example: 'Subtraction is the inverse operation of addition.',
    strand: 'operation',
    dependsOn: ['addition', 'subtraction', 'multiplication', 'division']
  },

  // ── Equality and expressions ────────────────────────────────────────────
  {
    word: 'equal',
    definition: 'having exactly the same value',
    example: '2 + 3 is equal to 5.',
    strand: 'operation',
    dependsOn: ['number']
  },
  {
    word: 'expression',
    definition: 'numbers and operations written together without an equals sign',
    example: '3 * 4 + 1 is an expression.',
    strand: 'operation',
    dependsOn: ['addition', 'multiplication']
  },
  {
    word: 'equation',
    definition: 'a statement that two expressions are equal',
    example: 'The equation 2 + 3 = 5 is true.',
    strand: 'operation',
    dependsOn: ['expression', 'equal']
  },
  {
    word: 'variable',
    definition: 'a letter that stands for a number that can change',
    example: 'In x + 2 = 5 the variable x is 3.',
    strand: 'operation',
    dependsOn: ['equation']
  },
  {
    word: 'term',
    definition: 'a single number or variable part of an expression',
    example: 'The expression 3x + 5 has two terms.',
    strand: 'operation',
    dependsOn: ['expression', 'variable']
  },
  {
    word: 'coefficient',
    definition: 'the number multiplying a variable',
    example: 'In 3x the coefficient is 3.',
    strand: 'operation',
    dependsOn: ['term', 'multiplication']
  },
  {
    word: 'constant',
    definition: 'a value that does not change',
    example: 'In 3x + 5 the constant is 5.',
    strand: 'operation',
    dependsOn: ['term']
  },
  {
    word: 'inequality',
    definition: 'a statement that one value is larger or smaller than another',
    example: 'The inequality 3 < 5 is true.',
    strand: 'operation',
    dependsOn: ['equation'],
    drill: 'comparison'
  },
  {
    word: 'order of operations',
    definition: 'the rule that multiplication and division are done before addition and subtraction',
    example: 'By the order of operations 2 + 3 * 4 = 14.',
    strand: 'operation',
    dependsOn: ['expression', 'multiplication', 'addition'],
    drill: 'order-of-operations'
  },

  // ── Properties ──────────────────────────────────────────────────────────
  {
    word: 'commutative property',
    definition: 'the rule that the order of the numbers does not change the result',
    example: 'By the commutative property 3 + 4 = 4 + 3.',
    strand: 'operation',
    dependsOn: ['addition', 'multiplication'],
    drill: 'commutative'
  },
  {
    word: 'associative property',
    definition: 'the rule that the grouping of the numbers does not change the result',
    example: 'By the associative property (2 + 3) + 4 = 2 + (3 + 4).',
    strand: 'operation',
    dependsOn: ['addition', 'multiplication']
  },
  {
    word: 'distributive property',
    definition: 'the rule that multiplying a sum gives the same result as multiplying each part',
    example: 'By the distributive property 3 * (2 + 4) = 3 * 2 + 3 * 4.',
    strand: 'operation',
    dependsOn: ['multiplication', 'addition'],
    drill: 'distributive'
  },
  {
    word: 'additive identity',
    definition: 'the number zero, which leaves any number unchanged when added',
    example: 'Zero is the additive identity because 7 + 0 = 7.',
    strand: 'operation',
    dependsOn: ['addition', 'zero']
  },
  {
    word: 'multiplicative identity',
    definition: 'the number one, which leaves any number unchanged when multiplied',
    example: 'One is the multiplicative identity because 7 * 1 = 7.',
    strand: 'operation',
    dependsOn: ['multiplication']
  },
  {
    word: 'additive inverse',
    definition: 'the number that adds to a given number to make zero',
    example: 'The additive inverse of 7 is -7.',
    strand: 'operation',
    dependsOn: ['additive identity', 'negative number']
  },

  // ── Signed numbers ──────────────────────────────────────────────────────
  {
    word: 'positive number',
    definition: 'a number greater than zero',
    example: '4 is a positive number.',
    strand: 'number',
    dependsOn: ['zero', 'number']
  },
  {
    word: 'negative number',
    definition: 'a number less than zero',
    example: 'The temperature fell to -4, a negative number.',
    strand: 'number',
    dependsOn: ['zero', 'subtraction']
  },
  {
    word: 'integer',
    definition: 'a whole number that may be positive, negative, or zero',
    example: '-3, 0 and 3 are all integers.',
    strand: 'number',
    dependsOn: ['whole number', 'negative number'],
    relations: [{ predicate: 'special-case-of', object: 'number' }]
  },
  {
    word: 'opposite',
    definition: 'the number the same distance from zero but on the other side',
    example: 'The opposite of 5 is -5.',
    strand: 'number',
    dependsOn: ['integer']
  },
  {
    word: 'absolute value',
    definition: 'the distance of a number from zero, never negative',
    example: 'The absolute value of -6 is 6.',
    strand: 'number',
    dependsOn: ['integer', 'opposite'],
    drill: 'absolute-value'
  },

  // ── Factors and multiples ───────────────────────────────────────────────
  {
    word: 'factor',
    definition: 'a number that divides another number exactly',
    example: '3 is a factor of 12.',
    strand: 'number',
    dependsOn: ['division', 'multiplication'],
    drill: 'factor'
  },
  {
    word: 'multiple',
    definition: 'the result of multiplying a number by a whole number',
    example: '12 is a multiple of 3.',
    strand: 'number',
    dependsOn: ['multiplication', 'whole number']
  },
  {
    word: 'even number',
    definition: 'a whole number that can be divided by 2 with no remainder',
    example: '8 is an even number.',
    strand: 'number',
    dependsOn: ['remainder', 'whole number'],
    drill: 'parity'
  },
  {
    word: 'odd number',
    definition: 'a whole number that leaves a remainder of 1 when divided by 2',
    example: '7 is an odd number.',
    strand: 'number',
    dependsOn: ['even number']
  },
  {
    word: 'prime number',
    definition: 'a whole number greater than 1 whose only factors are 1 and itself',
    example: '7 is a prime number.',
    strand: 'number',
    dependsOn: ['factor'],
    drill: 'prime'
  },
  {
    word: 'composite number',
    definition: 'a whole number greater than 1 that has more factors than 1 and itself',
    example: '9 is a composite number because 3 divides it.',
    strand: 'number',
    dependsOn: ['prime number']
  },
  {
    word: 'common factor',
    definition: 'a number that is a factor of two or more numbers',
    example: '3 is a common factor of 9 and 12.',
    strand: 'number',
    dependsOn: ['factor']
  },
  {
    word: 'greatest common factor',
    definition: 'the largest number that divides two numbers exactly',
    example: 'The greatest common factor of 12 and 18 is 6.',
    strand: 'number',
    dependsOn: ['common factor'],
    drill: 'gcf'
  },
  {
    word: 'common multiple',
    definition: 'a number that is a multiple of two or more numbers',
    example: '12 is a common multiple of 3 and 4.',
    strand: 'number',
    dependsOn: ['multiple']
  },
  {
    word: 'least common multiple',
    definition: 'the smallest number that two numbers both divide into',
    example: 'The least common multiple of 4 and 6 is 12.',
    strand: 'number',
    dependsOn: ['common multiple'],
    drill: 'lcm'
  },

  // ── Fractions, decimals, percent ────────────────────────────────────────
  {
    word: 'fraction',
    definition: 'a number written as one whole number over another to show parts of a whole',
    example: 'The fraction 3/4 means three parts out of four.',
    strand: 'number',
    dependsOn: ['division', 'whole number']
  },
  {
    word: 'numerator',
    definition: 'the top number of a fraction',
    example: 'In 3/4 the numerator is 3.',
    strand: 'number',
    dependsOn: ['fraction']
  },
  {
    word: 'denominator',
    definition: 'the bottom number of a fraction',
    example: 'In 3/4 the denominator is 4.',
    strand: 'number',
    dependsOn: ['fraction']
  },
  {
    word: 'proper fraction',
    definition: 'a fraction whose numerator is smaller than its denominator',
    example: '3/4 is a proper fraction.',
    strand: 'number',
    dependsOn: ['numerator', 'denominator'],
    relations: [{ predicate: 'special-case-of', object: 'fraction' }]
  },
  {
    word: 'improper fraction',
    definition: 'a fraction whose numerator is larger than its denominator',
    example: '7/4 is an improper fraction.',
    strand: 'number',
    dependsOn: ['proper fraction'],
    relations: [{ predicate: 'special-case-of', object: 'fraction' }]
  },
  {
    word: 'mixed number',
    definition: 'a whole number written together with a fraction',
    example: 'The mixed number 1 3/4 equals the improper fraction 7/4.',
    strand: 'number',
    dependsOn: ['improper fraction']
  },
  {
    word: 'equivalent fraction',
    definition: 'a fraction that has the same value as another',
    example: '2/4 is an equivalent fraction to 1/2.',
    strand: 'number',
    dependsOn: ['fraction', 'equal']
  },
  {
    word: 'simplest form',
    definition: 'a fraction whose numerator and denominator share no common factor above 1',
    example: 'The simplest form of 6/8 is 3/4.',
    strand: 'number',
    dependsOn: ['equivalent fraction', 'greatest common factor'],
    drill: 'simplify-fraction'
  },
  {
    word: 'reciprocal',
    definition: 'the number you multiply by to get one, found by turning a fraction over',
    example: 'The reciprocal of 3/4 is 4/3.',
    strand: 'number',
    dependsOn: ['fraction', 'multiplicative identity']
  },
  {
    word: 'decimal',
    definition: 'a number written with a point to show parts smaller than one',
    example: 'The decimal 0.5 is the same as the fraction 1/2.',
    strand: 'number',
    dependsOn: ['place value', 'fraction']
  },
  {
    word: 'decimal point',
    definition: 'the dot that separates whole units from parts smaller than one',
    example: 'In 3.25 the decimal point comes after the 3.',
    strand: 'number',
    dependsOn: ['decimal']
  },
  {
    word: 'percent',
    definition: 'a number of parts out of one hundred',
    example: '25 percent of 80 is 20.',
    strand: 'number',
    dependsOn: ['fraction', 'decimal'],
    drill: 'percent'
  },
  {
    word: 'ratio',
    definition: 'a comparison of two quantities by division',
    example: 'The ratio of 6 to 3 is 2 to 1.',
    strand: 'number',
    dependsOn: ['division', 'quantity']
  },
  {
    word: 'proportion',
    definition: 'a statement that two ratios are equal',
    example: 'The proportion 1/2 = 2/4 is true.',
    strand: 'number',
    dependsOn: ['ratio', 'equation']
  },
  {
    word: 'rational number',
    definition: 'a number that can be written as one integer divided by another',
    example: '3/4 is a rational number.',
    strand: 'number',
    dependsOn: ['fraction', 'integer']
  },
  {
    word: 'irrational number',
    definition: 'a number that cannot be written as one integer divided by another',
    example: 'The square root of 2 is an irrational number.',
    strand: 'number',
    dependsOn: ['rational number', 'square root']
  },
  {
    word: 'real number',
    definition: 'any rational or irrational number',
    example: 'Every point on the number line is a real number.',
    strand: 'number',
    dependsOn: ['rational number', 'irrational number']
  },

  // ── Powers and roots ────────────────────────────────────────────────────
  {
    word: 'base',
    definition: 'the number that is being multiplied by itself',
    example: 'In 2^3 the base is 2.',
    strand: 'operation',
    dependsOn: ['multiplication']
  },
  {
    word: 'exponent',
    definition: 'the small number showing how many times to multiply the base by itself',
    example: 'In 2^3 the exponent is 3.',
    strand: 'operation',
    dependsOn: ['base'],
    drill: 'exponent'
  },
  {
    word: 'exponentiation',
    definition: 'the operation of multiplying a base by itself a number of times',
    example: 'The exponentiation 2^3 gives 8.',
    strand: 'operation',
    dependsOn: ['exponent']
  },
  {
    word: 'square',
    definition: 'the result of multiplying a number by itself',
    example: 'The square of 6 is 36.',
    strand: 'operation',
    dependsOn: ['exponentiation'],
    drill: 'square',
    relations: [{ predicate: 'special-case-of', object: 'exponentiation' }]
  },
  {
    word: 'cube',
    definition: 'the result of multiplying a number by itself three times',
    example: 'The cube of 3 is 27.',
    strand: 'operation',
    dependsOn: ['exponentiation'],
    relations: [{ predicate: 'special-case-of', object: 'exponentiation' }]
  },
  {
    word: 'square root',
    definition: 'the number that gives a given number when multiplied by itself',
    example: 'The square root of 36 is 6.',
    strand: 'operation',
    dependsOn: ['square', 'inverse operation'],
    drill: 'square-root'
  },
  {
    word: 'cube root',
    definition: 'the number that gives a given number when multiplied by itself three times',
    example: 'The cube root of 27 is 3.',
    strand: 'operation',
    dependsOn: ['cube', 'inverse operation']
  },
  {
    word: 'scientific notation',
    definition: 'a number written as a value between 1 and 10 multiplied by a power of ten',
    example: 'In scientific notation 4500 is 4.5 * 10^3.',
    strand: 'number',
    dependsOn: ['exponentiation', 'decimal'],
    drill: 'scientific-notation'
  },

  // ── Approximation ───────────────────────────────────────────────────────
  {
    word: 'rounding',
    definition: 'replacing a number with a nearby simpler number',
    example: 'Rounding 47 to the nearest ten gives 50.',
    strand: 'number',
    dependsOn: ['place value'],
    drill: 'rounding'
  },
  {
    word: 'estimate',
    definition: 'an answer close to the exact one, found quickly',
    example: 'An estimate of 49 + 52 is about 100.',
    strand: 'number',
    dependsOn: ['rounding']
  },

  // ── Applying the operations ─────────────────────────────────────────────
  {
    word: 'word problem',
    definition: 'a problem told as a short story whose answer is found with an operation',
    example: 'Sam has 3 apples and gets 2 more is a word problem solved by addition.',
    strand: 'operation',
    dependsOn: ['addition', 'subtraction'],
    relations: [{ predicate: 'used-for', object: 'addition' }],
    drill: 'word-problem-add'
  },
  {
    word: 'product word problem',
    definition: 'a word problem about equal groups, solved by multiplying',
    example: 'Four boxes of 6 pencils is a product word problem with answer 24.',
    strand: 'operation',
    dependsOn: ['word problem', 'multiplication'],
    relations: [
      { predicate: 'special-case-of', object: 'word problem' },
      { predicate: 'used-for', object: 'multiplication' }
    ],
    drill: 'word-problem-mul'
  },
  {
    word: 'unknown number',
    definition: 'the number an equation asks for, found by undoing what was done to it',
    example: 'In x + 4 = 9 the unknown number is 5.',
    strand: 'operation',
    dependsOn: ['equation', 'variable', 'inverse operation'],
    relations: [{ predicate: 'defined-as', object: 'variable' }],
    drill: 'solve-x-add'
  },
  {
    word: 'unknown factor',
    definition: 'the missing number in a multiplication, found by dividing the product',
    example: 'In 3 * x = 12 the unknown factor is 4.',
    strand: 'operation',
    dependsOn: ['unknown number', 'division'],
    relations: [{ predicate: 'special-case-of', object: 'unknown number' }],
    drill: 'solve-x-mul'
  },
  {
    word: 'number sequence',
    definition: 'a list of numbers made by following the same rule from each to the next',
    example: 'The number sequence 2, 5, 8, 11 adds 3 each time.',
    strand: 'number',
    dependsOn: ['number', 'addition'],
    relations: [{ predicate: 'made-of', object: 'number' }],
    drill: 'sequence-next'
  }
];

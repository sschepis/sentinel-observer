import type { TechnicalConcept } from './types';

/**
 * MEASUREMENT AND UNITS — the strand every science domain reuses.
 *
 * Built on the arithmetic strand: a unit conversion is a multiplication, a
 * density is a division, a prefix is a power of ten. Teaching this before
 * physics or chemistry means those domains inherit a working quantity model
 * instead of re-deriving one.
 */
export const MEASUREMENT_CONCEPTS: readonly TechnicalConcept[] = [
  // ── The idea of measuring ───────────────────────────────────────────────
  {
    word: 'measurement',
    definition: 'finding the size of something by comparing it with a unit',
    example: 'The measurement of the table gave 2 meters.',
    strand: 'measurement',
    dependsOn: ['quantity', 'number']
  },
  {
    word: 'unit',
    definition: 'an agreed amount used to measure a quantity',
    example: 'The meter is the unit of length.',
    strand: 'measurement',
    dependsOn: ['measurement']
  },
  {
    word: 'magnitude',
    definition: 'how large a quantity is, written as a number of units',
    example: 'The magnitude of the mass is 5 kilograms.',
    strand: 'measurement',
    dependsOn: ['unit', 'number']
  },
  {
    word: 'dimension',
    definition: 'the kind of quantity being measured, such as length or mass',
    example: 'Speed has the dimension of length divided by time.',
    strand: 'measurement',
    dependsOn: ['unit']
  },
  {
    word: 'base unit',
    definition: 'a unit that is defined on its own and not from other units',
    example: 'The second is a base unit of time.',
    strand: 'measurement',
    dependsOn: ['unit'],
    relations: [{ predicate: 'special-case-of', object: 'unit' }]
  },
  {
    word: 'derived unit',
    definition: 'a unit made by combining base units',
    example: 'The derived unit of speed is the meter per second.',
    strand: 'measurement',
    dependsOn: ['base unit', 'division'],
    relations: [{ predicate: 'special-case-of', object: 'unit' }]
  },
  {
    word: 'metric system',
    definition: 'a system of units in which each step is ten times the one before',
    example: 'In the metric system 1000 meters make a kilometer.',
    strand: 'measurement',
    dependsOn: ['unit', 'exponentiation']
  },

  // ── Metric prefixes ─────────────────────────────────────────────────────
  {
    word: 'prefix',
    definition: 'a word part placed before a unit to multiply it by a power of ten',
    example: 'The prefix kilo means one thousand.',
    strand: 'measurement',
    dependsOn: ['metric system', 'exponent'],
    drill: 'prefix-value'
  },
  {
    word: 'kilo',
    definition: 'the prefix meaning one thousand',
    example: 'A kilogram is a kilo of grams, or 1000 grams.',
    strand: 'measurement',
    dependsOn: ['prefix'],
    relations: [{ predicate: 'defined-as', object: 'exponentiation' }]
  },
  {
    word: 'centi',
    definition: 'the prefix meaning one hundredth',
    example: 'A centimeter is a centi of a meter, or 0.01 meters.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },
  {
    word: 'milli',
    definition: 'the prefix meaning one thousandth',
    example: 'A millimeter is a milli of a meter, or 0.001 meters.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },
  {
    word: 'micro',
    definition: 'the prefix meaning one millionth',
    example: 'A micrometer is a micro of a meter.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },
  {
    word: 'nano',
    definition: 'the prefix meaning one billionth',
    example: 'A nanometer is a nano of a meter.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },
  {
    word: 'mega',
    definition: 'the prefix meaning one million',
    example: 'A megawatt is a mega of watts.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },
  {
    word: 'giga',
    definition: 'the prefix meaning one billion',
    example: 'A gigameter is a giga of meters.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },
  {
    word: 'deci',
    definition: 'the prefix meaning one tenth',
    example: 'A decimeter is a deci of a meter.',
    strand: 'measurement',
    dependsOn: ['prefix']
  },

  // ── Length ──────────────────────────────────────────────────────────────
  {
    word: 'length',
    definition: 'how long something is from end to end',
    example: 'The length of the rope is 3 meters.',
    strand: 'measurement',
    dependsOn: ['measurement'],
    relations: [{ predicate: 'measured-in', object: 'meter' }]
  },
  {
    word: 'meter',
    definition: 'the base unit of length in the metric system',
    example: 'The room is 4 meters wide.',
    strand: 'unit',
    dependsOn: ['base unit', 'length'],
    relations: [{ predicate: 'symbol-for', object: 'length' }]
  },
  {
    word: 'centimeter',
    definition: 'one hundredth of a meter',
    example: 'A pencil is about 15 centimeters long.',
    strand: 'unit',
    dependsOn: ['meter', 'centi'],
    drill: 'convert-length'
  },
  {
    word: 'millimeter',
    definition: 'one thousandth of a meter',
    example: 'A coin is about 2 millimeters thick.',
    strand: 'unit',
    dependsOn: ['meter', 'milli']
  },
  {
    word: 'kilometer',
    definition: 'one thousand meters',
    example: 'The walk was 5 kilometers.',
    strand: 'unit',
    dependsOn: ['meter', 'kilo']
  },

  // ── Mass ────────────────────────────────────────────────────────────────
  {
    word: 'mass',
    definition: 'the amount of matter in an object',
    example: 'The mass of the box is 2 kilograms.',
    strand: 'measurement',
    dependsOn: ['measurement'],
    relations: [{ predicate: 'measured-in', object: 'kilogram' }]
  },
  {
    word: 'gram',
    definition: 'a metric unit of mass equal to one thousandth of a kilogram',
    example: 'The letter has a mass of 20 grams.',
    strand: 'unit',
    dependsOn: ['mass', 'metric system']
  },
  {
    word: 'kilogram',
    definition: 'the base unit of mass, equal to one thousand grams',
    example: 'The bag has a mass of 3 kilograms.',
    strand: 'unit',
    dependsOn: ['gram', 'kilo', 'base unit'],
    drill: 'convert-mass'
  },
  {
    word: 'milligram',
    definition: 'one thousandth of a gram',
    example: 'The tablet contains 500 milligrams.',
    strand: 'unit',
    dependsOn: ['gram', 'milli']
  },

  // ── Time ────────────────────────────────────────────────────────────────
  {
    word: 'time',
    definition: 'how long something lasts, measured from one moment to another',
    example: 'The race took a time of 40 seconds.',
    strand: 'measurement',
    dependsOn: ['measurement'],
    relations: [{ predicate: 'measured-in', object: 'second' }]
  },
  {
    word: 'second',
    definition: 'the base unit of time',
    example: 'The light flashed for one second.',
    strand: 'unit',
    dependsOn: ['time', 'base unit']
  },
  {
    word: 'minute',
    definition: 'a unit of time equal to sixty seconds',
    example: 'The song lasts three minutes.',
    strand: 'unit',
    dependsOn: ['second'],
    drill: 'convert-time'
  },
  {
    word: 'hour',
    definition: 'a unit of time equal to sixty minutes',
    example: 'The journey took two hours.',
    strand: 'unit',
    dependsOn: ['minute']
  },

  // ── Derived quantities ──────────────────────────────────────────────────
  {
    word: 'area',
    definition: 'the amount of surface a shape covers, found by multiplying lengths',
    example: 'A room 3 meters by 4 meters has an area of 12 square meters.',
    strand: 'measurement',
    dependsOn: ['length', 'multiplication'],
    drill: 'area'
  },
  {
    word: 'square meter',
    definition: 'the derived unit of area, equal to a square one meter on each side',
    example: 'The floor covers 12 square meters.',
    strand: 'unit',
    dependsOn: ['area', 'derived unit']
  },
  {
    word: 'volume',
    definition: 'the amount of space something takes up',
    example: 'The tank has a volume of 2 cubic meters.',
    strand: 'measurement',
    dependsOn: ['area', 'length'],
    drill: 'volume'
  },
  {
    word: 'cubic meter',
    definition: 'the derived unit of volume, equal to a cube one meter on each side',
    example: 'The container holds one cubic meter.',
    strand: 'unit',
    dependsOn: ['volume', 'derived unit']
  },
  {
    word: 'liter',
    definition: 'a metric unit of volume equal to one thousand cubic centimeters',
    example: 'The bottle holds two liters.',
    strand: 'unit',
    dependsOn: ['volume', 'metric system']
  },
  {
    word: 'milliliter',
    definition: 'one thousandth of a liter',
    example: 'The spoon holds 5 milliliters.',
    strand: 'unit',
    dependsOn: ['liter', 'milli'],
    drill: 'convert-volume'
  },
  {
    word: 'density',
    definition: 'the mass of an object divided by its volume',
    example: 'A block of 12 grams and 4 cubic centimeters has a density of 3.',
    strand: 'measurement',
    dependsOn: ['mass', 'volume', 'division'],
    drill: 'density'
  },
  {
    word: 'speed',
    definition: 'the distance travelled divided by the time taken',
    example: 'Going 100 meters in 20 seconds is a speed of 5 meters per second.',
    strand: 'measurement',
    dependsOn: ['length', 'time', 'division'],
    drill: 'speed',
    relations: [{ predicate: 'defined-as', object: 'division' }]
  },
  {
    word: 'meter per second',
    definition: 'the derived unit of speed',
    example: 'The runner moved at 8 meters per second.',
    strand: 'unit',
    dependsOn: ['speed', 'derived unit']
  },
  {
    word: 'velocity',
    definition: 'speed together with the direction of motion',
    example: 'The velocity was 5 meters per second to the north.',
    strand: 'measurement',
    dependsOn: ['speed']
  },
  {
    word: 'acceleration',
    definition: 'the change in velocity divided by the time taken',
    example: 'Gaining 10 meters per second in 2 seconds is an acceleration of 5.',
    strand: 'measurement',
    dependsOn: ['velocity', 'division']
  },
  {
    word: 'force',
    definition: 'a push or pull, equal to mass multiplied by acceleration',
    example: 'A mass of 2 kilograms accelerating at 3 gives a force of 6 newtons.',
    strand: 'measurement',
    dependsOn: ['mass', 'acceleration', 'multiplication'],
    relations: [{ predicate: 'measured-in', object: 'newton' }],
    drill: 'force'
  },
  {
    word: 'newton',
    definition: 'the derived unit of force',
    example: 'The rope pulled with a force of 20 newtons.',
    strand: 'unit',
    dependsOn: ['force', 'derived unit']
  },
  {
    word: 'energy',
    definition: 'the capacity to do work, measured in joules',
    example: 'Lifting the box used 50 joules of energy.',
    strand: 'measurement',
    dependsOn: ['force', 'length'],
    relations: [{ predicate: 'measured-in', object: 'joule' }]
  },
  {
    word: 'joule',
    definition: 'the derived unit of energy, equal to a newton acting over a meter',
    example: 'The lamp used 100 joules.',
    strand: 'unit',
    dependsOn: ['energy', 'newton', 'derived unit']
  },
  {
    word: 'power',
    definition: 'the energy used divided by the time taken',
    example: 'Using 100 joules in 2 seconds is a power of 50 watts.',
    strand: 'measurement',
    dependsOn: ['energy', 'time', 'division'],
    relations: [{ predicate: 'measured-in', object: 'watt' }]
  },
  {
    word: 'watt',
    definition: 'the derived unit of power, equal to one joule each second',
    example: 'The bulb uses 60 watts.',
    strand: 'unit',
    dependsOn: ['joule', 'second', 'derived unit']
  },
  {
    word: 'pressure',
    definition: 'the force divided by the area it acts on',
    example: 'A force of 10 newtons on 2 square meters is a pressure of 5 pascals.',
    strand: 'measurement',
    dependsOn: ['force', 'area', 'division'],
    relations: [{ predicate: 'measured-in', object: 'pascal' }]
  },
  {
    word: 'pascal',
    definition: 'the derived unit of pressure, equal to one newton on each square meter',
    example: 'The air pressed with 1000 pascals.',
    strand: 'unit',
    dependsOn: ['pressure', 'derived unit']
  },
  {
    word: 'temperature',
    definition: 'how hot or cold something is',
    example: 'The temperature of the water was 20 degrees.',
    strand: 'measurement',
    dependsOn: ['measurement']
  },
  {
    word: 'celsius',
    definition: 'a temperature scale on which water freezes at 0 and boils at 100',
    example: 'The room was 21 degrees celsius.',
    strand: 'unit',
    dependsOn: ['temperature'],
    drill: 'temperature'
  },
  {
    word: 'kelvin',
    definition: 'the base unit of temperature, starting from the coldest possible point',
    example: 'Water freezes at 273 kelvin.',
    strand: 'unit',
    dependsOn: ['celsius', 'base unit']
  },
  {
    word: 'frequency',
    definition: 'the number of times something repeats each second',
    example: 'A frequency of 5 hertz means five cycles a second.',
    strand: 'measurement',
    dependsOn: ['time', 'division'],
    relations: [{ predicate: 'measured-in', object: 'hertz' }]
  },
  {
    word: 'hertz',
    definition: 'the derived unit of frequency, equal to one cycle each second',
    example: 'The tone was 440 hertz.',
    strand: 'unit',
    dependsOn: ['frequency', 'derived unit']
  },

  // ── Working with measurements ───────────────────────────────────────────
  {
    word: 'conversion factor',
    definition: 'the number you multiply by to change one unit into another',
    example: 'The conversion factor from meters to centimeters is 100.',
    strand: 'measurement',
    dependsOn: ['unit', 'multiplication']
  },
  {
    word: 'unit conversion',
    definition: 'changing a measurement into a different unit without changing its size',
    example: 'The unit conversion of 3 meters gives 300 centimeters.',
    strand: 'measurement',
    dependsOn: ['conversion factor'],
    drill: 'convert-length'
  },
  {
    word: 'dimensional analysis',
    definition: 'checking a calculation by following the units through it',
    example: 'Dimensional analysis shows that speed must be length divided by time.',
    strand: 'measurement',
    dependsOn: ['unit conversion', 'dimension']
  },
  {
    word: 'precision',
    definition: 'how close repeated measurements are to each other',
    example: 'The scale had good precision because it always read the same.',
    strand: 'measurement',
    dependsOn: ['measurement']
  },
  {
    word: 'accuracy',
    definition: 'how close a measurement is to the true value',
    example: 'The clock had poor accuracy because it ran fast.',
    strand: 'measurement',
    dependsOn: ['precision']
  },
  {
    word: 'significant figure',
    definition: 'a digit that carries real information about a measurement',
    example: 'The value 0.0250 has three significant figures.',
    strand: 'measurement',
    dependsOn: ['digit', 'precision', 'rounding']
  },

  // ── Everyday quantities ─────────────────────────────────────────────────
  {
    word: 'elapsed time',
    definition: 'the amount of time that passes between a start and an end',
    example: 'A movie starting at 3 and ending at 5 has an elapsed time of two hours.',
    strand: 'measurement',
    dependsOn: ['time', 'hour', 'addition'],
    relations: [{ predicate: 'is-a', object: 'time' }],
    drill: 'elapsed-time'
  },
  {
    word: 'money',
    definition: 'an amount of value counted in cents and combined by adding coin values',
    example: 'Two quarters and one dime make 60 cents of money.',
    strand: 'measurement',
    dependsOn: ['counting', 'addition', 'multiplication'],
    relations: [{ predicate: 'defined-as', object: 'addition' }],
    drill: 'money-total'
  }
];

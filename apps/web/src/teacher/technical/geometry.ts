import type { TechnicalConcept } from './types';

/**
 * GEOMETRY — shape, angle, and the coordinate plane.
 *
 * Built on the arithmetic and measurement strands: a perimeter is an
 * addition of lengths, an angle sum is a subtraction from 180, pi is a
 * ratio. NOTE: the arithmetic strand already owns the word "square" (the
 * operation, with its own drill), so no standalone square-shape concept is
 * declared here — squares appear inside the rectangle and rhombus
 * definitions instead, where they belong as the special case of both.
 *
 * Concepts with a `drill` key are checkable: verify.ts can generate an
 * unlimited supply of exercises for them and mark them exactly.
 */
export const GEOMETRY_CONCEPTS: readonly TechnicalConcept[] = [
  // ── Points, lines, angles ───────────────────────────────────────────────
  {
    word: 'point',
    definition: 'an exact location that has no size',
    example: 'The two roads cross at a single point.',
    strand: 'geometry',
    dependsOn: []
  },
  {
    word: 'line',
    definition: 'a straight path of points that goes on forever in both directions',
    example: 'The line through those two points never ends.',
    strand: 'geometry',
    dependsOn: ['point'],
    relations: [{ predicate: 'made-of', object: 'point' }]
  },
  {
    word: 'line segment',
    definition: 'a straight piece of a line with two endpoints',
    example: 'The edge of the ruler is a line segment 30 centimeters long.',
    strand: 'geometry',
    dependsOn: ['line', 'point'],
    relations: [
      { predicate: 'special-case-of', object: 'line' },
      { predicate: 'has-part', object: 'point' }
    ]
  },
  {
    word: 'ray',
    definition: 'a part of a line that starts at one point and goes on forever in one direction',
    example: 'A beam of light from a torch travels like a ray.',
    strand: 'geometry',
    dependsOn: ['line', 'point'],
    relations: [{ predicate: 'special-case-of', object: 'line' }]
  },
  {
    word: 'angle',
    definition: 'the opening between two rays that share an endpoint, measured in degrees',
    example: 'The hands of the clock make an angle of 90 degrees at three.',
    strand: 'geometry',
    dependsOn: ['ray', 'measurement'],
    relations: [{ predicate: 'has-part', object: 'ray' }]
  },
  {
    word: 'right angle',
    definition: 'an angle of exactly 90 degrees',
    example: 'The corner of a page is a right angle.',
    strand: 'geometry',
    dependsOn: ['angle'],
    relations: [{ predicate: 'special-case-of', object: 'angle' }]
  },
  {
    word: 'acute angle',
    definition: 'an angle smaller than a right angle',
    example: 'An angle of 30 degrees is an acute angle.',
    strand: 'geometry',
    dependsOn: ['right angle'],
    relations: [{ predicate: 'special-case-of', object: 'angle' }]
  },
  {
    word: 'obtuse angle',
    definition: 'an angle larger than a right angle but smaller than a straight angle',
    example: 'An angle of 120 degrees is an obtuse angle.',
    strand: 'geometry',
    dependsOn: ['right angle'],
    relations: [{ predicate: 'special-case-of', object: 'angle' }]
  },
  {
    word: 'straight angle',
    definition: 'an angle of exactly 180 degrees, whose rays form a straight line',
    example: 'An open book laid flat makes a straight angle.',
    strand: 'geometry',
    dependsOn: ['angle', 'line'],
    relations: [{ predicate: 'special-case-of', object: 'angle' }]
  },
  {
    word: 'parallel',
    definition: 'lines in the same plane that never meet, staying the same distance apart',
    example: 'The two rails of a train track are parallel.',
    strand: 'geometry',
    dependsOn: ['line'],
    relations: [{ predicate: 'has-property', object: 'line' }]
  },
  {
    word: 'perpendicular',
    definition: 'lines that meet at a right angle',
    example: 'The wall is perpendicular to the floor.',
    strand: 'geometry',
    dependsOn: ['line', 'right angle'],
    relations: [{ predicate: 'defined-as', object: 'right angle' }]
  },

  // ── Polygons ────────────────────────────────────────────────────────────
  {
    word: 'polygon',
    definition: 'a closed flat shape made of straight line segments',
    example: 'A stop sign is a polygon with eight sides.',
    strand: 'geometry',
    dependsOn: ['line segment'],
    relations: [
      { predicate: 'made-of', object: 'line segment' },
      { predicate: 'has-part', object: 'side' },
      { predicate: 'has-part', object: 'vertex' }
    ]
  },
  {
    word: 'side',
    definition: 'one of the line segments that form the boundary of a polygon',
    example: 'A triangle has three sides.',
    strand: 'geometry',
    dependsOn: ['polygon', 'line segment'],
    relations: [{ predicate: 'is-a', object: 'line segment' }]
  },
  {
    word: 'vertex',
    definition: 'a corner point where two sides of a shape meet',
    example: 'A triangle has a vertex at each of its three corners.',
    strand: 'geometry',
    dependsOn: ['polygon', 'point'],
    relations: [{ predicate: 'is-a', object: 'point' }]
  },
  {
    word: 'triangle',
    definition: 'a polygon with three sides, whose angles always add up to 180 degrees',
    example: 'A triangle with angles of 60, 60 and 60 degrees is possible.',
    strand: 'geometry',
    dependsOn: ['polygon', 'angle'],
    relations: [
      { predicate: 'special-case-of', object: 'polygon' },
      { predicate: 'has-part', object: 'side' },
      { predicate: 'has-part', object: 'vertex' }
    ],
    drill: 'triangle-angle-sum'
  },
  {
    word: 'equilateral triangle',
    definition: 'a triangle whose three sides are all equal',
    example: 'Every angle of an equilateral triangle is 60 degrees.',
    strand: 'geometry',
    dependsOn: ['triangle', 'equal'],
    relations: [{ predicate: 'special-case-of', object: 'triangle' }]
  },
  {
    word: 'isosceles triangle',
    definition: 'a triangle with at least two equal sides',
    example: 'An isosceles triangle has two equal base angles.',
    strand: 'geometry',
    dependsOn: ['triangle', 'equal'],
    relations: [{ predicate: 'special-case-of', object: 'triangle' }]
  },
  {
    word: 'right triangle',
    definition: 'a triangle with one right angle',
    example: 'A ladder against a wall forms a right triangle with the ground.',
    strand: 'geometry',
    dependsOn: ['triangle', 'right angle'],
    relations: [{ predicate: 'special-case-of', object: 'triangle' }]
  },
  {
    word: 'quadrilateral',
    definition: 'a polygon with four sides',
    example: 'A kite shape is a quadrilateral.',
    strand: 'geometry',
    dependsOn: ['polygon'],
    relations: [{ predicate: 'special-case-of', object: 'polygon' }]
  },
  {
    word: 'parallelogram',
    definition: 'a quadrilateral whose opposite sides are parallel and equal',
    example: 'A pushed-over rectangle drawn on paper is a parallelogram.',
    strand: 'geometry',
    dependsOn: ['quadrilateral', 'parallel', 'equal'],
    relations: [{ predicate: 'special-case-of', object: 'quadrilateral' }]
  },
  {
    word: 'rectangle',
    definition: 'a parallelogram with four right angles; one with four equal sides is a square shape',
    example: 'A door is shaped like a rectangle.',
    strand: 'geometry',
    dependsOn: ['parallelogram', 'right angle'],
    relations: [{ predicate: 'special-case-of', object: 'parallelogram' }]
  },
  {
    word: 'rhombus',
    definition: 'a parallelogram with four equal sides; one with right angles is a square shape',
    example: 'A diamond on a playing card is a rhombus.',
    strand: 'geometry',
    dependsOn: ['parallelogram', 'equal'],
    relations: [{ predicate: 'special-case-of', object: 'parallelogram' }]
  },
  {
    word: 'trapezoid',
    definition: 'a quadrilateral with exactly one pair of parallel sides',
    example: 'The side view of a bucket is a trapezoid.',
    strand: 'geometry',
    dependsOn: ['quadrilateral', 'parallel'],
    relations: [{ predicate: 'special-case-of', object: 'quadrilateral' }]
  },
  {
    word: 'pentagon',
    definition: 'a polygon with five sides',
    example: 'Home plate in baseball is a pentagon.',
    strand: 'geometry',
    dependsOn: ['polygon'],
    relations: [{ predicate: 'special-case-of', object: 'polygon' }]
  },
  {
    word: 'hexagon',
    definition: 'a polygon with six sides',
    example: 'Each cell of a honeycomb is a hexagon.',
    strand: 'geometry',
    dependsOn: ['polygon'],
    relations: [{ predicate: 'special-case-of', object: 'polygon' }]
  },
  {
    word: 'octagon',
    definition: 'a polygon with eight sides',
    example: 'A stop sign is an octagon.',
    strand: 'geometry',
    dependsOn: ['polygon'],
    relations: [{ predicate: 'special-case-of', object: 'polygon' }]
  },

  // ── Circles ─────────────────────────────────────────────────────────────
  {
    word: 'circle',
    definition: 'a closed curve of points that are all the same distance from a center point',
    example: 'The rim of a cup traces a circle.',
    strand: 'geometry',
    dependsOn: ['point', 'length'],
    relations: [
      { predicate: 'made-of', object: 'point' },
      { predicate: 'has-part', object: 'radius' },
      { predicate: 'has-part', object: 'diameter' }
    ]
  },
  {
    word: 'radius',
    definition: 'the distance from the center of a circle to any point on it',
    example: 'A circle with a radius of 3 meters is 6 meters across.',
    strand: 'geometry',
    dependsOn: ['circle', 'length'],
    relations: [{ predicate: 'defined-as', object: 'length' }]
  },
  {
    word: 'diameter',
    definition: 'the distance across a circle through its center, equal to twice the radius',
    example: 'A circle with a radius of 4 has a diameter of 8.',
    strand: 'geometry',
    dependsOn: ['radius', 'multiplication'],
    relations: [{ predicate: 'defined-as', object: 'radius' }],
    drill: 'circle-diameter'
  },
  {
    word: 'perimeter',
    definition: 'the total distance around the outside of a shape, found by adding its side lengths',
    example: 'A rectangle 3 meters by 4 meters has a perimeter of 14 meters.',
    strand: 'geometry',
    dependsOn: ['polygon', 'length', 'addition'],
    relations: [{ predicate: 'defined-as', object: 'addition' }],
    drill: 'perimeter-rectangle'
  },
  {
    word: 'circumference',
    definition: 'the perimeter of a circle',
    example: 'The circumference of the wheel is about 2 meters.',
    strand: 'geometry',
    dependsOn: ['circle', 'perimeter'],
    relations: [{ predicate: 'special-case-of', object: 'perimeter' }]
  },
  {
    word: 'pi',
    definition: 'the ratio of the circumference of any circle to its diameter, about 3.14',
    example: 'Dividing the circumference by the diameter always gives pi.',
    strand: 'geometry',
    dependsOn: ['circumference', 'diameter', 'ratio'],
    relations: [{ predicate: 'defined-as', object: 'ratio' }]
  },

  // ── Comparing and combining shapes ──────────────────────────────────────
  {
    word: 'congruent',
    definition: 'having exactly the same shape and size',
    example: 'The two puzzle pieces are congruent, so either fits the gap.',
    strand: 'geometry',
    dependsOn: ['polygon', 'equal'],
    relations: [{ predicate: 'defined-as', object: 'equal' }]
  },
  {
    word: 'similar',
    definition: 'having the same shape but not necessarily the same size',
    example: 'A photo and its enlargement are similar shapes.',
    strand: 'geometry',
    dependsOn: ['congruent', 'ratio'],
    relations: [{ predicate: 'defined-as', object: 'ratio' }]
  },
  {
    word: 'symmetry',
    definition: 'the property of a shape that matches itself when folded or turned',
    example: 'A butterfly has line symmetry down its middle.',
    strand: 'geometry',
    dependsOn: ['line', 'congruent'],
    relations: [{ predicate: 'has-property', object: 'congruent' }]
  },
  {
    word: 'angle sum',
    definition: 'the total of the angles inside a polygon, which is 180 degrees for a triangle',
    example: 'The angle sum of any quadrilateral is 360 degrees.',
    strand: 'geometry',
    dependsOn: ['triangle', 'angle', 'addition'],
    relations: [{ predicate: 'defined-as', object: 'addition' }]
  },
  {
    word: 'complementary angles',
    definition: 'two angles whose measures add up to 90 degrees',
    example: 'Angles of 30 and 60 degrees are complementary angles.',
    strand: 'geometry',
    dependsOn: ['angle', 'right angle', 'addition'],
    relations: [{ predicate: 'defined-as', object: 'right angle' }],
    drill: 'complementary-angle'
  },
  {
    word: 'supplementary angles',
    definition: 'two angles whose measures add up to 180 degrees',
    example: 'Angles of 110 and 70 degrees are supplementary angles.',
    strand: 'geometry',
    dependsOn: ['angle', 'straight angle', 'addition'],
    relations: [{ predicate: 'defined-as', object: 'straight angle' }],
    drill: 'supplementary-angle'
  },

  // ── The coordinate plane ────────────────────────────────────────────────
  {
    word: 'coordinate plane',
    definition: 'a flat surface with two perpendicular number lines used to locate points',
    example: 'The map grid works like a coordinate plane.',
    strand: 'geometry',
    dependsOn: ['line', 'perpendicular', 'number'],
    relations: [
      { predicate: 'has-part', object: 'axis' },
      { predicate: 'has-part', object: 'origin point' }
    ]
  },
  {
    word: 'axis',
    definition: 'one of the two number lines of a coordinate plane',
    example: 'The horizontal axis shows time and the vertical axis shows height.',
    strand: 'geometry',
    dependsOn: ['coordinate plane', 'line'],
    relations: [{ predicate: 'is-a', object: 'line' }]
  },
  {
    word: 'origin point',
    definition: 'the point where the two axes of a coordinate plane cross',
    example: 'The origin point of the grid is where both numbers are zero.',
    strand: 'geometry',
    dependsOn: ['axis', 'point', 'zero'],
    relations: [{ predicate: 'is-a', object: 'point' }]
  },
  {
    word: 'ordered pair',
    definition: 'two numbers written in order that name a point on a coordinate plane',
    example: 'The ordered pair 3 and 2 means three across and two up.',
    strand: 'geometry',
    dependsOn: ['coordinate plane', 'number', 'point'],
    relations: [{ predicate: 'symbol-for', object: 'point' }]
  }
];

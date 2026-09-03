import type { AuthoredRelation, TechnicalConcept, TechnicalStrand } from './types';

type ScienceRow = readonly [
  word: string,
  definition: string,
  example: string,
  dependsOn?: readonly string[],
  relations?: readonly AuthoredRelation[]
];

const isA = (object: string): AuthoredRelation => ({ predicate: 'is-a', object });
const hasPart = (object: string): AuthoredRelation => ({ predicate: 'has-part', object });
const madeOf = (object: string): AuthoredRelation => ({ predicate: 'made-of', object });

function strand(strandName: TechnicalStrand, rows: readonly ScienceRow[]): TechnicalConcept[] {
  return rows.map(([word, definition, example, dependsOn = [], relations]) => ({
    word,
    definition,
    example,
    strand: strandName,
    dependsOn,
    relations
  }));
}

const SCIENTIFIC_PRACTICE = strand('scientific-practice', [
  ['science', 'the systematic study of the natural world using evidence and testable explanations', 'Science uses evidence to explain why objects fall.'],
  ['observation', 'information gathered by carefully noticing or measuring something', 'The color change was an observation.', ['science']],
  ['evidence', 'observations or measurements used to support or challenge an explanation', 'Repeated temperature readings provided evidence.', ['observation']],
  ['scientific question', 'a question about the natural world that evidence can help answer', 'Does light affect plant growth is a scientific question.', ['observation']],
  ['hypothesis', 'a testable proposed explanation for an observation', 'The hypothesis predicted that more light would increase growth.', ['scientific question', 'evidence']],
  ['prediction', 'a specific expected result that follows from a hypothesis', 'The prediction said the sunlit plant would grow taller.', ['hypothesis']],
  ['experimental variable', 'a factor that can change in an investigation', 'Temperature was an experimental variable.', ['measurement']],
  ['independent variable', 'the variable deliberately changed by an investigator', 'Light exposure was the independent variable.', ['experimental variable'], [isA('variable')]],
  ['dependent variable', 'the variable measured as the outcome of an investigation', 'Plant height was the dependent variable.', ['experimental variable'], [isA('variable')]],
  ['controlled variable', 'a variable kept constant so it cannot explain the result', 'Both plants received the same water as a controlled variable.', ['experimental variable'], [isA('variable')]],
  ['experiment', 'a controlled investigation that tests a hypothesis', 'The experiment compared plants grown with different light.', ['hypothesis', 'experimental variable']],
  ['control group', 'the comparison group that does not receive the tested treatment', 'The untreated plants formed the control group.', ['experiment']],
  ['data', 'recorded observations and measurements from an investigation', 'The data included daily plant heights.', ['evidence', 'measurement']],
  ['qualitative data', 'descriptive data about qualities that are not expressed as numbers', 'Leaf color was qualitative data.', ['data'], [isA('data')]],
  ['quantitative data', 'data expressed as numbers and units', 'A height of 12 centimeters was quantitative data.', ['data', 'number', 'unit'], [isA('data')]],
  ['scientific model', 'a simplified representation used to explain or predict a system', 'A globe is a scientific model of Earth.', ['evidence']],
  ['scientific theory', 'a broad explanation supported by many independent lines of evidence', 'Cell theory explains that living things are made of cells.', ['evidence', 'scientific model']],
  ['scientific law', 'a concise description of a consistently observed pattern in nature', 'A scientific law describes what happens under stated conditions.', ['evidence']],
  ['replication', 'repeating an investigation independently to test whether its result is reliable', 'Another laboratory performed a replication of the experiment.', ['experiment', 'evidence']],
  ['peer review', 'evaluation of scientific work by other experts before publication', 'Peer review found a flaw in the experimental design.', ['evidence', 'replication']],
  ['uncertainty', 'the estimated range within which a measured value is likely to lie', 'The length was reported with an uncertainty of one millimeter.', ['measurement', 'precision']]
]);

const PHYSICS = strand('physics', [
  ['matter', 'anything that has mass and occupies space', 'Air is matter because it has mass and volume.', ['mass', 'volume']],
  ['particle', 'a very small localized piece of matter or energy', 'An electron is a particle.', ['matter'], [isA('matter')]],
  ['motion', 'a change in position over time relative to a reference point', 'The rolling ball was in motion.', ['length', 'time']],
  ['reference frame', 'a coordinate system relative to which position and motion are measured', 'A passenger is still in the train reference frame.', ['motion', 'measurement']],
  ['inertia', 'the tendency of matter to resist a change in its motion', 'A seat belt protects a passenger because of inertia.', ['matter', 'motion', 'mass']],
  ['net force', 'the vector sum of all forces acting on an object', 'Balanced pushes give a net force of zero.', ['force', 'addition']],
  ['newton first law', 'an object keeps its state of motion unless acted on by a net force', 'A puck keeps sliding when the net force is nearly zero.', ['inertia', 'net force'], [isA('scientific law')]],
  ['newton second law', "the rule that an object's acceleration equals its net force divided by its mass", 'More net force gives the same cart more acceleration.', ['net force', 'mass', 'acceleration', 'division'], [isA('scientific law')]],
  ['newton third law', 'every force on one object has an equal and opposite force on another object', 'The rocket pushes gas backward and the gas pushes the rocket forward.', ['force'], [isA('scientific law')]],
  ['gravity', 'the attractive force between objects that have mass', 'Earth gravity pulls an apple downward.', ['force', 'mass']],
  ['weight', 'the force of gravity acting on an object', 'An astronaut has less weight on the Moon.', ['gravity', 'mass'], [{ predicate: 'defined-as', object: 'gravity' }, { predicate: 'measured-in', object: 'newton' }]],
  ['momentum', 'mass multiplied by velocity', 'A fast heavy truck has large momentum.', ['mass', 'velocity', 'multiplication']],
  ['impulse', 'force multiplied by the time for which it acts, equal to the change in momentum', 'An airbag increases stopping time and reduces force for the same impulse.', ['force', 'time', 'momentum', 'multiplication']],
  ['work', 'energy transferred when a force moves an object through a distance', 'Lifting a box does work against gravity.', ['force', 'length', 'energy'], [{ predicate: 'measured-in', object: 'joule' }]],
  ['kinetic energy', 'the energy an object has because of its motion', 'A moving bicycle has kinetic energy.', ['energy', 'motion', 'mass', 'velocity'], [isA('energy')]],
  ['potential energy', 'stored energy due to position or arrangement', 'A raised book has gravitational potential energy.', ['energy'], [isA('energy')]],
  ['mechanical energy', 'the sum of kinetic energy and potential energy in a system', 'A swinging pendulum exchanges forms of mechanical energy.', ['kinetic energy', 'potential energy', 'addition'], [isA('energy')]],
  ['conservation of energy', 'energy cannot be created or destroyed but can be transferred or transformed', 'A falling ball changes potential energy into kinetic energy.', ['energy', 'scientific law'], [isA('scientific law')]],
  ['wave', 'a repeating disturbance that transfers energy without transporting matter overall', 'A water wave carries energy across a pond.', ['energy', 'motion', 'frequency']],
  ['amplitude', 'the maximum displacement of a wave from its rest position', 'A louder sound wave has greater amplitude.', ['wave', 'measurement']],
  ['wavelength', 'the distance between corresponding points on successive wave cycles', 'The distance from crest to crest is one wavelength.', ['wave', 'length']],
  ['electromagnetic wave', 'a wave of oscillating electric and magnetic fields that can travel through a vacuum', 'Visible light is an electromagnetic wave.', ['wave'], [isA('wave')]],
  ['light', 'electromagnetic radiation visible to the human eye', 'Light from the Sun reaches Earth through space.', ['electromagnetic wave'], [isA('electromagnetic wave')]],
  ['photon', 'a discrete particle of electromagnetic energy', 'A photon can be absorbed by an atom.', ['particle', 'light'], [isA('particle')]],
  ['reflection', 'the change in direction when a wave returns from a boundary', 'A mirror produces reflection of light.', ['wave', 'light']],
  ['refraction', 'the change in direction and speed of a wave entering a different medium', 'Refraction makes a straw appear bent in water.', ['wave', 'speed']],
  ['sound', 'a mechanical wave produced by vibrations and carried through matter', 'Sound travels through air but not through empty space.', ['wave', 'matter'], [isA('wave')]],
  ['electric charge', 'a property of matter that causes electric attraction or repulsion', 'Electrons carry negative electric charge.', ['matter', 'force']],
  ['electric current', 'the rate at which electric charge flows', 'Electric current flows through the wire.', ['electric charge', 'time', 'division']],
  ['voltage', 'electric potential energy transferred per unit of charge', 'A battery provides voltage to a circuit.', ['energy', 'electric charge', 'division']],
  ['resistance', 'opposition to the flow of electric current', 'A thin wire usually has more resistance.', ['electric current', 'voltage']],
  ['electric circuit', 'a closed path through which electric current can flow', 'Closing the switch completes the electric circuit.', ['electric current'], [hasPart('conductor')]],
  ['conductor', 'a material in which electric charge can move readily', 'Copper is a good conductor.', ['matter', 'electric current'], [isA('matter')]],
  ['insulator', 'a material in which electric charge does not move readily', 'Rubber is an electrical insulator.', ['matter', 'electric current'], [isA('matter')]],
  ['magnet', 'an object that produces a magnetic field', 'A magnet attracts an iron nail.', ['matter', 'force']],
  ['magnetic field', 'a region in which magnetic forces act on magnets or moving charges', 'Iron filings reveal a magnetic field around a magnet.', ['magnet', 'force', 'electric charge']]
]);

const CHEMISTRY = strand('chemistry', [
  ['atom', 'the smallest unit of an element that retains its chemical identity', 'A helium atom has two protons.', ['matter', 'particle'], [isA('particle')]],
  ['atomic nucleus', 'the dense central part of an atom containing protons and neutrons', 'Nearly all atomic mass is in the atomic nucleus.', ['atom'], [hasPart('proton'), hasPart('neutron')]],
  ['proton', 'a positively charged particle in an atomic nucleus', 'The number of protons identifies an element.', ['atomic nucleus', 'electric charge'], [isA('particle')]],
  ['neutron', 'an electrically neutral particle in an atomic nucleus', 'Carbon twelve has six neutrons.', ['atomic nucleus'], [isA('particle')]],
  ['electron', 'a negatively charged particle found around an atomic nucleus', 'An electron has much less mass than a proton.', ['atom', 'electric charge'], [isA('particle')]],
  ['atomic number', 'the number of protons in the nucleus of an atom', 'Carbon has atomic number six.', ['proton', 'atom', 'counting']],
  ['isotope', 'an atom of an element with a particular number of neutrons', 'Carbon fourteen is an isotope of carbon.', ['atom', 'element', 'neutron'], [isA('atom')]],
  ['ion', 'an atom or molecule with a net electric charge from gaining or losing electrons', 'A sodium ion has lost one electron.', ['atom', 'electron', 'electric charge'], [isA('particle')]],
  ['element', 'a pure substance made of atoms with the same atomic number', 'Gold is an element with atomic number 79.', ['atom', 'atomic number'], [isA('matter'), madeOf('atom')]],
  ['periodic table', 'an arrangement of elements by atomic number that reveals repeating properties', 'Elements in one column of the periodic table have related properties.', ['element', 'atomic number']],
  ['periodic group', 'a vertical column of elements in the periodic table', 'The noble gases form a periodic group.', ['periodic table']],
  ['periodic period', 'a horizontal row of elements in the periodic table', 'Sodium and chlorine are in the same periodic period.', ['periodic table']],
  ['valence electron', 'an electron in the outermost occupied energy level of an atom', 'Valence electrons take part in chemical bonds.', ['electron', 'atom']],
  ['chemical bond', 'an attraction that holds atoms or ions together', 'A chemical bond joins the atoms in water.', ['atom', 'electric charge']],
  ['ionic bond', 'a chemical bond caused by attraction between oppositely charged ions', 'Sodium chloride contains an ionic bond.', ['chemical bond', 'ion'], [isA('chemical bond')]],
  ['covalent bond', 'a chemical bond formed when atoms share electrons', 'The atoms in a water molecule have covalent bonds.', ['chemical bond', 'electron'], [isA('chemical bond')]],
  ['molecule', 'two or more atoms held together by chemical bonds', 'A water molecule contains two hydrogen atoms and one oxygen atom.', ['atom', 'chemical bond'], [madeOf('atom')]],
  ['compound', 'a pure substance containing two or more elements chemically bonded in fixed proportions', 'Water is a compound of hydrogen and oxygen.', ['element', 'chemical bond'], [isA('matter'), madeOf('element')]],
  ['mixture', 'matter containing substances physically combined in variable proportions', 'Air is a mixture of gases.', ['matter']],
  ['homogeneous mixture', 'a mixture with uniform composition throughout', 'Air is a homogeneous mixture.', ['mixture'], [isA('mixture')]],
  ['heterogeneous mixture', 'a mixture whose composition is not uniform throughout', 'Granite is a heterogeneous mixture.', ['mixture'], [isA('mixture')]],
  ['solution', 'a homogeneous mixture in which one substance is dissolved in another', 'Salt water is a solution.', ['homogeneous mixture'], [isA('homogeneous mixture')]],
  ['solute', 'the substance dissolved in a solution', 'Salt is the solute in salt water.', ['solution']],
  ['solvent', 'the substance that dissolves a solute to form a solution', 'Water is the solvent in salt water.', ['solution']],
  ['state of matter', 'a physical form of matter determined by particle arrangement and energy', 'Solid is a state of matter.', ['matter', 'particle', 'energy']],
  ['solid', 'a state of matter with fixed shape and fixed volume', 'Ice is solid water.', ['state of matter', 'volume'], [isA('state of matter')]],
  ['liquid', 'a state of matter with fixed volume but no fixed shape', 'Liquid water takes the shape of its container.', ['state of matter', 'volume'], [isA('state of matter')]],
  ['gas', 'a state of matter with neither fixed shape nor fixed volume', 'Water vapor is a gas.', ['state of matter', 'volume'], [isA('state of matter')]],
  ['plasma', 'an ionized state of matter containing freely moving charged particles', 'The Sun contains plasma.', ['state of matter', 'ion'], [isA('state of matter')]],
  ['phase change', 'a physical change from one state of matter to another', 'Melting ice is a phase change.', ['state of matter', 'energy']],
  ['melting', 'the phase change from solid to liquid', 'Ice melting produces liquid water.', ['phase change', 'solid', 'liquid'], [isA('phase change')]],
  ['freezing', 'the phase change from liquid to solid', 'Water freezing produces ice.', ['phase change', 'solid', 'liquid'], [isA('phase change')]],
  ['evaporation', 'the phase change from liquid to gas at a surface', 'Evaporation removes water from a puddle.', ['phase change', 'liquid', 'gas'], [isA('phase change')]],
  ['condensation', 'the phase change from gas to liquid', 'Condensation forms droplets on a cold glass.', ['phase change', 'liquid', 'gas'], [isA('phase change')]],
  ['sublimation', 'the phase change directly from solid to gas', 'Dry ice undergoes sublimation.', ['phase change', 'solid', 'gas'], [isA('phase change')]],
  ['chemical reaction', 'a process that rearranges atoms by breaking and forming chemical bonds', 'Burning methane is a chemical reaction.', ['atom', 'chemical bond']],
  ['reactant', 'a starting substance consumed or changed in a chemical reaction', 'Hydrogen is a reactant when water forms.', ['chemical reaction']],
  ['product substance', 'a substance formed by a chemical reaction', 'Water is a product substance of hydrogen combustion.', ['chemical reaction']],
  ['conservation of mass', 'matter is not created or destroyed in an ordinary chemical reaction', 'A closed reaction has equal total reactant and product mass.', ['chemical reaction', 'mass', 'scientific law'], [isA('scientific law')]],
  ['acid', 'a substance that donates hydrogen ions or increases their concentration in water', 'Hydrochloric acid donates hydrogen ions.', ['ion', 'solution']],
  ['base substance', 'a substance that accepts hydrogen ions or decreases their concentration in water', 'A base substance can neutralize an acid.', ['ion', 'solution']],
  ['ph scale', 'a logarithmic scale describing how acidic or basic a water solution is', 'Pure water has a ph scale value near seven.', ['acid', 'base substance', 'solution']],
  ['catalyst', 'a substance that increases reaction rate without being consumed overall', 'An enzyme is a biological catalyst.', ['chemical reaction', 'time']]
]);

const BIOLOGY = strand('biology', [
  ['organism', 'an individual living thing', 'A bacterium and a tree are each an organism.', ['science']],
  ['cell', 'the smallest structural and functional unit of life', 'A bacterium consists of one cell.', ['organism', 'matter'], [isA('matter'), hasPart('cell membrane'), hasPart('cytoplasm')]],
  ['cell theory', 'the theory that organisms are made of cells, cells are the basic unit of life, and cells come from cells', 'Cell theory unifies observations of living things.', ['cell', 'scientific theory'], [isA('scientific theory')]],
  ['cell membrane', 'a selectively permeable boundary controlling movement into and out of a cell', 'The cell membrane regulates water and ions.', ['cell']],
  ['cytoplasm', 'the material inside a cell membrane but outside the cell nucleus', 'Many reactions occur in the cytoplasm.', ['cell', 'cell membrane']],
  ['organelle', 'a specialized structure that performs a function inside a cell', 'A mitochondrion is an organelle.', ['cell']],
  ['cell nucleus', 'a membrane-bound organelle containing most genetic material in a eukaryotic cell', 'The cell nucleus contains chromosomes.', ['organelle', 'cell'], [isA('organelle'), hasPart('chromosome')]],
  ['mitochondrion', 'an organelle that releases usable energy through cellular respiration', 'A muscle cell contains many mitochondria.', ['organelle', 'energy'], [isA('organelle')]],
  ['chloroplast', 'an organelle in plants and algae that carries out photosynthesis', 'Chloroplasts contain chlorophyll.', ['organelle', 'light'], [isA('organelle')]],
  ['ribosome', 'a cell structure that builds proteins from amino acids', 'A ribosome reads messenger RNA to build a protein.', ['cell', 'protein']],
  ['dna', 'the molecule that stores hereditary information in living organisms', 'DNA contains the instructions for building proteins.', ['molecule', 'organism'], [hasPart('gene')]],
  ['gene', 'a region of DNA that contributes to a functional product or inherited trait', 'One gene can encode a protein.', ['dna']],
  ['chromosome', 'a packaged DNA molecule containing many genes', 'Humans usually have 46 chromosomes in body cells.', ['dna', 'gene'], [madeOf('dna'), hasPart('gene')]],
  ['heredity', 'the transmission of biological traits from parents to offspring', 'DNA is central to heredity.', ['gene', 'organism']],
  ['protein', 'a folded chain of amino acids that performs structural or functional roles in cells', 'Hemoglobin is a protein that carries oxygen.', ['cell', 'molecule']],
  ['enzyme', 'a biological catalyst, usually a protein, that speeds a specific reaction', 'Amylase is an enzyme that breaks down starch.', ['protein', 'catalyst'], [isA('catalyst')]],
  ['photosynthesis', 'the process that uses light energy to make sugars from carbon dioxide and water', 'Plants perform photosynthesis in chloroplasts.', ['chloroplast', 'light', 'energy', 'chemical reaction']],
  ['cellular respiration', 'the process that releases usable energy from food molecules', 'Cells use cellular respiration to make ATP.', ['mitochondrion', 'energy', 'chemical reaction']],
  ['homeostasis', 'maintenance of stable internal conditions despite external change', 'Sweating helps maintain temperature homeostasis.', ['organism', 'temperature']],
  ['tissue', 'a group of similar cells working together', 'Muscle tissue contracts to produce movement.', ['cell'], [madeOf('cell')]],
  ['organ', 'a structure made of multiple tissues working together', 'The heart is an organ.', ['tissue'], [madeOf('tissue')]],
  ['organ system', 'a group of organs working together to perform major functions', 'The digestive system is an organ system.', ['organ'], [madeOf('organ')]],
  ['unicellular organism', 'an organism consisting of one cell', 'A bacterium is a unicellular organism.', ['organism', 'cell'], [isA('organism')]],
  ['multicellular organism', 'an organism consisting of many specialized cells', 'A human is a multicellular organism.', ['organism', 'cell', 'tissue'], [isA('organism')]],
  ['prokaryote', 'an organism whose cell lacks a membrane-bound nucleus', 'A bacterium is a prokaryote.', ['unicellular organism', 'cell nucleus'], [isA('organism')]],
  ['eukaryote', 'an organism whose cells contain a membrane-bound nucleus', 'Animals and plants are eukaryotes.', ['organism', 'cell nucleus'], [isA('organism')]],
  ['bacterium', 'a unicellular prokaryotic organism', 'Escherichia coli is a bacterium.', ['prokaryote'], [isA('prokaryote')]],
  ['species', 'a group of organisms that can reproduce together and produce fertile offspring', 'All living humans belong to one species.', ['organism', 'reproduction']],
  ['population', 'members of one species living in the same area at the same time', 'All oak trees in a forest form a population.', ['species']],
  ['community', 'all populations of different species interacting in an area', 'Plants, animals, and microbes form a community.', ['population']],
  ['ecosystem', 'a community of organisms interacting with its physical environment', 'A pond is an ecosystem.', ['community', 'matter', 'energy']],
  ['habitat', 'the physical place where an organism lives', 'A pond is a frog habitat.', ['organism', 'ecosystem']],
  ['ecological niche', 'the role of a species and its use of resources in an ecosystem', 'A bee pollinator has an ecological niche.', ['species', 'ecosystem']],
  ['producer', 'an organism that makes organic food from nonliving sources of energy', 'Grass is a producer.', ['organism', 'photosynthesis'], [isA('organism')]],
  ['consumer', 'an organism that obtains energy by eating other organisms', 'A rabbit is a consumer.', ['organism', 'energy'], [isA('organism')]],
  ['decomposer', 'an organism that breaks down dead matter and recycles nutrients', 'Fungi act as decomposers in a forest.', ['organism', 'matter'], [isA('organism')]],
  ['food chain', 'a sequence showing how energy passes as one organism eats another', 'Grass to rabbit to fox is a food chain.', ['producer', 'consumer', 'energy']],
  ['food web', 'a network of interconnected food chains in an ecosystem', 'A food web shows many feeding relationships.', ['food chain', 'ecosystem']],
  ['trophic level', 'a feeding position in a food chain or food web', 'Producers occupy the first trophic level.', ['food chain', 'food web']],
  ['biodiversity', 'the variety of genes, species, and ecosystems in a region or on Earth', 'A tropical forest has high biodiversity.', ['gene', 'species', 'ecosystem']],
  ['adaptation', 'an inherited trait that improves survival or reproduction in an environment', 'Camouflage can be an adaptation.', ['heredity', 'organism', 'habitat']],
  ['natural selection', 'the process by which inherited traits affecting reproductive success change in frequency', 'Natural selection can make helpful adaptations more common.', ['adaptation', 'heredity', 'population']],
  ['evolution', 'change in inherited characteristics of populations across generations', 'Evolution explains the diversity of species.', ['natural selection', 'heredity', 'population']],
  ['mutation', 'a change in the nucleotide sequence of DNA', 'A mutation can create a new gene variant.', ['dna', 'gene']],
  ['reproduction', 'the biological process by which organisms produce offspring', 'Reproduction continues a species.', ['organism', 'heredity']],
  ['asexual reproduction', 'reproduction involving one parent without fusion of sex cells', 'Binary fission is asexual reproduction.', ['reproduction'], [isA('reproduction')]],
  ['sexual reproduction', 'reproduction involving fusion of genetic material from sex cells', 'Sexual reproduction combines genes from two parents.', ['reproduction', 'gene'], [isA('reproduction')]]
]);

const EARTH_SCIENCE = strand('earth-science', [
  ['earth system', 'the interacting physical and biological components of planet Earth', 'Climate emerges from interactions in the Earth system.', ['scientific model', 'planet'], [hasPart('geosphere'), hasPart('hydrosphere'), hasPart('atmosphere'), hasPart('biosphere')]],
  ['geosphere', 'the solid rocky part of Earth from crust to core', 'Mountains are part of the geosphere.', ['earth system', 'matter']],
  ['hydrosphere', 'all liquid and frozen water on or near Earth', 'Oceans contain most of the hydrosphere.', ['earth system', 'liquid']],
  ['atmosphere', 'the layers of gas surrounding a planet', 'Earth atmosphere contains nitrogen and oxygen.', ['earth system', 'gas']],
  ['biosphere', 'all regions of Earth where life exists', 'The biosphere includes organisms in oceans and soil.', ['earth system', 'organism']],
  ['mineral', 'a naturally occurring inorganic solid with a definite composition and crystal structure', 'Quartz is a mineral.', ['solid', 'element', 'compound']],
  ['rock', 'a naturally formed solid aggregate of one or more minerals', 'Granite is a rock made of several minerals.', ['mineral'], [madeOf('mineral')]],
  ['igneous rock', 'rock formed when molten material cools and solidifies', 'Basalt is an igneous rock.', ['rock', 'solid'], [isA('rock')]],
  ['sedimentary rock', 'rock formed from compacted sediment or chemical and biological deposits', 'Sandstone is a sedimentary rock.', ['rock', 'deposition'], [isA('rock')]],
  ['metamorphic rock', 'rock changed by heat, pressure, or chemical fluids without fully melting', 'Marble is a metamorphic rock.', ['rock', 'temperature', 'pressure'], [isA('rock')]],
  ['weathering', 'the breakdown of rock at or near Earth surface', 'Freezing water causes mechanical weathering.', ['rock']],
  ['erosion', 'the transport of weathered material by water, wind, ice, or gravity', 'A river causes erosion by carrying sediment.', ['weathering', 'motion']],
  ['deposition', 'the settling and accumulation of transported sediment', 'A river delta forms by deposition.', ['erosion', 'gravity']],
  ['rock cycle', 'the processes that transform rocks among igneous, sedimentary, and metamorphic forms', 'Melting and cooling are parts of the rock cycle.', ['igneous rock', 'sedimentary rock', 'metamorphic rock']],
  ['soil', 'a mixture of weathered mineral particles, organic matter, water, air, and organisms', 'Plant roots grow in soil.', ['weathering', 'mixture', 'organism']],
  ['earth crust', 'the thin outermost solid layer of Earth', 'Continental crust is thicker than oceanic crust.', ['geosphere']],
  ['earth mantle', 'the thick layer of hot rock between Earth crust and core', 'Slow mantle motion drives plate tectonics.', ['geosphere']],
  ['earth core', 'the dense central region of Earth composed mainly of iron and nickel', 'Motion in the outer core helps create Earth magnetic field.', ['geosphere'], [madeOf('element')]],
  ['tectonic plate', 'a rigid piece of lithosphere moving over the softer mantle', 'The Pacific plate is a tectonic plate.', ['earth crust', 'earth mantle']],
  ['plate tectonics', 'the theory that Earth outer shell consists of moving tectonic plates', 'Plate tectonics explains many earthquakes and volcanoes.', ['tectonic plate', 'scientific theory'], [isA('scientific theory')]],
  ['earthquake', 'ground shaking caused by sudden energy release when rocks slip', 'An earthquake can occur at a plate boundary.', ['tectonic plate', 'energy', 'wave']],
  ['volcano', 'an opening where molten rock, gas, and ash reach a planetary surface', 'Lava erupted from the volcano.', ['tectonic plate', 'rock', 'gas']],
  ['water cycle', 'the continuous movement of water through atmosphere, land, oceans, and organisms', 'Evaporation and precipitation are parts of the water cycle.', ['hydrosphere', 'atmosphere', 'evaporation', 'condensation']],
  ['precipitation', 'water that falls from the atmosphere as rain, snow, sleet, or hail', 'Rain is liquid precipitation.', ['water cycle', 'atmosphere']],
  ['transpiration', 'release of water vapor from plants into the atmosphere', 'Leaf transpiration contributes to the water cycle.', ['water cycle', 'organism', 'gas']],
  ['weather', 'short-term conditions of the atmosphere at a place and time', 'Today weather is cool and rainy.', ['atmosphere', 'temperature', 'pressure']],
  ['climate', 'the long-term statistical pattern of weather in a region', 'A desert climate is usually dry.', ['weather', 'data']],
  ['greenhouse effect', 'warming caused when atmospheric gases absorb and reemit outgoing infrared radiation', 'The natural greenhouse effect keeps Earth warm enough for liquid water.', ['atmosphere', 'energy', 'electromagnetic wave']],
  ['climate change', 'a persistent change in climate patterns over decades or longer', 'Increasing greenhouse gases drive current climate change.', ['climate', 'greenhouse effect']],
  ['carbon cycle', 'the movement of carbon among atmosphere, organisms, oceans, and rocks', 'Photosynthesis transfers carbon from air into organisms.', ['element', 'atmosphere', 'biosphere', 'hydrosphere', 'geosphere']],
  ['ocean current', 'a persistent directed movement of ocean water', 'Ocean currents transport heat around Earth.', ['hydrosphere', 'motion', 'energy']],
  ['renewable resource', 'a natural resource replenished on a human timescale', 'Sunlight is a renewable resource.', ['earth system', 'energy']],
  ['nonrenewable resource', 'a natural resource consumed much faster than natural processes replace it', 'Coal is a nonrenewable resource.', ['earth system', 'energy']]
]);

const ASTRONOMY = strand('astronomy', [
  ['universe', 'all space, time, matter, and energy', 'The observable universe contains billions of galaxies.', ['matter', 'energy', 'time']],
  ['galaxy', 'a gravitationally bound system of stars, gas, dust, and dark matter', 'The Milky Way is a galaxy.', ['universe', 'gravity', 'star'], [hasPart('star')]],
  ['milky way', 'the galaxy containing the solar system', 'The Sun orbits within the Milky Way.', ['galaxy'], [isA('galaxy')]],
  ['star', 'a luminous sphere of plasma powered mainly by nuclear fusion', 'The Sun is a star.', ['plasma', 'gravity', 'nuclear fusion'], [isA('matter')]],
  ['nuclear fusion', 'a reaction in which light atomic nuclei combine and release energy', 'Nuclear fusion converts hydrogen into helium in the Sun.', ['atomic nucleus', 'chemical reaction', 'energy']],
  ['solar system', 'the Sun and all objects gravitationally bound in orbit around it', 'Earth belongs to the solar system.', ['star', 'gravity', 'orbit'], [hasPart('planet')]],
  ['planet', 'a large nearly round body orbiting a star that dominates its orbital neighborhood', 'Earth is a planet orbiting the Sun.', ['star', 'orbit', 'gravity'], [isA('matter')]],
  ['dwarf planet', 'a nearly round body orbiting a star that has not cleared its orbital neighborhood and is not a moon', 'Pluto is a dwarf planet.', ['planet', 'orbit'], [isA('matter')]],
  ['moon', 'a natural satellite orbiting a planet or other small body', 'The Moon orbits Earth.', ['planet', 'orbit'], [isA('matter')]],
  ['orbit', 'a curved path produced by motion under gravity around another body', 'Earth orbit around the Sun is nearly elliptical.', ['motion', 'gravity']],
  ['rotation', 'spinning of an object around its own axis', 'Earth rotation produces day and night.', ['motion']],
  ['revolution', 'one complete orbital journey around another body', 'Earth completes one revolution around the Sun each year.', ['orbit']],
  ['asteroid', 'a small rocky or metallic body orbiting the Sun', 'Most known asteroids orbit between Mars and Jupiter.', ['solar system', 'rock', 'orbit'], [isA('matter')]],
  ['comet', 'a small icy body that releases gas and dust when heated near a star', 'A comet can develop a bright tail near the Sun.', ['solar system', 'solid', 'orbit'], [isA('matter')]],
  ['meteoroid', 'a small natural solid body moving through space', 'A meteoroid may be a fragment of an asteroid.', ['solar system', 'rock'], [isA('matter')]],
  ['meteor', 'the streak of light produced when a meteoroid enters an atmosphere', 'A bright meteor crossed the night sky.', ['meteoroid', 'atmosphere', 'light']],
  ['meteorite', 'a fragment of a meteoroid that reaches the ground', 'Scientists recovered a meteorite from the crater.', ['meteoroid', 'rock'], [isA('rock')]],
  ['nebula', 'an interstellar cloud of gas and dust', 'Stars can form inside a cold nebula.', ['galaxy', 'gas']],
  ['luminosity', 'the total power radiated by an astronomical object', 'A giant star has high luminosity.', ['power', 'star']],
  ['apparent magnitude', 'a logarithmic measure of how bright an astronomical object appears from Earth', 'A smaller apparent magnitude means a brighter object.', ['light', 'measurement', 'star']],
  ['light year', 'the distance light travels through a vacuum in one year', 'The nearest star is about four light years away.', ['light', 'speed', 'time', 'length'], [isA('unit')]],
  ['astronomical unit', 'the average distance from Earth to the Sun', 'Earth is one astronomical unit from the Sun.', ['length', 'planet', 'star'], [isA('unit')]],
  ['red giant', 'a large luminous late stage of a low or intermediate mass star', 'The Sun will eventually become a red giant.', ['star', 'nuclear fusion'], [isA('star')]],
  ['white dwarf', 'a dense stellar remnant left after a low or intermediate mass star sheds its outer layers', 'A white dwarf is about Earth sized.', ['star', 'matter'], [isA('star')]],
  ['supernova', 'a powerful stellar explosion that ejects matter and releases enormous energy', 'A supernova can briefly outshine a galaxy.', ['star', 'energy']],
  ['neutron star', 'an extremely dense stellar remnant composed mainly of neutrons', 'A neutron star can rotate many times per second.', ['star', 'neutron'], [isA('star'), madeOf('neutron')]],
  ['black hole', 'a region of spacetime whose gravity is strong enough that light cannot escape', 'A massive star can collapse into a black hole.', ['gravity', 'light', 'star']],
  ['constellation', 'a recognized pattern or defined region of stars in the sky', 'Orion is a constellation.', ['star']],
  ['exoplanet', 'a planet orbiting a star outside the solar system', 'Astronomers found an exoplanet by measuring its star.', ['planet', 'solar system'], [isA('planet')]],
  ['habitable zone', 'the range of distances from a star where liquid water could exist on a suitable planet', 'Earth orbits within the Sun habitable zone.', ['star', 'planet', 'liquid']],
  ['big bang', 'the scientific model that the universe expanded from an early hot dense state', 'The big bang model explains cosmic expansion and background radiation.', ['universe', 'scientific model'], [isA('scientific model')]]
]);

/**
 * PHYSICS, ADVANCED — thermodynamics, electric fields, quantum physics, and
 * relativity. Deliberately appended AFTER every other strand so its rows may
 * depend on any earlier concept (chemistry's atom/electron/neutron, the
 * astronomy strands, the measurement units). Definitions are learner-English
 * and every stated claim is physics-stable: classical-mechanics statements
 * hold at everyday scales, quantum rows describe what measurements show
 * rather than interpretive baggage, and the relativity rows say only what
 * the theory asserts about measured time and space.
 */
const PHYSICS_ADVANCED = strand('physics', [
  ['physics', 'the study of matter, energy, and their interactions', 'Physics explains why a ball falls and why a magnet sticks.', ['science'], [isA('science')]],
  ['classical mechanics', 'the physics of everyday objects, described by the newton laws', 'A bicycle moves according to classical mechanics.', ['physics', 'motion', 'force', 'newton first law'], [isA('physics')]],
  ['friction', 'a force that opposes the sliding of one surface over another', 'Friction slows a sliding book and warms your hands.', ['force', 'motion']],
  // ── Thermodynamics ──────────────────────────────────────────────────────
  ['heat', 'energy that flows from a hotter object or region to a colder one', 'Heat flows from the warm mug into the colder room.', ['energy', 'temperature']],
  ['thermal energy', 'the energy an object has because its particles are moving', 'A warm cup has more thermal energy than a cold one.', ['heat', 'energy'], [isA('energy')]],
  ['conduction', 'the transfer of heat through a material by the contact of its particles', 'Conduction warms a metal spoon handle in hot soup.', ['heat', 'particle', 'conductor']],
  ['convection', 'the transfer of heat by the motion of a fluid such as air or water', 'Convection carries warm air upward from a heater.', ['heat', 'motion', 'matter']],
  ['thermal radiation', 'energy carried away from a warm object as electromagnetic waves', 'Thermal radiation from the fire warms your face.', ['heat', 'electromagnetic wave'], [isA('electromagnetic wave')]],
  ['thermal equilibrium', 'the state in which objects in contact have the same temperature and no heat flows between them', 'The tea reaches thermal equilibrium with the room.', ['heat', 'temperature']],
  ['thermal expansion', 'the increase in the size of a material when its temperature rises', 'Thermal expansion can loosen a tight metal lid under warm water.', ['temperature', 'volume']],
  ['absolute zero', 'the lowest possible temperature, at which the motion of particles is minimal', 'Nothing can be colder than absolute zero.', ['temperature', 'kelvin']],
  ['thermodynamics', 'the study of heat, work, temperature, and the flow of energy', 'Thermodynamics explains how a steam engine runs.', ['heat', 'work', 'temperature', 'energy'], [isA('physics')]],
  ['entropy', 'a measure of how spread out or disordered the energy of a system is', 'Entropy tends to increase when a gas fills a whole room.', ['thermodynamics', 'energy', 'matter']],
  ['first law of thermodynamics', 'energy is conserved when heat is added to a system or work is done on it', 'The first law of thermodynamics keeps the energy budget of a steam engine.', ['thermodynamics', 'energy', 'heat', 'work'], [isA('scientific law'), { predicate: 'special-case-of', object: 'conservation of energy' }]],
  ['second law of thermodynamics', 'heat cannot spontaneously flow from a colder body to a hotter one, and entropy tends to increase', 'The second law of thermodynamics explains why a hot drink cools.', ['thermodynamics', 'heat', 'entropy'], [isA('scientific law')]],
  ['heat engine', 'a device that turns heat into work and rejects some heat as waste', 'A car engine is a heat engine.', ['thermodynamics', 'heat', 'work']],
  // ── Electric fields ─────────────────────────────────────────────────────
  ['electric field', 'a region in which an electric charge experiences a force', 'A charged balloon creates an electric field around it.', ['electric charge', 'force']],
  ['static electricity', 'electric charge that stays on the surface of an object', 'Rubbing a balloon builds up static electricity.', ['electric charge', 'insulator'], [isA('electric charge')]],
  // ── Quantum physics ─────────────────────────────────────────────────────
  ['quantum', 'the smallest discrete amount into which a physical quantity such as energy can come', 'Light energy arrives in quanta called photons.', ['photon', 'energy']],
  ['quantum mechanics', 'the physics of atoms and subatomic particles, in which energy comes in discrete quanta and measurement matters', 'Quantum mechanics describes an electron in an atom.', ['quantum', 'atom', 'electron', 'classical mechanics'], [isA('physics')]],
  ['quantum state', 'the complete description of a quantum system, such as the state of an electron in an atom', 'Measuring a quantum state changes it.', ['quantum mechanics']],
  ['superposition', 'the quantum condition of being in a combination of states until a measurement picks one', 'An electron in superposition is not in one definite position.', ['quantum state']],
  ['wave particle duality', 'the property of quanta such as photons and electrons to behave as both waves and particles', 'Wave particle duality appears in the double-slit experiment.', ['quantum', 'wave', 'particle', 'photon']],
  ['photoelectric effect', 'the release of electrons from a material when light shines on it', 'The photoelectric effect showed that light arrives in photons.', ['photon', 'electron', 'light']],
  ['energy level', 'a fixed energy value that an electron in an atom can have', 'An electron jumps between energy levels by absorbing or emitting a photon.', ['electron', 'atom', 'energy', 'photon']],
  ['quark', 'a fundamental particle that makes up protons and neutrons', 'Up and down quarks build a proton.', ['proton', 'neutron', 'particle'], [isA('particle')]],
  // ── Relativity ──────────────────────────────────────────────────────────
  ['space', 'the unbounded three-dimensional extent in which objects and events are located', 'An astronaut moves through the space around Earth.', ['physics', 'matter', 'length']],
  ['relativity', 'the theory that space and time are linked and are measured differently by observers in relative motion or different gravity', 'Relativity explains why clocks on fast spacecraft run slow.', ['space', 'time', 'motion', 'gravity'], [isA('physics')]],
  ['spacetime', 'the four-dimensional combination of space and time used to describe events', 'Gravity bends spacetime near a massive body.', ['space', 'time']],
  ['speed of light', 'the constant speed of light in empty space, about 300 million meters per second', 'Nothing travels faster than the speed of light.', ['light', 'speed', 'meter']]
]);

/** Science concepts from method through physical, life, Earth, and space science. */
export const SCIENCE_CONCEPTS: readonly TechnicalConcept[] = [
  ...SCIENTIFIC_PRACTICE,
  ...PHYSICS,
  ...CHEMISTRY,
  ...BIOLOGY,
  ...EARTH_SCIENCE,
  ...ASTRONOMY,
  ...PHYSICS_ADVANCED
];

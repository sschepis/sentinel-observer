/**
 * The 1,000-word frequency deck.
 *
 * Word list: the most common English words by corpus frequency (public-
 * domain frequency data; curated ordering). Definitions and examples are
 * intentionally ABSENT: the Chaperone (LLM) generates and validates them,
 * so the deck is honest about what has been authored vs. generated.
 *
 * Words without definitions are still teachable — the observer learns them
 * by recognition (word -> its own trace), and the auto-teacher skips the
 * production quiz until a chaperoned definition exists.
 */

const WORDS_1000 = `
the be and of a in to have it i that for you he with on do say this they at
but we his from that not by she or as what go their can who get if would her
all my make about know will as up one time there year so think when which
them some me people take out into just see him your come could now than like
other how then its our two more these want way look first also new because
day more use no man find here thing give many well only those tell one very
her even back any good woman through us life child there work down may after
should call world over school still try in as last ask need too feel three
when state never become between high really something most another much
family own out leave put old while mean on keep student why let great same
big group begin seem country help talk where turn problem every start hand
might american show part about against place week such again few case
company system each right during town small night point home water room area
mother question national money story young fact month different lot right
study book eye job word business issue side kind head house service friend
father power hour game line end member law car city community name president
team minute idea kid body information back parent face others level office
door health person art war history party result change morning reason
research girl guy moment air teacher force education foot boy age policy
process music market sense nation plan college interest death experience
effect use class control care field development role effort rate heart drug
show leader light voice wife whole police mind price report son view
relationship law court federal everything decision road form true sit later
number staff rule army general nation film happy federal adult man red
chapter paper letter future machine service special note total army woman
bank window scene cost size late public rule blue page society red wrong
clear culture action difficult newspaper black bad beautiful activity food
drop speech hope chance model blood job half attack enough cause window
happen return run fight watch true ago lot everything test meet eight seven
six five four three eleven twelve thirteen fourteen fifteen sixteen seventeen
eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety
hundred thousand million bird animal tree river mountain island ocean lake
forest flower grass stone metal wood paper cloth gold silver iron oil gas
fire ice snow rain wind cloud star moon sun sky sea earth city village road
bridge church school hospital shop market farm garden field kitchen bedroom
bathroom living room door window floor wall roof key lock lamp chair table
bed desk box bag bottle cup plate knife fork spoon dish pot pan oven stove
sink soap towel brush comb mirror clock watch ring necklace earring shoe
boot coat shirt dress skirt pants sock hat cap scarf glove umbrella bicycle
car bus train plane boat ship truck motor wheel engine road bridge tunnel
airport station port beach desert mountain valley hill cave rock sand dust
mud grass leaf branch root seed fruit vegetable meat rice bread cheese butter
milk tea coffee sugar salt pepper soup salad cake cookie candy egg chicken
beef pork fish apple orange banana grape lemon peach pear cherry strawberry
tomato potato onion carrot corn bean pea nut wheat cotton silk wool leather
plastic glass brick cement paint picture photo map letter word sentence
question answer story poem song dance game sport team player coach referee
ball goal score win lose tie race jump throw catch hit kick run swim ride
climb fly drive sail walk run jump sing dance draw paint cook bake wash
clean sweep dig plant harvest build make break fix mend sew knit weave spin
spin weave carve mold shape form join connect separate divide multiply add
subtract count measure weigh pour fill empty open close lock unlock push
pull lift carry drop pick throw catch hold touch feel smell taste hear see
look watch read write type print sign seal stamp mail send receive deliver
buy sell pay owe borrow lend spend save earn work rest sleep wake rise stand
sit lie kneel bend turn twist shake nod bow wave point clap snap whistle
shout whisper speak talk say tell ask answer reply agree argue discuss
debate explain describe define compare contrast choose decide plan prepare
organize arrange manage control direct lead follow obey order command
request demand beg pray thank greet welcome invite accept refuse offer give
receive take bring fetch find seek search discover explore invent create
design develop improve change alter vary adjust adapt adopt accept reject
like love hate fear worry care hope wish want need desire prefer choose
dare try attempt succeed fail win lose achieve accomplish complete finish
begin start continue stop pause end quit give up surrender yield resist
fight defend protect guard rescue save help aid support assist serve attend
join belong share divide distribute collect gather assemble meet separate
mix blend stir shake pour spill drip flow leak drain flood drown float sink
swim dive splash wash rinse soak dry freeze melt boil steam burn cook bake
roast fry grill boil steam peel slice chop cut grate mix knead roll fold
bend twist wrap tie bind fasten attach connect join split break crack snap
tear rip cut pierce stab strike hit beat knock bump crash collide smash
crush squash press squeeze pinch bite chew swallow taste lick suck blow
breathe sigh cough sneeze laugh smile cry weep sob shout scream yell
whisper murmur mutter talk chat gossip joke tease mock praise blame scold
punish forgive pardon excuse apologize admit confess deny hide conceal
reveal expose show display exhibit demonstrate prove test examine check
inspect review audit monitor observe watch guard protect defend
`.replace(/\s+/g, ' ').trim();

const WORDS_EXTRA = `
able above accept across act action actually add address admit adult afford
afraid after afternoon again against age agree ahead air allow almost alone
along already also although always among amount ancient anger angle animal
announce annual another answer anxiety apart apartment appear apply appoint
area argue arise arm army around arrive art article aside ask assume attach
attack attempt attend attention attract audience autumn available average
avoid awake award aware away awful baby back bad bag bake balance ball band
bang bank bar base basic basis basket bat bath battle beach bean bear beat
beauty because become bed bedroom before beg begin beginning behave behavior
behind being believe bell belong below belt bench bend benefit beside best
bet better between beyond bicycle big bill billion bind bird birth birthday
bit bite bitter black blade blame blank blind block blood blow blue board
boat body bone bonus book border born borrow boss both bother bottle bottom
boundary bowl box boy brain branch brave bread break breakfast breast breathe
brick bridge brief bright brilliant bring broad broken brother brown brush
budget build building bullet bunch burn bury bus business busy butter button
buy cabinet cable cake calculate call calm camera campaign cancel cancer
candidate cannot capital captain capture carbon card care career careful
carpet carry case cash cast cat catch category cause celebrate cell cent
center central century ceremony certain chain chair chairman challenge
champion chance change channel chapter character charge charity chart chase
cheap check cheek cheer cheese chef chemical chest chicken chief child
childhood chip chocolate choice choose church cigarette circle citizen city
civil claim class classic classroom clean clear clerk clever click client
climate climb clock close cloth clothes cloud club clue coach coal coast coat
code coffee cold collapse colleague collect college color combine come comedy
comfort comfortable command comment commercial common community company
compare compete complain complete complex computer concern concert condition
conference confidence confirm conflict confuse connect conscious consider
consist constant construct contact contain content contest context continue
contract contrast contribute control convenient conversation cook cool cope
copy core corn corner correct cost cottage cotton could council count country
county couple courage course court cousin cover cow crack craft crash crazy
cream create creative creature credit crime crisis critic crop cross crowd
crucial culture cup curious current curtain curve custom customer cut cycle
daily damage dance danger dark data date daughter day dead deal dear death
debate debt decade decide decision deep defeat defend define definite degree
delay deliver demand democracy dentist deny department depend deposit describe
desert deserve design desire desk despite destroy detail detect determine
develop device devote diagram dialogue die diet differ difference different
difficult difficulty dinner direct direction director dirt dirty disaster
discipline discount discover discuss disease dish dismiss display distance
distinct district divide division divorce doctor document dog dollar domain
domestic dominate door double doubt down dozen draft drag drama dramatic draw
dream dress drink drive driver drop drug drum dry due during dust duty each
eager ear early earn earth ease easily east easy economic economy edge edit
educate education effect effective efficiency efficient effort egg eight
either elderly elect election electric electricity element elephant eleven
eliminate else elsewhere email embrace emerge emotion emphasis employ
employee empty enable encounter encourage end enemy energy engage engine enjoy
enormous enough enter enterprise entertain enthusiasm entire entrance entry
envelope environment equal equipment equivalent era error escape especially
essay essential establish estate estimate ethic ethnic evaluate even evening
event eventually ever every everybody everyone everything everywhere evidence
evil exact exactly exam examine example exceed excellent except exchange
excited exciting excuse executive exercise exhibit exist exit expand expect
expense expensive experience experiment expert explain explore export expose
express extend extent external extra extraordinary extreme eye face facility
fact factor factory fail failure fair faith fall familiar family famous fan
fancy fantastic far farm farmer fashion fast fat father fault favor favorite
fear feature federal fee feed feel feeling fellow female fence festival few
fiber fiction field fifteen fifth fifty fight figure file fill film final
finally finance financial find finding fine finger finish fire firm first
fish fit five fix flag flame flash flat flavor flight float floor flour flow
flower flu fly focus fold folk follow following food foot football for force
foreign forest forget forgive fork form formal former forth fortune forty
forward found foundation founder four frame free freedom freeze frequent
fresh friend friendly from front fruit fuel full fun function fund
fundamental funny furniture further future gain gallery game gang gap garage
garden garlic gas gate gather general generation generous gentle gentleman
geography gesture get ghost giant gift girl give glad glass global glove glue
go goal god gold golf good government grab grade grand grandfather
grandmother grant grass grateful great green greet ground group grow growth
guarantee guard guess guest guide guilty guitar gun guy habit hair half hall
hand handle hang happen happy hard harm hat hate have he head health hear
heart heat heavy height hell hello help her here hero herself hide high
highlight highly highway hill himself hip hire his history hit hold hole
holiday holy home honest honey honor hope horrible horse hospital host hot
hotel hour house however huge human humor hundred hungry hunt hurry hurt
husband ice idea identify identity if ignore ill illegal illness illustrate
image imagine immediate impact imply import important impose impossible
impress improve in inch include income increase indeed independent index
indicate individual industrial industry inevitable infect influence inform
initial initiative injure injury inner innocent innovation input inside
insist inspire install instance instead institute instruction instrument
insurance intelligence intend intense intention interest internal
international interpret interrupt interview into introduce invest
investigate investment invite involve iron island issue it item its itself
jacket job join joint joke journal journey joy judge juice jump junior jury
just justice keep key kick kid kill kind king kiss kitchen knee knife knock
know knowledge lab label labor lack lady lake land landscape language large
laser last late later laugh launch law lawyer lay layer lead leader
leadership lean learn learning least leather leave left leg legal legend
leisure lemon lend length lesson let letter level library license lie life
lifestyle lift light like likely limit line link lip list listen literature
little live load loan local locate location lock logic lonely long look loose
lose loss lost lot loud love lovely low loyal luck lucky lunch machine mad
magazine magic mail main maintain major majority make male mall man manage
management manager manner many map march margin mark market marriage marry
mask mass massive master match mate material math matter maximum maybe mayor
me meal mean meaning measure meat media medical medicine medium meet member
memory mental mention menu mere mess message metal method middle midnight
might mile military milk million mind mine minister minor minute mirror miss
mission mistake mix mixture mobile mode model moderate modern modest moment
money monitor month mood moon moral more morning most mother motor mountain
mouse mouth move movement movie much multiple murder muscle museum music
musical must mutual my myself mystery nail name narrative narrow nation
national native natural nature near nearly neat necessary neck need negative
neighbor nerve nervous net network never new news newspaper nice night nine
no nobody nod noise none nor normal north nose not note nothing notice
notion novel now nowhere nuclear number nurse nut object observation observe
obtain obvious occasion occur ocean odd of off offense offer office officer
official often oil okay old on once one onion online only onto open opening
operate operation opinion opponent opportunity oppose option orange order
ordinary organic organize original other our ours ourselves out outcome
outside oven over overall overcome overseas own owner pace pack package page
pain paint pair pan panel panic pants paper parent park part participate
particular particularly partner party pass passage passenger passion past path
patient pattern pause pay peace peak pen penalty pencil pension people pepper
per percent percentage perfect perform performance perhaps period permanent
permission permit person personal personality perspective pet phase
philosophy phone photo phrase physical piano pick picture pie piece pig pile
pilot pin pink pipe pitch place plain plan plane planet plant plastic plate
platform play player pleasant please pleasure plenty plot plus pocket poem
poet poetry point police policy polite political politics poll pollution pool
poor pop popular population port portion pose position positive possess
possible post pot potato potential pound pour poverty powder power practical
practice praise pray prayer precious predict prefer pregnancy preparation
prepare prescription presence present preserve president press pressure
pretend pretty prevent previous price pride priest primarily primary prime
principle print prior priority prison prisoner privacy private prize probably
problem procedure process produce product profession professional professor
profile profit program progress project promise promote prompt proof proper
properly property proportion proposal propose prospect protect protection
protein protest proud prove provide psychologist psychology public
publication publish pull punishment purchase pure purple purpose pursue push
put qualify quality quantity quarter queen question quick quickly quiet
quietly quit quite quote race racial radical radio rail rain raise range rank
rapid rare rarely rate rather rating ratio raw reach react reaction read
reader ready real reality realize really reason reasonable recall receive
recent recently recipe recognize recommend record recover recovery recruit
red reduce reduction refer reference reflect reflection refuse regard region
register regret regular reject relate relation relationship relative relax
release relevant relief religion religious rely remain remember remind remote
remove rent repair repeat replace reply report represent representative
reputation request require requirement rescue research researcher resemble
resident resist resource respect respond response responsibility responsible
rest restaurant restore restrict result retain retire return reveal revenue
reverse review revolution reward rhythm rice rich rid ride rifle right ring
rise risk river road rock role roll romantic roof room root rope rough round
route routine row royal rub ruin rule run rural rush sad safe safety sail sake
salad salary sale salt same sample sand satisfy sauce save saving say scale
scan scared scene schedule scheme scholar school science scientific scientist
scope score scream screen screw script sea search season seat second secret
secretary section sector secure security see seed seek seem select selection
self sell senate senator send senior sense sensitive sentence separate
sequence series serious seriously servant serve service session set setting
settle seven several severe sex sexual shade shadow shake shall shallow shame
shape share sharp she sheep sheet shelf shell shelter shift shine ship shirt
shock shoe shoot shop shopping shore short shot shoulder should shout show
shower shut shy sick side sight sign signal signature significance
significant silence silent silly silver similar simple simply since sing
singer single sink sir sister sit site situation six size ski skill skin
skirt sky slave sleep slice slide slight slim slip slow small smart smell
smile smoke smooth snake snap snow so soap soccer social society sock soft
software soil solar soldier solid solution solve some somebody somehow someone
something sometimes somewhat somewhere son song soon sorry sort soul sound
soup source south space spare speak speaker special specific speech speed
spell spend spin spirit spiritual spite split spoke sport spot spread spring
square squeeze stability stable staff stage stair stake stand standard star
stare start state statement station status stay steady steal steam steel
steep step stick stiff still stir stock stomach stone stop storage store
storm story straight strange strategy stream street strength stress stretch
strike string strip stroke strong structure struggle student studio study
stuff stupid style subject submit subsequent substance succeed success
successful such sudden suffer sufficient sugar suggest suit summer sun super
supply support suppose sure surface surgery surprise surround survey survival
survive suspect suspicious sustain swallow swear sweat sweep sweet swim swing
switch symbol sympathy system table tackle tail take tale talent talk tall
tank tap target task taste tax tea teach teacher team tear technical
technique technology teenager telephone television tell temperature temporary
ten tend tennis tent term terrible test testing text than thank thanks that
the theater theme themselves then theory therapy there therefore these they
thick thin thing think third thirsty thirteen thirty this thorough those
though thought thousand threat threaten three throat through throw thus
ticket tie tight till time tin tiny tip tire tired tissue title to today toe
together toilet tomato tomorrow tone tongue tonight too tool tooth top topic
total touch tough tour tourist toward towel tower town toy trace track trade
tradition traffic train transfer transform transition translate transport
travel treat tree trial trick trip trouble truck true truly trust truth try
tube tunnel turn tv twelve twenty twice twin twist two type typical ugly
ultimately unable uncle under undergo understand understanding unique unit
united university unknown unless unlike unlikely until unusual up update upon
upper upset urban urge us use used useful user usual usually vacation valley
valuable value van variation variety various vast vegetable vehicle venture
version versus very vessel veteran victim victory video view viewer village
violence violent virtually virtue virus visible vision visit visitor vital
voice volume volunteer vote voter voting wage wait wake walk wall want war
warm warn warning wash waste watch water wave way we weak wealth weapon wear
weather wedding week weekend weigh weight welcome welfare well west wet what
whatever wheel when whenever where whereas wherever whether which while
whisper white who whole whom whose why wide widely wife wild will willing
win wind window wine wing winner winter wipe wire wisdom wise wish with
withdraw within without witness woman wonder wonderful wood wooden word work
worker working works workshop world worried worry worth would wound wrap
write writer writing wrong yard yeah year yellow yes yesterday yet you young
your yours yourself youth zone
`.replace(/\s+/g, ' ').trim();

import type { DeckWord } from '../deck';

/**
 * The frequency list as deck entries, deduplicated (frequency lists repeat
 * word forms; the deck must not). `definition`/`example` are empty until the
 * Chaperone fills them — the deck never pretends to have content it does not.
 */
export const DECK_1000: readonly DeckWord[] = [...new Set([...WORDS_1000.split(' '), ...WORDS_EXTRA.split(' ')])].map((word) => ({
  word,
  definition: '',
  example: ''
}));

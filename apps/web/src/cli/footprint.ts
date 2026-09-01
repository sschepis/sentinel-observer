import { ObserverSession } from '../observer/engine';
import { TeacherAgent } from '../teacher/TeacherAgent';
import { OBSERVER_OPTIONS } from '../observer/options';
import { ACTIVE_DECK } from '../teacher/decks';

async function main(): Promise<void> {
  const session = new ObserverSession(OBSERVER_OPTIONS, 100);
  await session.initialize();
  const teacher = new TeacherAgent(session, ACTIVE_DECK);
  for (const entry of ACTIVE_DECK.slice(0, 1000)) teacher.teach(entry.word);
  const record = teacher.exportBootstrap('en-1000');
  const bytes = JSON.stringify(record).length;
  const traces = (record as any).traces as Array<Record<string, unknown>>;
  console.log(`record bytes: ${bytes} · traces: ${traces.length} · ${(bytes / traces.length).toFixed(0)} B/trace`);
  const withPhases = traces.filter((t) => Array.isArray(t.phases) && (t.phases as unknown[]).length > 0).length;
  console.log(`traces with phase config: ${withPhases}/${traces.length}`);
  const phaseField = traces[0].phases as number[] | undefined;
  console.log(`sample trace phase pair: phasePrimes=${(traces[0].phasePrimes as number[] | undefined)?.length} phases=${phaseField?.length ?? 0}`);
  session.dispose();
}
void main().catch((e) => { console.error(e); process.exit(1); });

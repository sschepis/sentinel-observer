import { ObserverSession } from '../observer/engine'
import { OBSERVER_OPTIONS } from '../observer/options'
import { TeacherAgent } from '../teacher/TeacherAgent'
import { ACTIVE_DECK } from '../teacher/decks'
import { ALL_CONVERSATION_PAIRS } from '../teacher/conversation'
import { MemoryPersistenceStore } from '../persistence/store'
async function main() {
  for (const memoryMode of ['compact', 'autoshard'] as const) {
    const t0 = Date.now()
    const session = new ObserverSession({ ...OBSERVER_OPTIONS, memoryMode }, 100)
    await session.initialize()
    const teacher = new TeacherAgent(session, ACTIVE_DECK, new MemoryPersistenceStore(), 500)
    for (const entry of ACTIVE_DECK.slice(0, 150)) teacher.teach(entry.word)
    const t1 = Date.now()
    teacher.teachConversationDeck(ALL_CONVERSATION_PAIRS)
    const t2 = Date.now()
    console.log(memoryMode, 'words', t1 - t0, 'ms | conversation deck', t2 - t1, 'ms')
    session.dispose()
  }
}
main()

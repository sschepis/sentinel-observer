# Server-singular training — rails

**Directive (non-negotiable).** There is exactly ONE observer and ONE training
dataset. It lives in a server-side persistent process. The browser is a pure
client: it renders, sends user turns and feedback, and displays server state.
NEVER any client-side model activity — no `ObserverSession`, no
`TeacherAgent`, no learning loop, no grading, no IndexedDB learning record,
no bootstrap import/export in the browser.

Client-side occurrences that feedback to the server are allowed and required:
chat turns, teach replies, grade confirmations, compose requests, wake/sleep.
Voice + conversation history UX remain client-side (they are not model
activity; conversation transcripts live in the browser's conversation store
and are ALSO sent to the server as turns).

## 0. Invariants

1. After this refactor, `apps/web/src/App.tsx` must not import
   `useObserver`, `useLearningEngine`, `TeacherAgent`, `createPersistenceStore`,
   `OBSERVER_OPTIONS`, `importBootstrapRecord`, or `bootstrapLoader`.
2. The server is the only process that constructs `TeacherAgent`. A grep for
   `new TeacherAgent` in the UI code must return nothing.
3. One record: server `dataDir` (FilePersistenceStore + `model.json`
   snapshot). The browser keeps ONLY conversation transcripts (chat UX), voice
   settings, and the server URL — no learned state.
4. Training runs on the server even when no browser is connected. UI
   connecting/disconnecting must not affect the loop.
5. Every UI stat comes from `/api/*` endpoints; every action that trains
   goes through an endpoint. No endpoint writes from the client other than
   the sanctioned feedback calls.
6. Gates stay green per phase: `npx tsc --noEmit` + full jest + the server
   suites (`serverParity`, `ServerSession`), plus a manual smoke: boot server,
   open UI, chat, watch `dataDir` persist across a server restart.
7. One commit per green phase.

## 1. Current-state inventory (verified)

Server already has (`apps/web/src/server/`):
- `ServerSession`: owns the TeacherAgent; boot = restore from
  FilePersistenceStore → bootstrap import → fresh-teach fallback; wake/sleep
  field ticking; autosave interval → atomic `model.json` + flush; broadcasts
  signals/metrics/snapshots/lifecycle events.
- `http.ts` routes: `/api/state`, `/api/words`, `/api/snapshot`, `/api/events`,
  `/api/chat`, `/api/compose`, `/api/grade`, `/api/teach`, `/api/observe`,
  `/api/wake`, `/api/sleep`, `/api/save`.
- `client.ts` (browser) + `useRemoteObserver.ts` (browser hook) for remote.

Client still does (must be REMOVED or re-routed):
- `App.tsx:72 useObserver(...)` — browser ObserverSession, ALWAYS.
- `useLearningEngine(teacher, ...)` — browser training loop (auto teach/review
  cycles, drills + induction, goal loop, definitions backfill via client
  chaperone settings, curriculum), ALWAYS.
- `useChat` grading: `gradeCreative` runs against client settings + client
  chaperone when local teacher (server mode grades via `/api/grade`).
- IndexedDB persistence + `restoreFromPersistence`, definitions store,
  record import/export/bootstrap buttons (SettingsView "Learning record").
- `SettingsView` chaperone endpoint/model fields (client-side grader config).

Server still lacks (must be ADDED):
- The autonomous learning loop (port of useLearningEngine's cycle):
  teach/review/grade cadence, drills, goal loop, curriculum ranking,
  definitions backfill — driven server-side with server-configured
  chaperone settings (env/CLI), emitting learning events over `/api/events`.
- Endpoints the pure-client UI needs: training loop start/stop/status,
  training event feed (already `/api/events`), record export (file download
  from server), record import + bootstrap load (POST), definitions backfill
  start/cancel/progress, server settings (chaperone) surface.
- Chat: `tryTeachReply` must be served (the ask→told→own loop closes
  server-side). Check `/api/teach` covers it; if not, add.

## 2. Target architecture

```
browser (pure client)
  ChatView / TrainingView / Dashboard / VocabularyView / SettingsView
    → RemoteClient (fetch/SSE to the server)
    → conversation transcript store (browser-only UX) + voice settings
    NO ObserverSession, NO TeacherAgent, NO learning loop, NO IndexedDB model

server (single agent)
  ServerSession
    → TeacherAgent (the one model)
    → TrainingLoop (new): autonomous cycles + drills + goals + definitions
    → FilePersistenceStore (dataDir) + atomic model.json snapshots
    → chaperone settings from env/CLI (endpoint/model/key) — never from UI
    → http routes: chat/teach/compose/grade/observe + loop control + events
```

## 3. Phases (each = one commit, gated)

### Phase A — server-side training loop (the port)
- Extract the autonomous cycle from `useLearningEngine` into a
  `TrainingLoop` module (server-usable): `tick()` performing teach/review/
  grade/drill/goal/definitions steps against a TeacherAgent, producing the
  same `AutonomousEvent`s, with start/stop and a cadence.
- `ServerSession` runs it (option `train: true`), pushes events into
  `/api/events`; autosave continues on its interval.
- Gates: a new `serverTraining.test.ts` driving N ticks asserts events +
  persistence growth; existing server suites green.

### Phase B — server endpoints for record I/O + loop control + settings
- Add: `POST /api/record/import` (bootstrap JSON), `GET /api/record/export`,
  `POST /api/bootstrap/load` (server-side fetch of the deployed record),
  `GET/POST /api/definitions` (backfill run/cancel/progress, server
  chaperone), `POST /api/train` (start/stop) + loop status in `/api/state`.
- Server settings: chaperone endpoint/model/key from env/CLI (`--chaperone-*`),
  surfaced read-only in `/api/state`.
- Gates: serverParity extension; manual smoke via curl.

### Phase C — App becomes a pure client (the big deletion)
- Delete from App/UI: `useObserver`, `useLearningEngine`, local
  `TeacherAgent`/`createPersistenceStore`/`OBSERVER_OPTIONS`, bootstrap
  import/export client paths, IndexedDB learning stores.
- `useChat` gains a remote-teacher-only mode: `send` → `/api/chat`;
  `tryTeachReply` → `/api/teach`; creative grade → `/api/grade` (existing);
  status/dependence read from `/api/state`.
- Views: TrainingView consumes the server event feed + loop status;
  Dashboard/VocabularyView consume `/api/state|words`; SettingsView keeps
  VOICE + server info only, drops local learning record buttons (record I/O
  moves to server endpoints or is removed from UI); definitions button →
  `/api/definitions`.
- Gates: full web suite updated (UI tests now mock RemoteClient — update
  stubs; delete local-mode tests that no longer apply), typecheck, manual
  smoke: UI + server, chat + persistence across restart.

### Phase D — hardening + cleanup
- Remove now-dead client code (bootstrapLoader usage, definitions store
  paths, importRecord UI helpers) only after grep confirms no references.
- Server parity bench re-run; docs: update README (single-mode), the
  observer paper's deployment notes, TODO.md entries.
- Final grep gates: no `new TeacherAgent` in UI, no `useObserver`,
  no `createPersistenceStore` outside server/train CLI; `npm run server`
  boots and trains with no browser open.

## 4. Failure protocol
- Red gate → revert the phase, redo in halves.
- UI test churn is EXPECTED in Phase C: stubs switch to RemoteClient mocks;
  never delete a test that still names real behavior — adapt it.
- If the event feed shape must change, change it in one commit with both
  server and client updated together.

## 5. Definition of done
- One server process trains the singular observer with no browser attached;
  UI is a pure client; single record at `dataDir`; all suites green;
  README + paper reflect single-mode operation.

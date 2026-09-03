import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerSession, ServerEvent } from './ServerSession';

/**
 * Zero-dependency HTTP + SSE front for the observer server.
 *
 * JSON endpoints for every mutating interaction (chat, teach, grade,
 * observe, wake/sleep/save), SSE for the live metric/signal stream, and a
 * snapshot download for the trained model. CORS is open for the Vite dev
 * origin so the browser client can talk to the server during development.
 */

const MAX_BODY_BYTES = 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch (err) {
        reject(err instanceof Error ? err : new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  });
  res.end(text);
}

function route(req: IncomingMessage, res: ServerResponse, server: ServerSession): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end();
    return;
  }

  // ── GET: read-only ───────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/state') {
    sendJson(res, 200, server.state());
    return;
  }

  if (req.method === 'GET' && path === '/api/words') {
    const teacher = server.teacher;
    if (teacher === null) {
      sendJson(res, 503, { error: 'observer not booted' });
      return;
    }
    sendJson(res, 200, {
      words: teacher.listWords().map((entry) => ({
        word: entry.word.word,
        definition: entry.word.definition,
        example: entry.word.example,
        traceId: entry.traceId,
        taughtAt: entry.taughtAt,
        lastAskedAt: entry.lastAskedAt,
        lastGrade: entry.lastGrade,
        successes: entry.successes,
        failures: entry.failures,
        stability: entry.stability,
        difficulty: entry.difficulty,
        dueAt: entry.dueAt,
        lastIntervalDays: entry.lastIntervalDays,
        reviewHistory: entry.reviewHistory,
        strength: entry.strength,
        status: entry.status
      }))
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/snapshot') {
    const modelPath = server.state().modelPath;
    if (modelPath === null || !existsSync(modelPath)) {
      sendText(res, 404, 'no model snapshot saved yet');
      return;
    }
    const body = readFileSync(modelPath);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'access-control-allow-origin': '*',
      'content-disposition': 'attachment; filename="observer-model.json"',
      'cache-control': 'no-store'
    });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && path === '/api/events') {
    serveEventStream(req, res, server);
    return;
  }

  // ── POST: actions ────────────────────────────────────────────────────────
  const teacher = server.teacher;
  if (teacher === null) {
    sendJson(res, 503, { error: 'observer not booted' });
    return;
  }

  void (async () => {
    try {
      const body = await readJsonBody(req);

      if (path === '/api/chat') {
        const utterance = String(body.utterance ?? '').trim();
        if (utterance.length === 0) {
          sendJson(res, 400, { error: 'utterance required' });
          return;
        }
        sendJson(res, 200, { answer: teacher.chatAnswer(utterance) });
        return;
      }

      if (path === '/api/compose') {
        const utterance = String(body.utterance ?? '').trim();
        sendJson(res, 200, { reply: teacher.creativeReply(utterance.length > 0 ? utterance : 'tell me something new') });
        return;
      }

      if (path === '/api/grade') {
        const traceIds = Array.isArray(body.traceIds) ? body.traceIds.map(String) : [];
        const edges = Array.isArray(body.edges) ? body.edges : [];
        const score = typeof body.score === 'number' ? body.score : null;
        const graded = teacher.gradeCreativeWithReliability(
          {
            traceIds,
            edges,
            templateIds: Array.isArray(body.templateIds) ? body.templateIds.map(String) : [],
            ruleIds: Array.isArray(body.ruleIds) ? body.ruleIds.map(String) : undefined
          },
          score,
          String(body.utterance ?? ''),
          String(body.answer ?? ''),
          String(body.provider ?? 'server')
        );
        sendJson(res, 200, { graded });
        return;
      }

      if (path === '/api/teach') {
        const word = String(body.word ?? '').trim();
        const cue = String(body.cue ?? '').trim();
        const response = String(body.response ?? '').trim();
        if (word.length > 0) {
          const result = teacher.teach(word);
          sendJson(res, 200, { taught: result });
          return;
        }
        if (cue.length > 0 && response.length > 0) {
          const count = teacher.teachConversationDeck([{ cue, response }]);
          sendJson(res, 200, { exchanges: count });
          return;
        }
        sendJson(res, 400, { error: 'word or cue+response required' });
        return;
      }

      if (path === '/api/observe') {
        const text = String(body.text ?? '');
        const result = server.session?.observeText(text);
        sendJson(res, 200, { observed: result !== undefined });
        return;
      }

      if (path === '/api/wake') {
        server.wake();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/api/sleep') {
        server.sleep();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === '/api/save') {
        const snapshot = await server.saveNow('api');
        sendJson(res, 200, { snapshot });
        return;
      }

      sendJson(res, 404, { error: `unknown route ${path}` });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
}

/** SSE stream: metrics (every tick), signals, snapshots and lifecycle. */
function serveEventStream(req: IncomingMessage, res: ServerResponse, server: ServerSession): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'access-control-allow-origin': '*'
  });
  res.write(`retry: 2000\n\n`);

  const push = (event: ServerEvent): void => {
    if (event.kind === 'metrics') {
      res.write(`event: metrics\ndata: ${JSON.stringify(event)}\n\n`);
      return;
    }
    res.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = server.subscribe(push);
  // Bootstrap the stream with the current state so a fresh client never
  // stares at an empty dashboard while waiting for the next tick.
  res.write(`event: state\ndata: ${JSON.stringify({ ...server.state(), kind: 'state' })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

export function startHttpServer(server: ServerSession, port: number): ReturnType<typeof createServer> {
  const http = createServer((req, res) => {
    try {
      route(req, res, server);
    } catch (err) {
      sendText(res, 500, err instanceof Error ? err.message : String(err));
    }
  });
  http.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[observer-server] listening on http://localhost:${port}`);
  });
  return http;
}

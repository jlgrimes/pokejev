import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { JevEvents } from '../harness/events.ts';
import type { Button } from '../emulator/gameboy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ViewerControls {
  pause(): void;
  resume(): void;
  /** Run exactly one decision, then pause again. */
  step(): void;
  /** Queue a manual button press to be applied before Jev's next decision. */
  queueInput(button: Button): void;
  isPaused(): boolean;
}

export interface ViewerHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * A dependency-free live viewer.
 *
 * Server-sent events push frames, state and Jev's reasoning to the browser as
 * they happen. Watching the agent is not a luxury here — most of what goes
 * wrong with an LLM playing a game is only obvious when you can see the screen
 * next to the reason it gave for pressing the button.
 */
export function startViewer(
  events: JevEvents,
  controls: ViewerControls,
  port = 8080,
): Promise<ViewerHandle> {
  const clients = new Set<ServerResponse>();
  /** Last value of each event type, so a browser that joins late sees state immediately. */
  const latest = new Map<string, unknown>();

  const broadcast = (type: string, payload: unknown) => {
    latest.set(type, payload);
    const chunk = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(chunk);
  };

  for (const type of ['frame', 'state', 'decision', 'log', 'status'] as const) {
    events.on(type, (payload: unknown) => broadcast(type, payload));
  }

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'ui.html'), 'utf8'));
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Replay the most recent state so the page is populated on load.
      for (const [type, payload] of latest) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/control' && req.method === 'POST') {
      void readBody(req).then((body) => {
        const { command, button } = JSON.parse(body || '{}') as {
          command: string;
          button?: Button;
        };
        if (command === 'pause') controls.pause();
        else if (command === 'resume') controls.resume();
        else if (command === 'step') controls.step();
        else if (command === 'input' && button) controls.queueInput(button);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paused: controls.isPaused() }));
      });
      return;
    }

    res.writeHead(404).end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      // Port 0 asks the OS to pick one, so read back what we actually got.
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${boundPort}`,
        close: () =>
          new Promise<void>((done) => {
            for (const client of clients) client.end();
            server.close(() => done());
          }),
      });
    });
  });
}

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

export interface RomInstaller {
  status(): Promise<{ present: boolean; size: number | null }>;
  /** Accepts a .gb or the .zip it came in; returns what was installed. */
  install(data: Buffer): Promise<{ title: string; size: number; source: string }>;
}

export interface ViewerOptions {
  /**
   * Shared secret required to view or control the run.
   *
   * Unset means open access, which is correct on localhost and wrong on a
   * public host: without it anyone with the URL could watch the stream and
   * press buttons. The container entrypoint therefore always supplies one.
   */
  token?: string | undefined;
  /**
   * Lets the page install a ROM into a server that started without one.
   *
   * Without this the server could only get a ROM from object storage, which
   * would make a storage token mandatory just to hand it a file. With it, the
   * only thing a fresh deployment needs is the gateway key.
   */
  rom?: RomInstaller | undefined;
}

const COOKIE_NAME = 'jev_key';

/** Constant-time-ish comparison, so the token cannot be guessed byte by byte. */
function tokensMatch(expected: string, supplied: string | undefined): boolean {
  if (!supplied || supplied.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return mismatch === 0;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}

/**
 * Every form the key might legitimately arrive in.
 *
 * `URLSearchParams` decodes `+` as a space, which silently breaks base64-ish
 * tokens — the kind Render generates — so a correct key gets rejected. Read the
 * raw query instead and accept both interpretations rather than guessing which
 * one the host produced.
 */
function suppliedKeys(rawUrl: string, cookieHeader: string | undefined): string[] {
  const candidates: string[] = [];
  const raw = /[?&]key=([^&]*)/.exec(rawUrl)?.[1];
  if (raw !== undefined) {
    const safeDecode = (value: string) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };
    candidates.push(safeDecode(raw), safeDecode(raw.replace(/\+/g, ' ')), raw);
  }
  const cookie = cookieValue(cookieHeader, COOKIE_NAME);
  if (cookie) candidates.push(cookie, decodeURIComponent(cookie));
  return candidates;
}

/** The sign-in page: a box to paste into beats telling someone to edit a URL. */
function keyPrompt(message: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev plays Pok\u00e9mon Red</title>
<body style="font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f1216;color:#e6e9ee;margin:0;padding:32px 20px">
<h1 style="font-size:15px;letter-spacing:.08em;text-transform:uppercase"><span style="color:#9bbc0f">Jev</span> plays Pok\u00e9mon Red</h1>
<p style="color:#8c96a3">${message}</p>
<form onsubmit="event.preventDefault();location.search='?key='+encodeURIComponent(document.getElementById('k').value.trim())">
  <input id="k" type="password" autocomplete="current-password" placeholder="access key"
    style="width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #252b34;background:#171b21;color:#e6e9ee;font:inherit" />
  <button type="submit"
    style="margin-top:12px;padding:12px 18px;border-radius:8px;border:1px solid #6b8c1a;background:#20262e;color:#9bbc0f;font:inherit;cursor:pointer">
    Open
  </button>
</form>
<p style="color:#8c96a3;font-size:12px;margin-top:20px">
  It is the <code>JEV_ACCESS_TOKEN</code> value in your host's environment settings.
</p>
</body>`;
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
  options: ViewerOptions = {},
): Promise<ViewerHandle> {
  const token = options.token;
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
    const rom = options.rom;

    // Liveness probe for the host; deliberately unauthenticated and empty.
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, paused: controls.isPaused() }));
      return;
    }

    if (token) {
      const candidates = suppliedKeys(req.url ?? '', req.headers.cookie);
      if (!candidates.some((candidate) => tokensMatch(token, candidate))) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          keyPrompt(
            candidates.length > 0
              ? 'That key was not accepted. Paste it again below.'
              : 'This run is private. Paste the access key to watch it.',
          ),
        );
        return;
      }
      // Remember it, so the SSE stream and control posts do not each need the key.
      if (/[?&]key=/.test(req.url ?? '')) {
        res.setHeader('set-cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      }
    }

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
        // Stops reverse proxies buffering the stream until it is too late.
        'x-accel-buffering': 'no',
      });

      // Send something immediately. A response that opens and stays silent —
      // which is exactly what happens before a ROM arrives, when nothing has
      // been emitted yet — gets idle-timed-out by a proxy and shows up in the
      // browser as a failed connection rather than an idle one.
      res.write(': connected\n\n');

      // Replay the most recent state so the page is populated on load.
      for (const [type, payload] of latest) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      }

      // And keep it that way: comments are ignored by EventSource but reset
      // every idle timer between here and the browser.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      heartbeat.unref?.();

      clients.add(res);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === '/rom' && rom) {
      if (req.method === 'GET') {
        void rom.status().then((status) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(status));
        });
        return;
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          void rom
            .install(Buffer.concat(chunks))
            .then((installed) => {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, ...installed }));
            })
            .catch((error: Error) => {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: error.message }));
            });
        });
        return;
      }
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

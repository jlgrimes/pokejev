const JSON_HEADERS = {
  'content-type': 'application/json',
  // Every response reflects a mutating tick; caching any of it would desync
  // the browser from the emulator.
  'cache-control': 'no-store',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function fail(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, status);
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

/** Session id from the query string, validated so it can be used as a storage key. */
export function sessionIdFrom(request: Request): string {
  const id = new URL(request.url).searchParams.get('session') ?? 'default';
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : 'default';
}

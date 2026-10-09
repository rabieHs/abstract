/** Polite HTTP for scholarly APIs: retry with backoff, TTL cache, per-host pacing. */

const cache = new Map<string, { at: number; body: unknown }>()
const lastCall = new Map<string, number>()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function request(
  url: string,
  opts: { minIntervalMs?: number; fetchImpl?: typeof fetch },
): Promise<Response | null> {
  const f = opts.fetchImpl ?? fetch
  const host = new URL(url).host
  const wait = (lastCall.get(host) ?? 0) + (opts.minIntervalMs ?? 0) - Date.now()
  if (wait > 0) await sleep(wait)
  lastCall.set(host, Date.now())
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await f(url, { headers: { "user-agent": "abstract/0.1 (+https://github.com/rabieHs/abstract)" } })
      if (r.status === 429 || r.status >= 500) {
        await sleep(400 * 2 ** attempt)
        continue
      }
      return r
    } catch {
      await sleep(400 * 2 ** attempt)
    }
  }
  return null
}

export async function getJson<T>(
  url: string,
  opts: { ttlMs?: number; minIntervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<T | null> {
  const ttl = opts.ttlMs ?? 300_000
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < ttl) return hit.body as T
  const r = await request(url, opts)
  if (!r?.ok) return null
  try {
    const body = (await r.json()) as T
    cache.set(url, { at: Date.now(), body })
    return body
  } catch {
    return null
  }
}

export async function getText(
  url: string,
  opts: { ttlMs?: number; minIntervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const ttl = opts.ttlMs ?? 300_000
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < ttl) return hit.body as string
  const r = await request(url, opts)
  if (!r?.ok) return null
  const body = await r.text()
  cache.set(url, { at: Date.now(), body })
  return body
}

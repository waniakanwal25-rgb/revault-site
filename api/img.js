// /api/img — image proxy in front of Sanity's asset CDN.
//
// Why this exists: images fetched straight from cdn.sanity.io are billed
// against Sanity's metered bandwidth on every request, cache hit or not.
// By proxying through this Vercel Edge Function with a long, immutable
// Cache-Control header, Vercel's own edge network caches each unique
// image+params combination. Repeat visitors and popular products are then
// served straight from Vercel's edge — Sanity is only hit once per unique
// image variant, until the cache entry ages out.
//
// Usage from the frontend: /api/img?src=<url-encoded full Sanity image URL>
// Only cdn.sanity.io URLs are allowed through — this is not an open proxy.

export const config = { runtime: 'edge' };

const ALLOWED_HOST = 'cdn.sanity.io';

// Cache for a year — Sanity asset URLs are content-addressed (the filename
// hash changes if the underlying file changes), so this is safe.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const src = searchParams.get('src');

  if (!src) {
    return new Response('Missing src parameter', { status: 400 });
  }

  let target;
  try {
    target = new URL(src);
  } catch {
    return new Response('Invalid src URL', { status: 400 });
  }

  if (target.hostname !== ALLOWED_HOST) {
    return new Response('Host not allowed', { status: 403 });
  }

  let upstream;
  try {
    upstream = await fetch(target.toString());
  } catch {
    return new Response('Upstream fetch failed', { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream fetch failed', { status: upstream.status || 502 });
  }

  const headers = new Headers(upstream.headers);
  headers.set('Cache-Control', CACHE_CONTROL);
  // Vercel's edge network respects this header for its own CDN cache too.
  headers.set('CDN-Cache-Control', CACHE_CONTROL);
  headers.delete('set-cookie');

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

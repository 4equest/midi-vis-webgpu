type Env = {
  ASSETS: {
    fetch: (request: Request) => Promise<Response>
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const res = await env.ASSETS.fetch(request)

    // Preserve everything, just override browser cache behavior.
    const headers = new Headers(res.headers)
    if (res.ok) {
      if (url.pathname.startsWith('/assets/')) {
        headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate')
      }
    } else {
      headers.set('Cache-Control', 'no-store')
    }

    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  },
}


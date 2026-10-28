type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
type Handler = (request: Request) => Promise<Response>

/** Mirror Next's method rejection, automatic OPTIONS and GET-derived HEAD, privately. */
export function createAuthMethodPolicy(allowed: "GET" | "POST", handler: Handler): Record<Method, Handler> {
  const reject: Handler = async () => new Response(null, { status: 405, headers: { "Cache-Control": "private, no-store" } })
  const policy: Record<Method, Handler> = { GET: reject, HEAD: reject, POST: reject, PUT: reject, PATCH: reject, DELETE: reject, OPTIONS: async () => new Response(null, {
    status: 204,
    headers: { "Cache-Control": "private, no-store", Allow: allowed === "GET" ? "GET, HEAD, OPTIONS" : "OPTIONS, POST" },
  }) }
  policy[allowed] = handler
  if (allowed === "GET") policy.HEAD = async request => {
    const result = await handler(request)
    await result.body?.cancel()
    return new Response(null, { status: result.status, statusText: result.statusText, headers: result.headers })
  }
  return policy
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
  "Access-Control-Max-Age": "86400",
};

/** Respond to CORS preflight requests. */
export function handlePreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Clone a response with CORS headers added. */
export function addCorsHeaders(response: Response): Response {
  const patched = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    patched.headers.set(key, value);
  }
  return patched;
}

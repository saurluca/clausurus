/**
 * Join upstream base URL with request path + query.
 * If request path already starts with the upstream base pathname, use origin + request path
 * so `/v1` is not doubled.
 */
export function buildUpstreamUrl(upstreamBase: string, requestPathWithQuery: string): string {
  const base = new URL(upstreamBase);
  const qIndex = requestPathWithQuery.indexOf("?");
  const pathOnly = qIndex >= 0 ? requestPathWithQuery.slice(0, qIndex) : requestPathWithQuery;
  const query = qIndex >= 0 ? requestPathWithQuery.slice(qIndex) : "";

  const basePath = base.pathname.replace(/\/$/, "") || "";
  let joinedPath: string;
  if (basePath && (pathOnly === basePath || pathOnly.startsWith(basePath + "/"))) {
    joinedPath = pathOnly;
  } else if (
    (basePath === "/v1" || basePath.endsWith("/v1")) &&
    (pathOnly === "/v1" || pathOnly.startsWith("/v1/"))
  ) {
    // Client path already includes /v1; don't append it again onto a longer base.
    joinedPath = `${basePath.slice(0, -"/v1".length)}${pathOnly}`;
  } else {
    const req = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
    joinedPath = `${basePath}${req}`.replace(/\/{2,}/g, "/");
  }
  return `${base.origin}${joinedPath}${query}`;
}

export type ForwardResult = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export async function forwardRequest(opts: {
  upstreamUrl: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string | null;
  fetchFn?: typeof fetch;
}): Promise<ForwardResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const init: RequestInit = {
    method: opts.method,
    headers: opts.headers,
  };
  if (opts.body !== undefined && opts.body !== null && opts.method !== "GET" && opts.method !== "HEAD") {
    init.body = typeof opts.body === "string" ? opts.body : new Uint8Array(opts.body);
  }
  const res = await fetchFn(opts.upstreamUrl, init);
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
  };
}

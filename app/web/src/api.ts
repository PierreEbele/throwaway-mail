let csrfToken = "";
export function setCsrf(t: string | null | undefined) {
  if (t) csrfToken = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 204) return null as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    const details = Array.isArray(e?.details)
      ? e.details.map((d: { path: string; message: string }) => `${d.path ? d.path + ": " : ""}${d.message}`).join("; ")
      : "";
    throw new ApiError(
      res.status,
      e?.code ?? "error",
      `${e?.message ?? `HTTP ${res.status}`}${details ? ` — ${details}` : ""}`,
      e?.details,
    );
  }
  setCsrf(json?.csrf_token);
  return json as T;
}

export const get = <T>(p: string) => api<T>("GET", p);
export const post = <T>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const patch = <T>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const del = <T>(p: string) => api<T>("DELETE", p);

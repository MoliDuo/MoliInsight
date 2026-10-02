// Everything the pages know about the server goes through here.

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Set by the app shell: what to do when the session has ended. */
export const hooks = { unauthorized: () => {} };

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    hooks.unauthorized();
    throw new ApiError(401, "unauthorized");
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, json.error ?? String(response.status));
  return json as T;
}

/** A readable reason for a failed request. */
export function reason(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

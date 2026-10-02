/** A random UUID (v4 layout). `crypto.randomUUID` is missing outside secure contexts, so this does not use it. */
export const uuid = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 15) | 64;
  b[8] = (b[8]! & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** `ses_` and 20 random letters and digits: inside the protocol's 8 to 48. */
export const newId = (prefix: string): string => prefix + uuid().replaceAll("-", "").slice(0, 20);

/** Cuts a string to the protocol's usual 200 characters. */
export const cut = (text: string, n = 200): string => text.slice(0, n);

/** Runs `fn` and swallows whatever it throws: the platform must never break the app. */
export const safe = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
  try {
    fn(...a);
  } catch {
    /* never throw into the app */
  }
};

export const inBrowser = (): boolean => typeof window !== "undefined" && typeof document !== "undefined";

/** localStorage, or undefined when the browser refuses access (private mode, blocked storage). */
export const local = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

export const session = (): Storage | undefined => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

export const read = (store: Storage | undefined, key: string): string | undefined => {
  try {
    return store?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

export const readJson = (store: Storage | undefined, key: string): unknown => {
  try {
    return JSON.parse(read(store, key) ?? "");
  } catch {
    return undefined;
  }
};

export const write = (store: Storage | undefined, key: string, value: string | null): void => {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    /* quota or blocked: keep going without persistence */
  }
};

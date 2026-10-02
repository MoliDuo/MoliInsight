const FAMILY: Record<string, string> = { Version: "Safari", CriOS: "Chrome", FxiOS: "Firefox" };
const OS: Record<string, string> = { iPhone: "iOS", iPad: "iOS", "Mac OS X": "macOS" };

/** Coarse on purpose: a family and a major version, never the user agent string. Edge counts as Chrome. */
export function describeBrowser(ua: string): { os?: string; client?: string } {
  const os = /iPhone|iPad|Android|Windows|Mac OS X|Linux/.exec(ua)?.[0];
  const client = /(Chrome|CriOS|Firefox|FxiOS|Version)\/(\d+)/.exec(ua);
  return {
    ...(os && { os: OS[os] ?? os }),
    ...(client && { client: `${FAMILY[client[1]!] ?? client[1]} ${client[2]}` }),
  };
}

export function buildContext(release: string, deviceId: string | undefined): Record<string, unknown> {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(screen.width, screen.height) < 600;
  return {
    platform: "web",
    release,
    ...(deviceId ? { deviceId } : {}),
    deviceClass: coarse ? (small ? "phone" : "tablet") : "desktop",
    ...describeBrowser(navigator.userAgent),
    viewport: [innerWidth || 1, innerHeight || 1],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    standalone: matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true,
  };
}

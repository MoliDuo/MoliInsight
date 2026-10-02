/** The protocol version this package implements. */
export const SCHEMA_VERSION = 1;

/**
 * Every numeric limit of ingest protocol v1 in one place. The server, the
 * clients and the docs all read these numbers, so a limit changes here only.
 */
export const LIMITS = {
  /** Largest request body as sent (still compressed), in bytes. */
  maxBodyBytes: 64 * 1024,
  /** Largest request body after decompression, in bytes. Guards against gzip bombs. */
  maxDecompressedBytes: 512 * 1024,
  maxEventsPerBatch: 100,

  eventNameMaxLength: 64,
  routeMaxLength: 200,
  correlationIdMaxLength: 64,

  /** Nesting levels in `props`: the props object itself is level 1. */
  propsMaxDepth: 3,
  /** Serialised size of `props` (UTF-8 JSON), after truncation, in bytes. */
  propsMaxBytes: 4096,
  /** Longer strings are cut to this many characters, not rejected. */
  propStringMaxLength: 200,
  propArrayMaxItems: 20,
  propKeyMaxLength: 64,

  /** An event may not be newer than the receive time by more than this. */
  maxFutureMs: 5 * 60 * 1000,
  /** An event may not be older than the receive time by more than this. */
  maxPastMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Secrets start with a prefix, so a secret scanner or a person can tell what a leaked string is. */
export const KEY_PREFIXES = {
  /** Write-only. Embedded in a relay's environment, or in a native client. */
  ingest: "mi_",
  /** Read access for export and MCP. Never leaves the machines of the people who run the platform. */
  admin: "mia_",
} as const;

/**
 * The public API of the web SDK, final for v0.1. `docs/sdk-api.md` describes it
 * in prose; this file is what the implementation has to satisfy.
 *
 * Every function is safe to call during server-side rendering and does nothing
 * there. Nothing here throws: a failure inside the SDK is swallowed.
 */

/** The localStorage key that holds the device id. Apps must keep it when they clear storage on logout. */
export const DEVICE_ID_STORAGE_KEY = "moli_insight_device_id";

/** Queued events live under `${QUEUE_STORAGE_PREFIX}<tabId>`, one key per tab. */
export const QUEUE_STORAGE_PREFIX = "moli_insight_q_";

/** Apps clear storage on logout: this is the prefix of every key that must survive that. */
export const STORAGE_KEY_PREFIX = "moli_insight_";

export type PropValue =
  | string
  | number
  | boolean
  | null
  | PropValue[]
  | { [key: string]: PropValue };
export type Props = { [key: string]: PropValue };

export interface AutoCaptureOptions {
  /** `$tap`. Default true. */
  taps?: boolean;
  /** `$rage_tap`. Default true. */
  rage?: boolean;
  /** `$dead_tap`. Default true. */
  dead?: boolean;
  /** `$error`, from window errors and unhandled rejections. Default true. */
  errors?: boolean;
  /** `$screen` from history changes. Default true; turn off when the framework calls `trackScreen`. */
  screens?: boolean;
  /** `$visibility` and the `activeMs` that feeds usage time. Default true. */
  visibility?: boolean;
}

export interface InitOptions {
  /** Where batches are posted. Normally the app's own same-origin relay, such as "/api/telemetry". */
  endpoint: string;
  /** The app's version, usually the git SHA of the deploy. */
  release: string;
  /** Pass `false` to turn all auto-capture off. */
  autoCapture?: AutoCaptureOptions | false;
  /** Start disabled, for example until the user has signed in. Default true. */
  enabled?: boolean;
}

export interface VitalMetric {
  name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
}

export interface OpResult {
  ok: boolean;
  errorKind?: string;
  props?: Props;
}

/** Returned by `startOp`. Call `end` once; later calls are ignored. */
export interface OpHandle {
  end(result: OpResult): void;
}

export type ScreenVia = "push" | "replace" | "back" | "link" | "app";

export interface InsightWeb {
  init(options: InitOptions): void;
  /** Records an app event, such as `track("record.submit", { imageCount: 2 })`. */
  track(name: string, props?: Props): void;
  /** For framework router hooks, such as Next's `onRouterTransitionStart`. */
  trackScreen(screen: string, via?: ScreenVia): void;
  /** Takes the object a web-vitals callback gives, such as Next's `useReportWebVitals`. */
  reportVital(metric: VitalMetric): void;
  /** Starts timing an operation. `end` records `$op` with `ms` filled in. */
  startOp(op: string): OpHandle;
  trackDialog(name: string, action: "open" | "close", options?: { closeBy?: string }): void;
  /** Sends what is queued now. Resolves when the attempt finished; never rejects. */
  flush(): Promise<void>;
  setEnabled(enabled: boolean): void;
  /** The device id, or undefined during SSR or when storage is unavailable. */
  getDeviceId(): string | undefined;
}

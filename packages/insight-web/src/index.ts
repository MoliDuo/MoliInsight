import { createClient } from "./client.ts";

export * from "./types.ts";

const client = /* @__PURE__ */ createClient();

export const init = client.init;
export const track = client.track;
export const trackScreen = client.trackScreen;
export const reportVital = client.reportVital;
export const startOp = client.startOp;
export const trackDialog = client.trackDialog;
export const flush = client.flush;
export const setEnabled = client.setEnabled;
export const getDeviceId = client.getDeviceId;

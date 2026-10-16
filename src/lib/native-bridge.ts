// The iPhone app's web view adds message handlers under `window.webkit`; in a browser they are missing.
type AppHandler = { postMessage(message: unknown): void };
export type AppMessage = "travellerSave" | "travellerTripMode";

function handler(name: AppMessage): AppHandler | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { webkit?: { messageHandlers?: Partial<Record<string, AppHandler>> } }).webkit?.messageHandlers?.[name];
}

export const appHandles = (name: AppMessage) => Boolean(handler(name));
// Trip mode is native in the app; everything else is this site.
export const inApp = () => appHandles("travellerTripMode");

// Sends a message to the app. False in a browser, where the caller does it the web way.
export function postToApp(name: AppMessage, message: unknown) {
  const target = handler(name);
  if (!target) return false;
  target.postMessage(message);
  return true;
}

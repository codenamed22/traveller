// Consent to share trip details with the agent, kept in this browser: for the trip assistant, and for caption
// suggestions from the iPhone app. Bump a version when what that use shares changes, so everyone is asked again.
const consents = {
  assistant: { key: "traveller.assistant.consent", version: "1" },
  captions: { key: "traveller.captions.consent", version: "1" },
};
export type ConsentUse = keyof typeof consents;

export function hasConsent(use: ConsentUse) {
  try { return window.localStorage.getItem(consents[use].key) === consents[use].version; } catch { return false; }
}

export function giveConsent(use: ConsentUse) {
  try { window.localStorage.setItem(consents[use].key, consents[use].version); } catch { /* then it's asked for again next time */ }
}

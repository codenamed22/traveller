"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type Ref } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { ArrowUp, Check, ChevronLeft, ChevronRight, LoaderCircle, RotateCcw, Route, Search, ShieldCheck, Sparkles, Square, SquarePen } from "lucide-react";
import { proposalOutputSchema, type Operation, type ProposalOutput } from "@/lib/assistant-ops";
import type { Journey } from "@/lib/journey";

export type AssistantView = { cityId: string; day: number; tripMode: boolean; today: boolean };
export type ApplyOutcome = { ok: true; token: string; stale: { id: string; city: string }[] } | { ok: false; error: string };
export type CardState = { status: "applied"; token: string; stale: { id: string; city: string }[] } | { status: "undone" } | { status: "dismissed" } | { status: "failed"; error: string };
type Props = {
  journey: Journey; view: AssistantView; model: string;
  onApply: (operations: Operation[]) => ApplyOutcome;
  // Returns why the change can't be undone, or null once it is.
  onUndo: (token: string) => string | null;
  onReplan: (cityId: string) => void;
  ref?: Ref<AssistantHandle>;
};
// Sends a message for the traveller, such as a planning failure: it opens the panel and sends once consent is given.
export type AssistantHandle = { ask: (text: string) => void };

// Bump the version when what the assistant shares changes, so everyone is asked again.
const consentKey = "traveller.assistant.consent";
const consentVersion = "1";
function hasConsent() {
  try { return window.localStorage.getItem(consentKey) === consentVersion; } catch { return false; }
}
function errorText(error: Error) {
  try { const parsed = JSON.parse(error.message); if (typeof parsed?.error === "string") return parsed.error; } catch { /* not a JSON error body */ }
  return "The assistant couldn't answer. Try again.";
}

// A chat that answers questions about the trip and suggests small changes as cards to apply. It hides behind a tab on
// the right edge; opening it adds an #assistant history entry so the back button or gesture closes it again.
export function Assistant({ journey, view, model, onApply, onUndo, onReplan, ref }: Props) {
  const [open, setOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [input, setInput] = useState("");
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const pushed = useRef(false);
  const afterClose = useRef<(() => void) | null>(null);
  const drag = useRef<number | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // A request waiting for consent before it is sent.
  const pending = useRef<string | null>(null);
  // Each request carries the recent conversation, the trip as it is now (see context()) and a fresh operation id for the
  // usage limit.
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/assistant", prepareSendMessagesRequest: ({ messages, body }) => ({
    body: { ...body, messages: messages.slice(-24), operationId: crypto.randomUUID() },
  }) }), []);
  const { messages, sendMessage, status, error, stop, setMessages, regenerate, clearError } = useChat({ id: journey.id, transport });
  const busy = status === "submitted" || status === "streaming";

  // A reload on #assistant starts closed, without the entry.
  useEffect(() => { if (window.location.hash === "#assistant") window.history.replaceState(null, "", window.location.pathname + window.location.search); }, []);
  useEffect(() => {
    if (!open) return;
    const pop = () => {
      if (window.location.hash === "#assistant") return;
      pushed.current = false; setOpen(false);
      const next = afterClose.current; afterClose.current = null; next?.();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      if (pushed.current) window.history.back(); else setOpen(false);
    };
    window.addEventListener("popstate", pop); window.addEventListener("keydown", escape);
    document.body.classList.add("assistant-open");
    return () => { window.removeEventListener("popstate", pop); window.removeEventListener("keydown", escape); document.body.classList.remove("assistant-open"); };
  }, [open]);
  useEffect(() => { log.current?.scrollTo?.({ top: log.current.scrollHeight }); }, [messages, status, open]);
  useEffect(() => {
    // Only where there is a keyboard already; on phones focusing would cover the chat with one.
    if (open && consented && window.matchMedia?.("(pointer: fine)").matches) field.current?.focus({ preventScroll: true });
  }, [open, consented]);

  const context = () => ({ body: { journey, view: { cityId: view.cityId, day: view.day, tripMode: view.tripMode }, consent: true, provider: { provider: "openrouter", model } } });

  function show() {
    setConsented(hasConsent()); setOpen(true);
    if (window.location.hash !== "#assistant") { window.history.pushState(null, "", "#assistant"); pushed.current = true; }
  }
  function hide(then?: () => void) {
    if (pushed.current) { afterClose.current = then ?? null; window.history.back(); return; }
    setOpen(false); then?.();
  }
  function accept() {
    try { window.localStorage.setItem(consentKey, consentVersion); } catch { /* consent then lasts for this visit only */ }
    setConsented(true);
    const waiting = pending.current; pending.current = null;
    if (waiting) send(waiting);
  }
  function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    clearError(); setInput("");
    void sendMessage({ text: message.slice(0, 2000) }, context());
  }
  useImperativeHandle(ref, () => ({ ask(text: string) {
    show();
    if (hasConsent()) send(text); else pending.current = text;
  } }));
  function submit(event: FormEvent) { event.preventDefault(); send(input); }
  function apply(id: string, proposal: ProposalOutput) {
    const outcome = onApply(proposal.operations);
    setCards((current) => ({ ...current, [id]: outcome.ok ? { status: "applied", token: outcome.token, stale: outcome.stale } : { status: "failed", error: outcome.error } }));
  }
  function undo(id: string, token: string) {
    const problem = onUndo(token);
    setCards((current) => ({ ...current, [id]: problem ? { status: "failed", error: problem } : { status: "undone" } }));
  }

  const suggestions = view.tripMode || view.today
    ? ["What's next?", "I'm running 30 minutes late", "I've finished my current visit"]
    : ["What could I still fit in?", `Make Day ${view.day + 1} lighter`, "Start each day 30 minutes earlier"];
  const waiting = status === "submitted" || (status === "streaming" && !messages.at(-1)?.parts.some((part) => part.type === "text" && part.text));
  // A reply can end with nothing to show, for example when the model kept proposing changes that failed their checks.
  const last = messages.at(-1);
  const silent = status === "ready" && last?.role === "assistant" && !last.parts.some((part) => (part.type === "text" && part.text.trim())
    || (isToolUIPart(part) && getToolName(part) === "propose_changes" && part.state === "output-available" && proposalOutputSchema.safeParse(part.output).data?.ok));

  return <>
    {!open && <button type="button" className="assistant-tab" aria-label="Open trip assistant" title="Trip assistant"
      onClick={show}
      onPointerDown={(event) => { drag.current = event.clientX; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current !== null && drag.current - event.clientX > 24) { drag.current = null; show(); } }}
      onPointerUp={() => { drag.current = null; }}
    ><ChevronLeft size={14} /><Sparkles size={17} /></button>}
    <aside className={`assistant-panel ${open ? "open" : ""}`} aria-label="Trip assistant" aria-hidden={!open} inert={!open}>
      <header className="assistant-header">
        <span className="assistant-mark"><Sparkles size={16} /></span>
        <strong>Trip assistant</strong>
        {messages.length > 0 && <button type="button" className="icon-button" title="New chat" aria-label="New chat" disabled={busy} onClick={() => { setMessages([]); setCards({}); clearError(); }}><SquarePen size={17} /></button>}
        <button type="button" className="icon-button" title="Close" aria-label="Close trip assistant" onClick={() => hide()}><ChevronRight size={19} /></button>
      </header>
      {!consented ? <div className="assistant-consent">
        <ShieldCheck size={26} />
        <h3>Before you chat</h3>
        <p>Your messages and trip details are shared with an AI service to answer. Charges apply based on AI and map usage.</p>
        <p>Nothing changes until you tap Apply.</p>
        <button type="button" className="button primary" onClick={accept}><Check size={16} />I agree, start chatting</button>
      </div> : <>
        <div className="assistant-log" ref={log} aria-live="polite">
          {!messages.length && <div className="assistant-empty">
            <p>Ask about your plan or tell me what to change. I&apos;ll suggest it as a card for you to apply.</p>
            <div className="assistant-chips">{suggestions.map((text) => <button type="button" key={text} onClick={() => send(text)}>{text}</button>)}</div>
          </div>}
          <AssistantMessages messages={messages} cards={cards} onApply={apply} onDismiss={(id) => setCards((current) => ({ ...current, [id]: { status: "dismissed" } }))} onUndo={undo} onReplan={(cityId) => hide(() => onReplan(cityId))} />
          {silent && <p className="assistant-note">I couldn&apos;t work that one out. Try saying it another way, or make the change in the editor.</p>}
          {waiting && <p className="assistant-thinking"><LoaderCircle size={14} className="spin" />Thinking…</p>}
          {error && <div className="assistant-error" role="alert"><span>{errorText(error)}</span><button type="button" className="button secondary small" onClick={() => { clearError(); void regenerate(context()); }}>Try again</button></div>}
        </div>
        <form className="assistant-input" onSubmit={submit}>
          <textarea ref={field} rows={1} value={input} maxLength={2000} placeholder="Ask or tell me what to change…" aria-label="Message the trip assistant"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(input); } }} />
          {busy ? <button type="button" className="round-send" aria-label="Stop" title="Stop" onClick={() => void stop()}><Square size={14} /></button>
            : <button type="submit" className="round-send" aria-label="Send" title="Send" disabled={!input.trim()}><ArrowUp size={17} /></button>}
        </form>
      </>}
    </aside>
  </>;
}

type MessagesProps = {
  messages: UIMessage[]; cards: Record<string, CardState>;
  onApply: (id: string, proposal: ProposalOutput) => void; onDismiss: (id: string) => void; onUndo: (id: string, token: string) => void; onReplan: (cityId: string) => void;
};

// Replies are plain text. Proposals become cards; a proposal that failed its checks is left out, since the assistant
// explains it in words. Place lookups show as a quiet line.
export function AssistantMessages({ messages, cards, onApply, onDismiss, onUndo, onReplan }: MessagesProps) {
  return <>{messages.map((message) => <div key={message.id} className={`assistant-message ${message.role}`}>
    {message.parts.map((part, index) => {
      if (part.type === "text") return part.text.trim() ? <p key={index} className="assistant-text">{part.text}</p> : null;
      if (!isToolUIPart(part)) return null;
      const name = getToolName(part);
      if (name === "find_place") {
        const query = typeof (part.input as { query?: unknown } | undefined)?.query === "string" ? (part.input as { query: string }).query : "a place";
        return <p key={index} className="assistant-note"><Search size={13} />{part.state === "output-available" ? "Looked up" : "Looking up"} “{query}” on Google</p>;
      }
      if (name !== "propose_changes") return null;
      if (part.state !== "output-available") return part.state === "input-streaming" || part.state === "input-available" ? <p key={index} className="assistant-note"><LoaderCircle size={13} className="spin" />Preparing a suggestion…</p> : null;
      const proposal = proposalOutputSchema.safeParse(part.output);
      if (!proposal.success || !proposal.data.ok) return null;
      const id = part.toolCallId;
      return <ProposalCard key={index} proposal={proposal.data} state={cards[id]} onApply={() => onApply(id, proposal.data)} onDismiss={() => onDismiss(id)} onUndo={(token) => onUndo(id, token)} onReplan={onReplan} />;
    })}
  </div>)}</>;
}

export function ProposalCard({ proposal, state, onApply, onDismiss, onUndo, onReplan }: { proposal: ProposalOutput; state?: CardState; onApply: () => void; onDismiss: () => void; onUndo: (token: string) => void; onReplan: (cityId: string) => void }) {
  if (state?.status === "dismissed") return <p className="assistant-note">Dismissed: {proposal.summary}</p>;
  return <section className={`proposal-card ${state?.status ?? "pending"}`} aria-label={`Suggestion: ${proposal.summary}`}>
    <h3>{proposal.summary}</h3>
    <ul className="proposal-changes">{proposal.changes.map((line, index) => <li key={index}>{line}</li>)}</ul>
    {proposal.warnings.length > 0 && <ul className="proposal-warnings">{proposal.warnings.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    {state?.status === "failed" && <p className="proposal-error" role="alert">{state.error}</p>}
    <div className="proposal-actions">
      {!state && <><button type="button" className="button primary small" onClick={onApply}><Check size={15} />Apply</button><button type="button" className="button secondary small" onClick={onDismiss}>Dismiss</button></>}
      {state?.status === "applied" && <>
        <span className="proposal-status"><Check size={14} />Applied</span>
        <button type="button" className="button secondary small" onClick={() => onUndo(state.token)}><RotateCcw size={14} />Undo</button>
        {state.stale.map((city) => <button type="button" key={city.id} className="button secondary small" onClick={() => onReplan(city.id)}><Route size={14} />Replan {city.city}</button>)}
      </>}
      {state?.status === "undone" && <span className="proposal-status">Undone</span>}
    </div>
  </section>;
}

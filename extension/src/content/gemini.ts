export const COMPOSER_SELECTORS = [
  "rich-textarea .ql-editor",
  ".ql-editor[contenteditable='true']",
  "div[contenteditable='true'][role='textbox']",
];

export function conversationId(pathname: string): string | null {
  const m = pathname.match(/\/app\/([^/?#]+)/);
  return m?.[1] ?? null;
}

export function findComposer(doc: Document): HTMLElement | null {
  for (const sel of COMPOSER_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el instanceof HTMLElement) return el;
  }
  return null;
}

/** Last enabled button in the composer bar. Matched by position, not localized label. */
export function findSendButton(doc: Document): HTMLElement | null {
  const marked = doc.querySelector("button.send-button");
  if (marked instanceof HTMLElement) return marked;
  const rich = doc.querySelector("rich-textarea");
  const root = rich?.parentElement ?? null;
  if (!root) return null;
  const buttons = [...root.querySelectorAll("button")].filter(
    (b) => b instanceof HTMLButtonElement && !b.disabled && b.getAttribute("aria-disabled") !== "true",
  );
  return buttons.at(-1) ?? null;
}

export function checkHealth(doc: Document): "ok" | "broken" {
  return findComposer(doc) && findSendButton(doc) ? "ok" : "broken";
}

export function readComposer(editor: HTMLElement): string {
  return (editor.innerText ?? editor.textContent ?? "").replace(/\u00a0/g, " ").replace(/\n$/, "");
}

/** Quill keeps its own model. insertText updates it; assigning textContent does not. */
export function writeComposer(editor: HTMLElement, text: string): void {
  const doc = editor.ownerDocument;
  editor.focus();
  const view = doc.defaultView;
  const sel = view?.getSelection?.() ?? null;
  if (sel && typeof doc.execCommand === "function") {
    const range = doc.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    if (doc.execCommand("insertText", false, text)) return;
  }
  editor.textContent = text;
}

export type MaskResult = { ok: true; masked: string } | { ok: false; error: string };

export type SendHookDeps = {
  isEnabled(): boolean;
  getEditor(): HTMLElement | null;
  getSendButton(): HTMLElement | null;
  onSend(text: string): Promise<MaskResult>;
  showError(message: string): void;
};

/**
 * Capture Enter and Send, mask, then re-dispatch once.
 * The pass flag stops the re-dispatch from being masked again.
 */
export function installSendHook(doc: Document, deps: SendHookDeps): () => void {
  let pass = false;
  let busy = false;

  const run = async (kind: "key" | "click", event: Event, editor: HTMLElement): Promise<void> => {
    const text = readComposer(editor);
    if (!text.trim()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    let result: MaskResult;
    try {
      result = await deps.onSend(text);
    } catch {
      result = { ok: false, error: "detector_failed" };
    }
    if (!result.ok) {
      busy = false;
      deps.showError("PII detection failed. The message was not sent.");
      return;
    }
    if (result.masked !== text) writeComposer(editor, result.masked);
    pass = true;
    busy = false;
    const view = doc.defaultView;
    if (!view) return;
    if (kind === "key") {
      editor.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    } else {
      deps.getSendButton()?.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    pass = false;
  };

  const onKey = (event: Event): void => {
    if (pass || !deps.isEnabled()) return;
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.repeat) return;
    const editor = deps.getEditor();
    if (!editor || !editor.contains(event.target as Node)) return;
    void run("key", event, editor);
  };

  const onClick = (event: Event): void => {
    if (pass || !deps.isEnabled()) return;
    const button = deps.getSendButton();
    if (!button || !button.contains(event.target as Node)) return;
    const editor = deps.getEditor();
    if (!editor) {
      event.preventDefault();
      event.stopImmediatePropagation();
      deps.showError("PII protection lost the composer. The message was not sent.");
      return;
    }
    void run("click", event, editor);
  };

  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("click", onClick, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("click", onClick, true);
  };
}

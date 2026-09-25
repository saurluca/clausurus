export const COMPOSER_SELECTORS = [
  "rich-textarea .ql-editor",
  ".ql-editor[contenteditable='true']",
  "div[contenteditable='true'][role='textbox']",
  "[aria-label='Enter a prompt for Gemini']",
];

const SEND_LABEL = /send|senden/i;

export function conversationId(pathname: string): string | null {
  const m = pathname.match(/\/app\/([^/?#]+)/);
  return m?.[1] ?? null;
}

/** querySelector stops at a shadow root. Gemini puts the composer in one. */
function isElement(node: EventTarget | null): node is HTMLElement {
  return !!node && (node as Node).nodeType === 1;
}

function queryDeep(root: ParentNode, selector: string): HTMLElement | null {
  const found = root.querySelector(selector);
  if (isElement(found)) return found;
  for (const el of root.querySelectorAll("*")) {
    if (!el.shadowRoot) continue;
    const inner = queryDeep(el.shadowRoot, selector);
    if (inner) return inner;
  }
  return null;
}

export function findComposer(doc: Document): HTMLElement | null {
  for (const sel of COMPOSER_SELECTORS) {
    const el = queryDeep(doc, sel);
    if (el) return el;
  }
  return null;
}

function enabledButton(el: HTMLElement | null): HTMLElement | null {
  if (!el || el.tagName !== "BUTTON") return null;
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return null;
  return el;
}

/** Send control, including one inside an open shadow root. Label covers EN and DE. */
function queryAllDeep(root: ParentNode, selector: string, out: HTMLElement[] = []): HTMLElement[] {
  for (const el of root.querySelectorAll(selector)) {
    if (isElement(el)) out.push(el);
  }
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) queryAllDeep(el.shadowRoot, selector, out);
  }
  return out;
}

export function findSendButton(doc: Document): HTMLElement | null {
  const marked = enabledButton(queryDeep(doc, "button.send-button"));
  if (marked) return marked;
  for (const labelled of queryAllDeep(doc, "button[aria-label]")) {
    if (SEND_LABEL.test(labelled.getAttribute("aria-label") ?? "")) {
      const hit = enabledButton(labelled);
      if (hit) return hit;
    }
  }
  const rich = queryDeep(doc, "rich-textarea");
  const root = rich?.parentElement ?? rich?.getRootNode();
  const scope = root instanceof Document || root instanceof ShadowRoot ? root : rich?.parentElement;
  if (!scope) return null;
  const buttons = [...scope.querySelectorAll("button")].filter((b) => enabledButton(isElement(b) ? b : null));
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


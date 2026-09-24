const MARK = "data-pii";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace fake strings in text nodes. Skips spans this function already wrote. */
export function restoreIn(root: ParentNode, pairs: Array<[string, string]>): void {
  const usable = pairs.filter(([fake]) => fake.length > 0);
  if (!usable.length) return;
  const doc = root.ownerDocument ?? document;
  const lookup = new Map(usable);
  const re = new RegExp(usable.map(([fake]) => escapeRegExp(fake)).join("|"), "g");
  const view = doc.defaultView ?? window;
  const walker = doc.createTreeWalker(root, view.NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  for (const node of nodes) {
    if (node.parentElement?.closest(`[${MARK}]`)) continue;
    const text = node.data;
    if (!text) continue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(re)) {
      const index = match.index ?? 0;
      if (index > last) frag.append(text.slice(last, index));
      const fake = match[0];
      const span = doc.createElement("span");
      span.setAttribute(MARK, "1");
      span.title = `masked as ${fake}`;
      span.style.textDecoration = "underline dotted";
      span.textContent = lookup.get(fake) ?? fake;
      frag.append(span);
      last = index + fake.length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

export const RESTORE_SELECTORS = ["user-query", "model-response", "a[href*='/app/']"];

export function installRestorer(
  doc: Document,
  getPairs: () => Array<[string, string]>,
): { refresh(): void; stop(): void } {
  let scheduled = false;
  const scan = (): void => {
    const pairs = getPairs();
    if (!pairs.length || !doc.body) return;
    for (const el of doc.body.querySelectorAll(RESTORE_SELECTORS.join(","))) {
      restoreIn(el, pairs);
    }
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    const view = doc.defaultView;
    const frame = view?.requestAnimationFrame?.bind(view);
    const run = (): void => {
      scheduled = false;
      scan();
    };
    if (frame) frame(run);
    else run();
  };
  const observer = new MutationObserver(schedule);
  if (doc.body) observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
  schedule();
  return {
    refresh: schedule,
    stop: () => observer.disconnect(),
  };
}

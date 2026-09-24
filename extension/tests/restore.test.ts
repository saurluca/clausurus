import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { restoreIn } from "../src/content/restore.js";

function docWith(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

describe("restoreIn", () => {
  test("swaps a fake back and records what was sent", () => {
    const doc = docWith("<user-query>Hello Mira Sol</user-query>");
    const root = doc.querySelector("user-query")!;
    restoreIn(root, [["Mira Sol", "Ada Lovelace"]]);
    const span = root.querySelector("span[data-pii]");
    expect(span?.textContent).toBe("Ada Lovelace");
    expect(span?.getAttribute("title")).toBe("masked as Mira Sol");
    expect(root.textContent).toBe("Hello Ada Lovelace");
  });

  test("does not rewrite a span it already restored", () => {
    const doc = docWith("<model-response>Ada Lovelace</model-response>");
    const root = doc.querySelector("model-response")!;
    const span = doc.createElement("span");
    span.setAttribute("data-pii", "1");
    span.textContent = "Ada Lovelace";
    root.replaceChildren(span);
    restoreIn(root, [["Ada Lovelace", "Should Not Apply"]]);
    expect(root.textContent).toBe("Ada Lovelace");
  });

  test("longest fake is applied when pairs are pre-sorted", () => {
    const doc = docWith("<user-query>Ann Marie</user-query>");
    restoreIn(doc.querySelector("user-query")!, [
      ["Ann Marie", "Full Name"],
      ["Ann", "Short"],
    ]);
    expect(doc.body.textContent).toBe("Full Name");
  });
});

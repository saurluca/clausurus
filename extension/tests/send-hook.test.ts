import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { findComposer, findSendButton, writeComposer } from "../src/content/gemini.js";
import { bodyHasDraft, spliceDraft } from "../src/content/rewrite.js";

function page(): { doc: Document; editor: HTMLElement; button: HTMLButtonElement; window: Window } {
  const window = new Window();
  window.document.body.innerHTML = `
    <rich-textarea><div class="ql-editor" contenteditable="true">ada@example.com</div></rich-textarea>
    <button class="send-button" type="button">Send</button>
  `;
  const doc = window.document as unknown as Document;
  return {
    window,
    doc,
    editor: doc.querySelector(".ql-editor") as HTMLElement,
    button: doc.querySelector(".send-button") as HTMLButtonElement,
  };
}

describe("findComposer", () => {
  test("reads the editor inside an open shadow root", () => {
    const window = new Window();
    const host = window.document.createElement("div");
    window.document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <button aria-label="Use microphone" type="button"></button>
      <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox">erika</div></rich-textarea>
      <button aria-label="Nachricht senden" type="button"></button>
    `;
    const doc = window.document as unknown as Document;
    expect(findComposer(doc)?.textContent).toBe("erika");
    expect(findSendButton(doc)?.getAttribute("aria-label")).toBe("Nachricht senden");
  });
});

describe("spliceDraft", () => {
  test("replaces the raw prompt and a JSON-escaped prompt", () => {
    expect(spliceDraft("mail ada@example.com", "ada@example.com", "fake@example.com")).toBe("mail fake@example.com");
    const body = JSON.stringify(["say hi\nthere"]);
    expect(bodyHasDraft(body, "hi\nthere")).toBe(true);
    expect(spliceDraft(body, "hi\nthere", "hello")).toBe(JSON.stringify(["say hello"]));
  });

  test("leaves a body that does not contain the draft", () => {
    expect(bodyHasDraft("other", "ada@example.com")).toBe(false);
    expect(spliceDraft("other", "ada@example.com", "fake@example.com")).toBe("other");
  });

  test("writeComposer uses execCommand when it succeeds", () => {
    const { doc, editor } = page();
    let inserted = "";
    doc.execCommand = ((command: string, _show: boolean, value?: string) => {
      if (command === "insertText" && value !== undefined) {
        inserted = value;
        editor.textContent = value;
        return true;
      }
      return false;
    }) as Document["execCommand"];
    writeComposer(editor, "masked");
    expect(inserted).toBe("masked");
  });
});

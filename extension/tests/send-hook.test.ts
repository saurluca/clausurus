import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { findComposer, findSendButton, installSendHook, writeComposer } from "../src/content/gemini.js";

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

describe("installSendHook", () => {
  test("masks once and re-dispatches the click", async () => {
    const { doc, editor, button } = page();
    let calls = 0;
    let pageSends = 0;
    button.addEventListener("click", () => {
      pageSends++;
    });
    installSendHook(doc, {
      isEnabled: () => true,
      getEditor: () => editor,
      getSendButton: () => button,
      showError: () => {},
      onSend: async () => {
        calls++;
        return { ok: true, masked: "fake@example.com" };
      },
    });
    button.dispatchEvent(new doc.defaultView!.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(pageSends).toBe(1);
    expect(editor.textContent).toBe("fake@example.com");
  });

  test("does not re-dispatch when detection fails", async () => {
    const { doc, editor, button } = page();
    let pageSends = 0;
    button.addEventListener("click", () => {
      pageSends++;
    });
    let shown = "";
    installSendHook(doc, {
      isEnabled: () => true,
      getEditor: () => editor,
      getSendButton: () => button,
      showError: (message) => {
        shown = message;
      },
      onSend: async () => ({ ok: false, error: "timeout" }),
    });
    button.dispatchEvent(new doc.defaultView!.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(pageSends).toBe(0);
    expect(editor.textContent).toBe("ada@example.com");
    expect(shown).toContain("timeout");
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

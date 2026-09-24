const HOST_ID = "apertus-pii-toast";

export function showToast(doc: Document, message: string): void {
  let host = doc.getElementById(HOST_ID);
  if (!host) {
    host = doc.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      .box {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 2147483647;
        max-width: 420px;
        padding: 10px 12px;
        border-radius: 8px;
        background: #1c1c1c;
        color: #f5f5f5;
        font: 13px/1.4 system-ui, sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,.25);
      }
    </style><div class="box"></div>`;
    doc.documentElement.append(host);
  }
  const box = host.shadowRoot?.querySelector(".box");
  if (!box) return;
  box.textContent = message;
  host.hidden = false;
  const view = doc.defaultView;
  view?.setTimeout(() => {
    if (host) host.hidden = true;
  }, 20000);
}

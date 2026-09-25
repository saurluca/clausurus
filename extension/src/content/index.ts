import { detectRegex } from "../../../src/detect/regex.js";
import { conversationId, findComposer, findSendButton, readComposer } from "./gemini.js";
import { installRestorer } from "./restore.js";
import { bodyHasDraft, spliceDraft } from "./rewrite.js";
import { defaultSettings, normalizeSettings, SETTINGS_KEY, type Settings } from "../settings.js";
import { pushLog } from "../log.js";
import { showToast } from "./toast.js";

const CHANNEL = "apertus-pii";

const FIXTURE_HOST = "127.0.0.1";
const FIXTURE_PORT = "8765";

function onWatchedPage(): boolean {
  const { hostname, port } = location;
  if (hostname === "gemini.google.com") return true;
  return hostname === FIXTURE_HOST && port === FIXTURE_PORT && document.documentElement.dataset.piiFixture === "1";
}

if (onWatchedPage()) boot();

/** False after the extension is reloaded while this page is still open. */
function runtimeAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function send(message: object, done?: (res: { ok?: boolean; error?: string; pairs?: unknown; masked?: string } | undefined) => void): void {
  const fail = (error: string): void => {
    pushLog(error);
    done?.({ ok: false, error });
  };
  if (!runtimeAlive()) {
    fail("extension context invalidated; reload the Gemini tab");
    return;
  }
  try {
    chrome.runtime.sendMessage(message, (res) => {
      if (!runtimeAlive()) {
        fail("extension context invalidated; reload the Gemini tab");
        return;
      }
      try {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError) {
          fail(runtimeError);
          return;
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : "extension context invalidated");
        return;
      }
      done?.(res);
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : "extension context invalidated");
  }
}

function boot(): void {
  console.log("apertus: content script booted", location.href);
  let settings: Settings = defaultSettings();
  let pairs: Array<[string, string]> = [];
  let convId = conversationId(location.pathname);
  let lastDraft = "";

  const restorer = installRestorer(document, () => pairs);

  const refreshSettings = (): void => {
    if (!runtimeAlive()) return;
    try {
      chrome.storage.sync.get(SETTINGS_KEY, (stored) => {
        settings = normalizeSettings(stored[SETTINGS_KEY]);
        document.documentElement.dataset.piiReady = "1";
      });
    } catch {
      // extension was reloaded
    }
  };
  refreshSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) refreshSettings();
  });

  const pullPairs = (): void => {
    send({ type: "getPairs", conversationId: convId }, (res) => {
      if (res?.ok && Array.isArray(res.pairs)) {
        pairs = res.pairs as Array<[string, string]>;
        restorer.refresh();
      }
    });
  };
  pullPairs();

  send({ type: "warmup" });

  const remember = (): void => {
    const el = findComposer(document);
    const text = el ? readComposer(el) : "";
    if (text.trim()) lastDraft = text;
  };
  window.addEventListener("input", remember, true);
  window.addEventListener("keydown", remember, true);
  window.addEventListener("click", remember, true);

  let prewarmTimer = 0;
  window.addEventListener(
    "input",
    () => {
      const text = lastDraft;
      if (!text.trim() || !settings.enabled) return;
      window.clearTimeout(prewarmTimer);
      prewarmTimer = window.setTimeout(() => send({ type: "prewarm", text }), 400);
    },
    true,
  );

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { channel?: string; type?: string; id?: string; body?: string };
    if (!data || data.channel !== CHANNEL || data.type !== "mask-request" || !data.id) return;
    const reply = (payload: { ok: boolean; body?: string; error?: string }): void => {
      window.postMessage({ channel: CHANNEL, type: "mask-result", id: data.id, ...payload }, "*");
    };
    const body = typeof data.body === "string" ? data.body : "";
    const draft = lastDraft;
    if (!settings.enabled || !bodyHasDraft(body, draft)) {
      reply({ ok: true, body });
      return;
    }
    send(
      {
        type: "mask",
        text: draft,
        conversationId: convId,
        regex: detectRegex(draft),
        timeoutMs: settings.detectorTimeoutMs,
      },
      (res) => {
        if (!res?.ok || typeof res.masked !== "string") {
          const error = res?.error || "no response from the extension";
          pushLog(error);
          showToast(document, `PII detection failed (${error}). The message was not sent.`);
          reply({ ok: false, error });
          return;
        }
        if (Array.isArray(res.pairs)) {
          pairs = res.pairs as Array<[string, string]>;
          restorer.refresh();
        }
        if (res.masked === draft) pushLog("sent as typed: no personal data detected");
        else pushLog("masked before send");
        reply({ ok: true, body: spliceDraft(body, draft, res.masked) });
      },
    );
  });

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "file" && (target.files?.length ?? 0) > 0) {
        showToast(document, "Attachments are not masked.");
      }
    },
    true,
  );

  const reportHealth = (): void => {
    const composer = Boolean(findComposer(document));
    const button = Boolean(findSendButton(document));
    if (!composer || !button) {
      const missing = [composer ? "" : "composer", button ? "" : "send button"].filter(Boolean).join(" and ");
      pushLog(`not found: ${missing}`);
    }
    send({ type: "health", ok: composer && button });
  };
  reportHealth();
  const healthTimer = window.setInterval(reportHealth, 2000);

  const convTimer = window.setInterval(() => {
    if (!runtimeAlive()) {
      window.clearInterval(healthTimer);
      window.clearInterval(convTimer);
      return;
    }
    const next = conversationId(location.pathname);
    if (next === convId) return;
    const prev = convId;
    convId = next;
    if (prev === null && next) {
      send({ type: "renameConversation", to: next }, () => pullPairs());
    } else {
      pullPairs();
    }
  }, 500);
}

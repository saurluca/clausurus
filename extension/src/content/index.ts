import { detectRegex } from "../../../src/detect/regex.js";
import {
  checkHealth,
  conversationId,
  findComposer,
  findSendButton,
  installSendHook,
} from "./gemini.js";
import { installRestorer } from "./restore.js";
import { defaultSettings, normalizeSettings, SETTINGS_KEY, type Settings } from "../settings.js";
import { showToast } from "./toast.js";

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
  const fail = (error: string): void => done?.({ ok: false, error });
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
  let settings: Settings = defaultSettings();
  let pairs: Array<[string, string]> = [];
  let convId = conversationId(location.pathname);

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

  let prewarmTimer = 0;
  const editor = () => findComposer(document);
  document.addEventListener(
    "input",
    () => {
      const el = editor();
      if (!el || !settings.enabled) return;
      window.clearTimeout(prewarmTimer);
      prewarmTimer = window.setTimeout(() => {
        const text = el.innerText ?? "";
        if (text.trim()) send({ type: "prewarm", text });
      }, 400);
    },
    true,
  );

  installSendHook(document, {
    isEnabled: () => settings.enabled,
    getEditor: () => findComposer(document),
    getSendButton: () => findSendButton(document),
    showError: (message) => showToast(document, message),
    onSend: (text) =>
      new Promise((resolve) => {
        send(
          {
            type: "mask",
            text,
            conversationId: convId,
            regex: detectRegex(text),
            timeoutMs: settings.detectorTimeoutMs,
          },
          (res) => {
            if (!res?.ok || typeof res.masked !== "string") {
              resolve({ ok: false, error: res?.error || "no response from the extension" });
              return;
            }
            if (Array.isArray(res.pairs)) {
              pairs = res.pairs as Array<[string, string]>;
              restorer.refresh();
            }
            resolve({ ok: true, masked: res.masked });
          },
        );
      }),
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
    send({ type: "health", ok: checkHealth(document) === "ok" });
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

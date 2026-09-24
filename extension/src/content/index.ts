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

function boot(): void {
  let settings: Settings = defaultSettings();
  let pairs: Array<[string, string]> = [];
  let convId = conversationId(location.pathname);

  const restorer = installRestorer(document, () => pairs);

  const refreshSettings = (): void => {
    chrome.storage.sync.get(SETTINGS_KEY, (stored) => {
      settings = normalizeSettings(stored[SETTINGS_KEY]);
      document.documentElement.dataset.piiReady = "1";
    });
  };
  refreshSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) refreshSettings();
  });

  const pullPairs = (): void => {
    chrome.runtime.sendMessage({ type: "getPairs", conversationId: convId }, (res) => {
      if (res?.ok && Array.isArray(res.pairs)) {
        pairs = res.pairs;
        restorer.refresh();
      }
    });
  };
  pullPairs();

  chrome.runtime.sendMessage({ type: "warmup" });

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
        if (text.trim()) chrome.runtime.sendMessage({ type: "prewarm", text });
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
        chrome.runtime.sendMessage(
          {
            type: "mask",
            text,
            conversationId: convId,
            regex: detectRegex(text),
            timeoutMs: settings.detectorTimeoutMs,
          },
          (res) => {
            if (chrome.runtime.lastError || !res) {
              resolve({ ok: false, error: "detector_failed" });
              return;
            }
            if (!res.ok) {
              resolve({ ok: false, error: res.error ?? "detector_failed" });
              return;
            }
            if (Array.isArray(res.pairs)) {
              pairs = res.pairs;
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
    chrome.runtime.sendMessage({ type: "health", ok: checkHealth(document) === "ok" });
  };
  reportHealth();
  window.setInterval(reportHealth, 2000);

  window.setInterval(() => {
    const next = conversationId(location.pathname);
    if (next === convId) return;
    const prev = convId;
    convId = next;
    if (prev === null && next) {
      chrome.runtime.sendMessage({ type: "renameConversation", to: next }, () => pullPairs());
    } else {
      pullPairs();
    }
  }, 500);
}

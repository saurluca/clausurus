import type { Detection } from "../../../src/detect/types.js";
import { buildUnmaskPairs } from "../../../src/mask/unmask.js";
import { SessionMap, type SessionMapJson } from "../../../src/mask/map.js";
import { maskDraft } from "../policy.js";
import { modelLabels, normalizeSettings, SETTINGS_KEY, type Settings } from "../settings.js";

type MaskMsg = {
  type: "mask";
  text: string;
  conversationId: string | null;
  regex: Detection[];
  timeoutMs?: number;
};

const OFFSCREEN_URL = "dist/offscreen.html";

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

function mapStorageKey(conversationId: string | null, tabId: number): string {
  if (!conversationId) return `pii-map:pending:${tabId}`;
  return `pii-map:${conversationId}`;
}

async function loadMap(key: string): Promise<SessionMap> {
  const stored = await chrome.storage.session.get(key);
  const raw = stored[key] as SessionMapJson | undefined;
  if (!raw?.sessionId) return new SessionMap(key);
  return SessionMap.fromJSON(raw);
}

async function saveMap(key: string, map: SessionMap): Promise<void> {
  await chrome.storage.session.set({ [key]: map.toJSON() });
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Run the on-device personal-data model",
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function detectModel(text: string, settings: Settings, timeoutMs: number): Promise<Detection[] | "failed"> {
  const labels = modelLabels(settings);
  if (!labels.length || !text.trim()) return [];
  try {
    await ensureOffscreen();
    const res = await withTimeout(
      chrome.runtime.sendMessage({ type: "ner-detect", text, labels }),
      timeoutMs,
    );
    if (!res?.ok || !Array.isArray(res.detections)) return "failed";
    return res.detections as Detection[];
  } catch {
    return "failed";
  }
}

function setBadge(tabId: number | undefined, text: string, color: string): void {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
  if (tabId === undefined) return;
  void chrome.action.setBadgeText({ text, tabId });
  void chrome.action.setBadgeBackgroundColor({ color, tabId });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ner-detect" || msg?.type === "warmup-model") return;

  const tabId = sender.tab?.id;

  if (msg?.type === "health") {
    if (msg.ok) setBadge(tabId, "", "#444");
    else setBadge(tabId, "!", "#a33");
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === "warmup") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: "warmup-model" }))
      .then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
    return true;
  }

  if (msg?.type === "prewarm") {
    loadSettings()
      .then(async (settings) => {
        const labels = modelLabels(settings);
        if (!settings.enabled || !labels.length) return;
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: "ner-detect", text: msg.text, labels });
      })
      .then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
    return true;
  }

  if (msg?.type === "getPairs") {
    const key = mapStorageKey(msg.conversationId ?? null, tabId ?? 0);
    loadMap(key).then((map) => {
      sendResponse({ ok: true, pairs: [...buildUnmaskPairs(map)] });
    });
    return true;
  }

  if (msg?.type === "renameConversation" && tabId !== undefined && typeof msg.to === "string") {
    const from = mapStorageKey(null, tabId);
    const to = mapStorageKey(msg.to, tabId);
    chrome.storage.session.get(from).then(async (stored) => {
      const raw = stored[from] as SessionMapJson | undefined;
      if (raw) {
        await chrome.storage.session.set({ [to]: raw });
        await chrome.storage.session.remove(from);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg?.type === "mask") {
    const body = msg as MaskMsg;
    const key = mapStorageKey(body.conversationId, tabId ?? 0);
    Promise.all([loadSettings(), loadMap(key)])
      .then(async ([settings, map]) => {
        const timeoutMs = body.timeoutMs ?? settings.detectorTimeoutMs;
        const model = await detectModel(body.text, settings, timeoutMs);
        const outcome = maskDraft({
          text: body.text,
          regex: Array.isArray(body.regex) ? body.regex : [],
          model,
          settings,
          map,
        });
        if (!outcome.ok) return outcome;
        if (outcome.count > 0) await saveMap(key, map);
        if (tabId !== undefined) setBadge(tabId, outcome.count ? String(map.maskedCount()) : "", "#444");
        return { ...outcome, pairs: [...buildUnmaskPairs(map)] };
      })
      .then(
        (outcome) => sendResponse(outcome),
        () => sendResponse({ ok: false, error: "detector_failed" }),
      );
    return true;
  }
});

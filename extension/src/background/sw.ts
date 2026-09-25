import type { Detection } from "../../../src/detect/types.js";
import { buildUnmaskPairs } from "../../../src/mask/unmask.js";
import { SessionMap, type SessionMapJson } from "../../../src/mask/map.js";
import { pushLog } from "../log.js";
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

const nerBus = new BroadcastChannel("pii-ner");

function askNer(msg: Record<string, unknown>, timeoutMs: number): Promise<{ ok?: boolean; detections?: Detection[]; error?: string }> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nerBus.removeEventListener("message", onMsg);
      reject(new Error("timeout"));
    }, timeoutMs);
    const onMsg = (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      clearTimeout(timer);
      nerBus.removeEventListener("message", onMsg);
      resolve(event.data);
    };
    nerBus.addEventListener("message", onMsg);
    nerBus.postMessage({ ...msg, id });
  });
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  const ready = new Promise<void>((resolve) => {
    const onMsg = (event: MessageEvent) => {
      if (event.data?.type !== "ready") return;
      nerBus.removeEventListener("message", onMsg);
      resolve();
    };
    nerBus.addEventListener("message", onMsg);
  });
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Run the on-device personal-data model",
  });
  await withTimeout(ready, 10_000);
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function detectModel(
  text: string,
  settings: Settings,
  timeoutMs: number,
): Promise<Detection[] | { error: string }> {
  const labels = modelLabels(settings);
  if (!labels.length || !text.trim()) return [];
  try {
    await ensureOffscreen();
    const res = await askNer({ type: "ner-detect", text, labels }, timeoutMs);
    if (!res?.ok || !Array.isArray(res.detections)) {
      return { error: res?.error || "model returned no detections" };
    }
    return res.detections as Detection[];
  } catch (err) {
    return { error: errText(err) };
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
  console.log("apertus", msg?.type);
  const tabId = sender.tab?.id;

  if (msg?.type === "health") {
    if (msg.ok) setBadge(tabId, "", "#444");
    else setBadge(tabId, "!", "#a33");
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === "warmup") {
    ensureOffscreen()
      .then(() => askNer({ type: "warmup-model" }, 30_000))
      .then(
        (res) => {
          if (!res?.ok) pushLog(res?.error || "model warmup failed");
          sendResponse({ ok: true });
        },
        (err) => {
          pushLog(errText(err));
          sendResponse({ ok: false });
        },
      );
    return true;
  }

  if (msg?.type === "prewarm") {
    loadSettings()
      .then(async (settings) => {
        const labels = modelLabels(settings);
        if (!settings.enabled || !labels.length) return;
        await ensureOffscreen();
        const res = await askNer({ type: "ner-detect", text: msg.text, labels }, settings.detectorTimeoutMs);
        if (!res?.ok) pushLog(res?.error || "model prewarm failed");
      })
      .then(
        () => sendResponse({ ok: true }),
        (err) => {
          pushLog(errText(err));
          sendResponse({ ok: false });
        },
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
        const detected = await detectModel(body.text, settings, timeoutMs);
        const modelError = Array.isArray(detected) ? null : detected.error;
        const outcome = maskDraft({
          text: body.text,
          regex: Array.isArray(body.regex) ? body.regex : [],
          model: Array.isArray(detected) ? detected : "failed",
          settings,
          map,
        });
        if (!outcome.ok) {
          const error = modelError ?? outcome.error;
          console.error("PII detection failed:", error);
          pushLog(`PII detection failed: ${error}`);
          return { ok: false, error };
        }
        if (outcome.count > 0) await saveMap(key, map);
        if (tabId !== undefined) setBadge(tabId, outcome.count ? String(map.maskedCount()) : "", "#444");
        return { ...outcome, pairs: [...buildUnmaskPairs(map)] };
      })
      .then(
        (outcome) => sendResponse(outcome),
        (err) => {
          const error = errText(err);
          console.error("PII detection failed:", error);
          pushLog(`PII detection failed: ${error}`);
          sendResponse({ ok: false, error });
        },
      );
    return true;
  }
});

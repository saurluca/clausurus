const CHANNEL = "apertus-pii";

type MaskReply = { ok: true; body: string } | { ok: false; error: string };

function ask(body: string): Promise<MaskReply> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMsg);
      console.warn("apertus: mask bridge timed out");
      resolve({ ok: false, error: "mask bridge timed out" });
    }, 35_000);
    const onMsg = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { channel?: string; type?: string; id?: string; ok?: boolean; body?: string; error?: string };
      if (!data || data.channel !== CHANNEL || data.type !== "mask-result" || data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      if (data.ok && typeof data.body === "string") resolve({ ok: true, body: data.body });
      else resolve({ ok: false, error: data.error || "mask failed" });
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ channel: CHANNEL, type: "mask-request", id, body }, "*");
  });
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  const raw = init?.body;
  if (typeof raw === "string") return raw;
  if (raw instanceof URLSearchParams) return raw.toString();
  if (input instanceof Request && raw == null) return input.clone().text();
  return null;
}

const orig = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const text = await readBody(input, init);
  if (text == null || !text) return orig(input, init);
  const result = await ask(text);
  if (!result.ok) throw new Error(result.error);
  if (result.body === text) return orig(input, init);
  if (input instanceof Request && init?.body == null) return orig(new Request(input, { body: result.body }));
  return orig(input, { ...init, body: result.body });
};

console.log("apertus: fetch hook installed");

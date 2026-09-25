import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { chromium, test, expect, type BrowserContext } from "@playwright/test";

const EXT = join(import.meta.dirname, "..");
const PORT = 8765;

async function launch(): Promise<BrowserContext> {
  const userDataDir = mkdtempSync(join(tmpdir(), "apertus-ext-"));
  const args = [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--ozone-platform=x11",
  ];
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/chromium",
    ignoreDefaultArgs: ["--disable-extensions"],
    args,
  });
}

test.beforeAll(async () => {
  const html = await readFile(join(import.meta.dirname, "fixture.html"));
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        res.setHeader("content-type", "text/plain");
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  (globalThis as { __fixture?: typeof server }).__fixture = server;
});

test.afterAll(async () => {
  const server = (globalThis as { __fixture?: { close: (cb: () => void) => void } }).__fixture;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("masks an email, restores it on the page, and counts it", async () => {
  const context = await launch();
  const page = await context.newPage();
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await sw.evaluate(async () => {
    const types = {
      email: true, phone: true, ipv4: true, ipv6: true, url: false, uuid: false,
      credit_card: true, iban: true, ahv: true, date_of_birth: true,
      person_name: false, organization: false, location: false, address: false,
      medical_record: true, insurance_id: true, other_id: true,
      passport: true, national_id: true, driver_license: true, id_card: true,
      tracking_number: true,
    };
    await chrome.storage.sync.set({
      settings: { enabled: true, onDetectorError: "block", detectorTimeoutMs: 1500, types },
    });
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForFunction(() => document.documentElement.dataset.piiReady === "1");
  const editor = page.locator(".ql-editor");
  await editor.click();
  await page.keyboard.type("mail ada@example.com");
  await page.locator(".send-button").click();
  await expect(page.locator("#sent")).not.toContainText("ada@example.com", { timeout: 10_000 });
  await expect(page.locator("user-query")).toContainText("ada@example.com");
  await expect.poll(async () => sw.evaluate(() => chrome.action.getBadgeText({}))).not.toBe("");
  await context.close();
});

test("a model timeout blocks the send", async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await sw.evaluate(async () => {
    await chrome.storage.sync.set({
      settings: {
        enabled: true,
        onDetectorError: "block",
        detectorTimeoutMs: 30,
        types: {
          email: true, phone: true, ipv4: true, ipv6: true, url: false, uuid: false,
          credit_card: true, iban: true, ahv: true, date_of_birth: true,
          person_name: true, organization: true, location: true, address: true,
          medical_record: true, insurance_id: true, other_id: true,
          passport: true, national_id: true, driver_license: true, id_card: true,
          tracking_number: true,
        },
      },
    });
    await chrome.storage.session.set({ nerDelayMs: 5_000 });
  });
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.piiReady === "1");
  await page.locator(".ql-editor").click();
  await page.keyboard.type("Ada Lovelace lives here");
  await page.locator(".send-button").click();
  await expect(page.locator("#apertus-pii-toast")).toBeAttached({ timeout: 10_000 });
  await expect(page.locator("#sent")).toHaveText("");
  await context.close();
});

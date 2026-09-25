import type { EntityType } from "../../../src/detect/types.js";
import { readLogs } from "../log.js";
import { normalizeSettings, SETTINGS_KEY, TYPE_GROUPS, type Settings } from "../settings.js";

const enabled = document.querySelector<HTMLInputElement>("#enabled")!;
const fallback = document.querySelector<HTMLInputElement>("#fallback")!;
const groups = document.querySelector<HTMLDivElement>("#groups")!;

let settings: Settings = normalizeSettings(undefined);

function save(): void {
  void chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

function typeLabel(type: EntityType): string {
  return type.replaceAll("_", " ");
}

function render(): void {
  enabled.checked = settings.enabled;
  fallback.checked = settings.onDetectorError === "regex";
  groups.replaceChildren();
  for (const group of TYPE_GROUPS) {
    const details = document.createElement("details");
    details.open = true;
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.textContent = group.label;
    const groupBox = document.createElement("input");
    groupBox.type = "checkbox";
    const onCount = group.types.filter((t) => settings.types[t]).length;
    groupBox.checked = onCount === group.types.length;
    groupBox.indeterminate = onCount > 0 && onCount < group.types.length;
    groupBox.addEventListener("click", (event) => event.stopPropagation());
    groupBox.addEventListener("change", () => {
      for (const t of group.types) settings.types[t] = groupBox.checked;
      save();
      render();
    });
    summary.append(name, groupBox);
    const list = document.createElement("div");
    list.className = "types";
    for (const type of group.types) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = settings.types[type];
      box.addEventListener("change", () => {
        settings.types[type] = box.checked;
        save();
        render();
      });
      label.append(box, typeLabel(type));
      list.append(label);
    }
    details.append(summary, list);
    groups.append(details);
  }
}

enabled.addEventListener("change", () => {
  settings.enabled = enabled.checked;
  save();
});

fallback.addEventListener("change", () => {
  settings.onDetectorError = fallback.checked ? "regex" : "block";
  save();
});

const logBtn = document.querySelector<HTMLButtonElement>("#log-btn")!;
const logBox = document.querySelector<HTMLPreElement>("#log")!;

async function renderLogs(): Promise<void> {
  const lines = await readLogs();
  logBox.textContent = lines.length
    ? lines.map((line) => `${new Date(line.t).toLocaleTimeString()}  ${line.message}`).join("\n")
    : "No errors yet.";
  logBox.scrollTop = logBox.scrollHeight;
}

logBtn.addEventListener("click", () => {
  logBox.hidden = !logBox.hidden;
  if (!logBox.hidden) void renderLogs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["pii-logs"] && !logBox.hidden) void renderLogs();
});

chrome.storage.sync.get(SETTINGS_KEY, (stored) => {
  settings = normalizeSettings(stored[SETTINGS_KEY]);
  render();
});

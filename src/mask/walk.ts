export const STRUCTURAL_KEYS = new Set([
  "model",
  "role",
  "type",
  "id",
  "object",
  "stop",
  "tool_choice",
  "response_format",
  "format",
  "encoding_format",
  "anthropic_version",
  "mime_type",
  "media_type",
]);

export const SKIP_SUBTREE_KEYS = new Set([
  "tools",
  "functions",
  "input_schema",
  "parameters",
  "json_schema",
]);

export function isStructuralKey(key: string): boolean {
  if (STRUCTURAL_KEYS.has(key)) return true;
  if (key.endsWith("_id")) return true;
  return false;
}

export function isDataUri(value: string): boolean {
  return /^data:/i.test(value);
}

export function isLargeBase64(value: string): boolean {
  if (value.length <= 1024) return false;
  // rough: long string without spaces that looks base64-ish
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9+/=_-]{1024,}$/.test(value);
}

export function tryParseJsonContainer(value: string): unknown | undefined {
  const t = value.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export type StringVisit = {
  path: Array<string | number>;
  key: string | null;
  value: string;
  /** Replace this string leaf. */
  set: (next: string) => void;
};

/**
 * Walk every string leaf. Mutates via visit.set. Skips structural keys and schema subtrees.
 */
export function walkStrings(root: unknown, visit: (v: StringVisit) => void): void {
  const walk = (node: unknown, path: Array<string | number>, parentKey: string | null): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (parentKey === "url" && isDataUri(node)) return;
      if (isLargeBase64(node)) return;
      const nested = tryParseJsonContainer(node);
      if (nested !== undefined && typeof nested === "object") {
        // Root-level JSON string: walk nested in place is not assignable; treat as opaque text.
      }
      visit({
        path,
        key: parentKey,
        value: node,
        set: () => {
          /* root string — caller should use maskText */
        },
      });
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const el = node[i];
        if (typeof el === "string") {
          if (parentKey === "url" && isDataUri(el)) continue;
          if (isLargeBase64(el)) continue;
          const nested = tryParseJsonContainer(el);
          if (nested !== undefined && typeof nested === "object") {
            const replaced = walkJsonInStringValue(el, [...path, i], null, visit);
            if (replaced !== el) node[i] = replaced;
            continue;
          }
          visit({
            path: [...path, i],
            key: null,
            value: el,
            set: (next) => {
              node[i] = next;
            },
          });
        } else {
          walk(el, [...path, i], null);
        }
      }
      return;
    }
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (SKIP_SUBTREE_KEYS.has(key)) continue;
        const val = obj[key];
        if (typeof val === "string") {
          if (isStructuralKey(key)) continue;
          if (key === "url" && isDataUri(val)) continue;
          if (isLargeBase64(val)) continue;
          const nested = tryParseJsonContainer(val);
          if (nested !== undefined && typeof nested === "object") {
            const replaced = walkJsonInStringValue(val, [...path, key], key, visit);
            if (replaced !== val) obj[key] = replaced;
            continue;
          }
          visit({
            path: [...path, key],
            key,
            value: val,
            set: (next) => {
              obj[key] = next;
            },
          });
        } else {
          walk(val, [...path, key], key);
        }
      }
    }
  };

  walk(root, [], null);
}

function walkJsonInStringValue(
  value: string,
  _path: Array<string | number>,
  _parentKey: string | null,
  visit: (v: StringVisit) => void,
): string {
  const nested = tryParseJsonContainer(value);
  if (nested === undefined) return value;
  walkStrings(nested, visit);
  return JSON.stringify(nested);
}

/** Collect all maskable string leaves (for batch detection). */
export function collectMaskableStrings(root: unknown): string[] {
  const out: string[] = [];
  walkStrings(root, (v) => {
    out.push(v.value);
  });
  return out;
}

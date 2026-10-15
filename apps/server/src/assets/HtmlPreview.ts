import { ASSET_ROUTE_PREFIX } from "./AssetAccess.ts";

export const HTML_PREVIEW_MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** The document stays opaque. Only its signed directory capability is network-readable. */
export function htmlPreviewPolicy(token: string): string {
  const root = `${ASSET_ROUTE_PREFIX}/${token}/`;
  const sources = `http://*:*${root} https://*:*${root}`;
  return [
    "sandbox allow-scripts allow-forms allow-popups allow-modals",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${sources}`,
    `style-src 'unsafe-inline' ${sources}`,
    `connect-src ${sources}`,
    `img-src data: blob: ${sources}`,
    `media-src blob: ${sources}`,
    `font-src data: ${sources}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Vite's default /assets URLs must stay inside the HTML folder's signed grant. */
export function rewritePreviewRootUrls(source: string, token: string): string {
  const root = `${ASSET_ROUTE_PREFIX}/${token}/`;
  return source
    .replace(/(["'`])\/(?!\/)([^"'`\s<>]*)\1/g, (match, quote: string, path: string) =>
      /\.(?:html?|css|m?js|json|png|jpe?g|gif|webp|avif|ico|svg|mp4|webm|mov|mp3|wav|m4a|aac|ogg|oga|flac|opus|wasm|glb|gltf|csv|txt|woff2?|ttf|otf)(?:[?#].*)?$/i.test(
        path,
      )
        ? `${quote}${root}${path}${quote}`
        : match,
    )
    .replace(/url\(\s*\/(?!\/)([^)\s]+)\s*\)/gi, (_match, path: string) => `url(${root}${path})`);
}

/** Storage is deliberately RAM-only: native localStorage would grant app-origin access. */
export function prepareHtmlPreview(source: string, token: string): string {
  const bootstrap = `<script>
(() => {
  const root = new URL(${JSON.stringify(`${ASSET_ROUTE_PREFIX}/${token}/`)}, location.href);
  const makeStorage = () => {
    const values = new Map();
    const api = {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[index] ?? null; },
      getItem(key) { return values.get(String(key)) ?? null; },
      setItem(key, value) {
        key = String(key); value = String(value);
        let bytes = key.length + value.length;
        for (const [k, v] of values) if (k !== key) bytes += k.length + v.length;
        if (bytes > 524288) throw new DOMException("プレビューの保存容量を超えました", "QuotaExceededError");
        values.set(key, value);
      },
      removeItem(key) { values.delete(String(key)); },
      clear() { values.clear(); }
    };
    return new Proxy(api, {
      get(target, key) { return key in target ? Reflect.get(target, key) : typeof key === "string" ? values.get(key) : undefined; },
      set(target, key, value) { if (typeof key === "string") api.setItem(key, value); return true; },
      deleteProperty(target, key) { api.removeItem(key); return true; }
    });
  };
  for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(window, name, { value: makeStorage() });
  const resourceUrl = (requested) => {
    const url = new URL(requested.startsWith(root.pathname) ? root.origin + requested : requested.startsWith("/") && !requested.startsWith("//") ? new URL(requested.slice(1), root) : requested, location.href);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new TypeError("プレビューのフォルダ外は読み込めません");
    return url;
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const requested = input instanceof Request ? input.url : String(input);
    let url;
    try { url = resourceUrl(requested); } catch (error) { return Promise.reject(error); }
    return originalFetch(input instanceof Request ? new Request(url, input) : url, { ...init, credentials: "omit" });
  };
  if (window.XMLHttpRequest) {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, resourceUrl(String(url)).href, ...args); };
    XMLHttpRequest.prototype.send = function(...args) { this.withCredentials = false; return send.apply(this, args); };
  }
})();
</script>`;
  // Keep doctype first so the browser retains standards mode. Remove authored
  // base tags; they must not redirect sibling reads to the app or another grant.
  const html = rewritePreviewRootUrls(source, token).replace(/<base\b[^>]*>/gi, "");
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
  return `${doctype}${bootstrap}${html.slice(doctype.length)}`;
}

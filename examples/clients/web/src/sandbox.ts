/**
 * The sandbox proxy, served on its own origin and framed by the chat page. It loads the app's HTML into an inner
 * frame and relays the MCP Apps JSON-RPC messages between that frame and the page, which cannot reach each other.
 */
const READY = "ui/notifications/sandbox-proxy-ready";
const RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

if (window.self === window.top || !document.referrer) {
  throw new Error("The sandbox only runs inside the Zing web client.");
}
const hostOrigin = new URL(document.referrer).origin;

const inner = document.createElement("iframe");
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
document.body.append(inner);

window.addEventListener("message", (event) => {
  const data = event.data as { method?: string; params?: Record<string, unknown> } | null;
  if (event.source === window.parent) {
    if (event.origin !== hostOrigin) return;
    if (data?.method === RESOURCE_READY) {
      load(data.params ?? {});
      return;
    }
    inner.contentWindow?.postMessage(data, "*");
  } else if (event.source === inner.contentWindow) {
    window.parent.postMessage(data, hostOrigin);
  }
});

window.parent.postMessage({ jsonrpc: "2.0", method: READY, params: {} }, hostOrigin);

function load(params: Record<string, unknown>): void {
  if (typeof params.sandbox === "string") inner.setAttribute("sandbox", params.sandbox);
  const allow = allowAttribute(params.permissions);
  if (allow) inner.setAttribute("allow", allow);
  if (typeof params.html !== "string") return;
  // The frame inherits this page's origin and its CSP header, which the server set from the app's declared domains.
  const document = inner.contentDocument;
  if (document) {
    document.open();
    document.write(params.html);
    document.close();
  } else {
    inner.srcdoc = params.html;
  }
}

/** The Permissions Policy for what the app asked for: camera, microphone, geolocation, clipboard writes. */
function allowAttribute(permissions: unknown): string {
  if (!permissions || typeof permissions !== "object") return "";
  const asked = permissions as Record<string, unknown>;
  const features: Array<[string, string]> = [
    ["camera", "camera"],
    ["microphone", "microphone"],
    ["geolocation", "geolocation"],
    ["clipboardWrite", "clipboard-write"],
  ];
  return features
    .filter(([key]) => asked[key])
    .map(([, feature]) => feature)
    .join("; ");
}

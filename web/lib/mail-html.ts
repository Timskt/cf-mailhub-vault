// HTML lives only in an opaque-origin sandbox, never in the application DOM.
export function mailHtml(
  html: string,
  remoteImages = false,
  nightReading = false,
): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll(
      "script,base,meta,iframe,frame,object,embed,form,input,button,textarea,select,link,audio,video,template",
    )
    .forEach((node) => node.remove());
  doc.querySelectorAll("*").forEach((node) =>
    [...node.attributes].forEach((attr) => {
      if (
        /^on/i.test(attr.name) ||
        ["srcdoc", "action", "formaction", "ping"].includes(
          attr.name.toLowerCase(),
        )
      )
        node.removeAttribute(attr.name);
    }),
  );
  doc.querySelectorAll("a").forEach((a) => {
    try {
      const url = new URL(a.getAttribute("href") || "");
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      a.href = url.href;
    } catch {
      a.removeAttribute("href");
    }
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? " https:" : ""}; form-action 'none'; base-uri 'none';`;
  doc.head.prepend(policy);
  const viewport = doc.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  doc.head.append(viewport);
  const style = doc.createElement("style");
  style.textContent =
    "html{color-scheme:light}body{font:14px/1.7 system-ui,sans-serif;color:#172b37;background:#fff;padding:12px;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}" +
    // Apply the transformation inside the isolated document; outer-page selectors
    // cannot reach srcDoc. Counter-transform images once to retain their colours.
    (nightReading
      ? "html{background:#fff!important;filter:invert(1) hue-rotate(180deg)!important;min-height:100%}img,svg{filter:invert(1) hue-rotate(180deg)!important}"
      : "");
  doc.head.append(style);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

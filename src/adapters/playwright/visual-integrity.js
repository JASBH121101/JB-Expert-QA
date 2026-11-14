const DEFAULT_PRESERVED_TERMS = Object.freeze(["landing page", "landing pages"]);
const LANGUAGE_MARKERS = Object.freeze({
  en: Object.freeze([
    "sign in", "sign up", "log in", "log out", "create account", "forgot password",
    "add to cart", "view cart", "checkout", "continue shopping", "search products",
    "no results found", "view details", "read more", "load more", "contact us",
    "my account", "all products", "new arrivals", "out of stock", "coming soon",
    "save changes", "delete account", "confirm password", "email address",
    "select an option", "back to top", "welcome to", "shop now", "learn more",
    "track order", "order history", "shipping address", "payment method",
    "reset password", "your profile"
  ]),
  es: Object.freeze([
    "iniciar sesión", "iniciar sesion", "registrarse", "crear cuenta",
    "cerrar sesión", "cerrar sesion", "agregar al carrito", "añadir al carrito",
    "ver carrito", "finalizar compra", "seguir comprando", "buscar productos",
    "no se encontraron resultados", "ver detalles", "leer más", "leer mas",
    "cargar más", "cargar mas", "contáctanos", "contactanos", "mi cuenta",
    "todos los productos", "nuevos productos", "agotado", "próximamente",
    "proximamente", "guardar cambios", "eliminar cuenta", "confirmar contraseña",
    "confirmar contrasena", "correo electrónico", "correo electronico",
    "selecciona una opción", "selecciona una opcion", "volver arriba",
    "bienvenido a", "comprar ahora", "más información", "mas informacion",
    "rastrear pedido", "historial de pedidos", "dirección de envío",
    "direccion de envio", "método de pago", "metodo de pago",
    "restablecer contraseña", "restablecer contrasena", "tu perfil",
    "contraseña", "contrasena"
  ])
});
const UI_TEXT_SELECTOR = [
  "button", "a", "[role='button']", "[role='link']", "label", "input", "textarea",
  "select", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "summary",
  "[aria-label]", "[aria-description]", "[title]", "[data-tooltip]", "img[alt]"
].join(",");

function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().replace("_", "-").split("-")[0];
  return primary === "en" || primary === "es" ? primary : null;
}

function validatePreservedTerms(value) {
  if (value === undefined) return DEFAULT_PRESERVED_TERMS;
  if (!Array.isArray(value) || value.length > 100 ||
      value.some((term) => typeof term !== "string" || !term.trim() || term.length > 100)) {
    throw new TypeError("preserveTerms must be an array of up to 100 non-empty strings");
  }
  return Object.freeze([...new Set(
    [...DEFAULT_PRESERVED_TERMS, ...value].map((term) => term.trim().toLowerCase())
  )]);
}

export async function collectVisualIntegrity(page, { targetLanguage = null, preserveTerms } = {}) {
  const requestedLanguage = normalizeLanguage(targetLanguage);
  const preserved = validatePreservedTerms(preserveTerms);

  return page.evaluate(({ requestedLanguage: requested, preservedTerms, markerMap, textSelector }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (element) => {
      if (element.id) return "#" + CSS.escape(element.id);
      const classes = [...element.classList].slice(0, 2);
      return element.tagName.toLowerCase() +
        (classes.length ? "." + classes.map((name) => CSS.escape(name)).join(".") : "");
    };
    const clean = (value) => String(value ?? "").normalize("NFKC")
      .toLowerCase().replace(/\s+/g, " ").trim();
    const language = requested || (() => {
      const declared = document.documentElement.getAttribute("lang") || "";
      const primary = declared.toLowerCase().replace("_", "-").split("-")[0];
      return primary === "es" || primary === "en" ? primary : null;
    })();
    const languageSource = requested ? "option" : (language ? "document-lang" : "undetermined");
    const ignored = (element) =>
      element.closest("[data-localization-ignore],pre,code,kbd,samp,script,style,noscript") !== null;
    const stripTerms = (value) => {
      let result = value;
      for (const term of preservedTerms) result = result.split(term).join(" ");
      return result.replace(/\s+/g, " ").trim();
    };
    const findMarker = (value) => {
      const candidate = stripTerms(clean(value));
      const opposite = language === "es" ? "en" : "es";
      const phrases = markerMap[opposite] || [];
      return phrases.find((phrase) => candidate.includes(phrase))
        ? { language: opposite, marker: phrases.find((phrase) => candidate.includes(phrase)) }
        : null;
    };

    const localizationFindings = [];
    const seenTexts = new Set();
    let textsInspected = 0;
    if (language) {
      for (const element of [...document.querySelectorAll(textSelector)].slice(0, 1800)) {
        if (!visible(element) || ignored(element)) continue;
        const values = [];
        const text = (element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) values.push({ attribute: "text", value: text });
        for (const attribute of ["aria-label", "aria-description", "title", "placeholder", "alt", "data-tooltip"]) {
          const value = element.getAttribute(attribute);
          if (value?.trim()) values.push({ attribute, value: value.trim() });
        }
        if (element.matches("input[type=button],input[type=submit],input[type=reset]")) {
          const value = element.getAttribute("value");
          if (value?.trim()) values.push({ attribute: "value", value: value.trim() });
        }
        for (const entry of values) {
          const normalized = clean(entry.value);
          if (normalized.length < 2 || normalized.length > 500 ||
              /^[\d\s.,:;/%$€£¥+-]+$/.test(normalized) ||
              /^https?:\/\//i.test(normalized) || normalized.includes("@")) continue;
          const key = selectorFor(element) + "|" + entry.attribute + "|" + normalized;
          if (seenTexts.has(key)) continue;
          seenTexts.add(key);
          textsInspected += 1;
          const match = findMarker(entry.value);
          if (!match) continue;
          localizationFindings.push({
            selector: selectorFor(element),
            tagName: element.tagName.toLowerCase(),
            attribute: entry.attribute,
            text: entry.value.slice(0, 180),
            expectedLanguage: language,
            detectedLanguage: match.language,
            marker: match.marker,
            control: /^(button|input|textarea|select)$/.test(element.tagName.toLowerCase()) ||
              element.matches("a,[role='button'],[role='link']")
          });
        }
      }
    }

    const textTargets = [...document.querySelectorAll(
      "button,a,[role='button'],[role='link'],label,h1,h2,h3,h4,h5,h6,p,li,summary,[data-qa-text]"
    )].filter((element) => visible(element) && !ignored(element)).slice(0, 1800);
    const clippedText = [];
    const clippedByAncestor = [];
    const seenClipping = new Set();
    for (const element of textTargets) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      const control = tag === "button" || tag === "a" ||
        element.matches("[role='button'],[role='link']");
      const text = (element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const clipsX = ["hidden", "clip"].includes(style.overflowX);
      const clipsY = ["hidden", "clip"].includes(style.overflowY);
      const horizontalExcess = Math.max(0, element.scrollWidth - element.clientWidth);
      const verticalExcess = Math.max(0, element.scrollHeight - element.clientHeight);
      const lineClamp = Number.parseInt(style.webkitLineClamp, 10);
      const clamped = style.textOverflow === "ellipsis" ||
        (Number.isInteger(lineClamp) && lineClamp > 0);
      if ((clipsX && horizontalExcess > 2) || (clipsY && verticalExcess > 2) ||
          (clamped && (horizontalExcess > 2 || verticalExcess > 2))) {
        const key = selectorFor(element) + "|self";
        if (!seenClipping.has(key)) {
          seenClipping.add(key);
          clippedText.push({
            selector: selectorFor(element), tagName: tag, control, text: text.slice(0, 180),
            widthPx: Math.round(rect.width), heightPx: Math.round(rect.height),
            clientWidthPx: element.clientWidth, scrollWidthPx: element.scrollWidth,
            clientHeightPx: element.clientHeight, scrollHeightPx: element.scrollHeight,
            overflowX: style.overflowX, overflowY: style.overflowY,
            textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp || null,
            clippedHorizontally: horizontalExcess > 2, clippedVertically: verticalExcess > 2
          });
        }
      }

      let ancestor = element.parentElement;
      let depth = 0;
      while (ancestor && ancestor !== document.body && depth < 8) {
        depth += 1;
        const ancestorStyle = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        const clipX = ["hidden", "clip"].includes(ancestorStyle.overflowX);
        const clipY = ["hidden", "clip"].includes(ancestorStyle.overflowY);
        const edges = [];
        if (clipX && rect.left < ancestorRect.left - 1) edges.push("left");
        if (clipX && rect.right > ancestorRect.right + 1) edges.push("right");
        if (clipY && rect.top < ancestorRect.top - 1) edges.push("top");
        if (clipY && rect.bottom > ancestorRect.bottom + 1) edges.push("bottom");
        if (edges.length) {
          const key = selectorFor(element) + "|" + selectorFor(ancestor);
          if (!seenClipping.has(key)) {
            seenClipping.add(key);
            clippedByAncestor.push({
              selector: selectorFor(element), ancestorSelector: selectorFor(ancestor),
              tagName: tag, control, text: text.slice(0, 180), clippedEdges: edges,
              elementRect: {
                left: Math.round(rect.left), top: Math.round(rect.top),
                right: Math.round(rect.right), bottom: Math.round(rect.bottom)
              },
              ancestorRect: {
                left: Math.round(ancestorRect.left), top: Math.round(ancestorRect.top),
                right: Math.round(ancestorRect.right), bottom: Math.round(ancestorRect.bottom)
              },
              ancestorOverflowX: ancestorStyle.overflowX, ancestorOverflowY: ancestorStyle.overflowY
            });
          }
        }
        ancestor = ancestor.parentElement;
      }
    }

    const containerSelector = [
      "main", "section", "[data-container]", ".container", "[class*='container']",
      "[id*='container']", ".page-content", ".content-wrapper", ".content-area",
      ".catalog-grid", ".dashboard-content"
    ].join(",");
    const containerMetrics = [...new Set(document.querySelectorAll(containerSelector))]
      .filter((element) => visible(element)).slice(0, 250).map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const parent = element.parentElement;
        const parentRect = parent?.getBoundingClientRect();
        const parentWidth = parent ? parent.clientWidth : window.innerWidth;
        return {
          selector: selectorFor(element), tagName: element.tagName.toLowerCase(),
          className: String(element.className?.baseVal ?? element.className ?? "").slice(0, 160),
          widthPx: Math.round(rect.width), parentContentWidthPx: parentWidth,
          widthToParentRatio: parentWidth > 0 ? Number((rect.width / parentWidth).toFixed(3)) : null,
          viewportWidthPx: window.innerWidth, maxWidth: style.maxWidth,
          minWidth: style.minWidth, width: style.width, boxSizing: style.boxSizing,
          paddingLeftPx: Number.parseFloat(style.paddingLeft) || 0,
          paddingRightPx: Number.parseFloat(style.paddingRight) || 0,
          parentWidthPx: parentRect ? Math.round(parentRect.width) : null,
          scrollWidthPx: element.scrollWidth, clientWidthPx: element.clientWidth
        };
      });

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      localizationAudit: {
        status: language ? "checked" : "skipped",
        language, languageSource, supportedLanguages: ["es", "en"],
        preservedTerms, textsInspected, findings: localizationFindings,
        note: language
          ? "Deterministic phrase matching flags high-confidence opposite-language UI strings; ambiguous wording requires review."
          : "Set html lang to es or en, or pass targetLanguage to audit localization."
      },
      layoutIntegrity: {
        clippedText, clippedByAncestor, containerMetrics,
        summary: {
          clippedTextCount: clippedText.length,
          clippedByAncestorCount: clippedByAncestor.length,
          containersMeasured: containerMetrics.length
        }
      }
    };
  }, {
    requestedLanguage, preservedTerms: preserved, markerMap: LANGUAGE_MARKERS,
    textSelector: UI_TEXT_SELECTOR
  });
}

export { DEFAULT_PRESERVED_TERMS };

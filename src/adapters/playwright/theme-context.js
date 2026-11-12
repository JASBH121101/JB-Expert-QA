export async function collectThemeContext(page) {
  return page.evaluate(() => {
    const selectorFor = (element) => {
      if (element.id) return "#" + CSS.escape(element.id);
      const classes = [...element.classList].slice(0, 2);
      return element.tagName.toLowerCase() +
        (classes.length ? "." + classes.map((name) => CSS.escape(name)).join(".") : "");
    };
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const hasVisibleAlpha = (color) => {
      const value = String(color).trim().toLowerCase();
      if (value === "transparent") return false;
      const match = value.match(/^rgba?\((.*)\)$/i);
      if (!match) return true;
      const parts = match[1].replace(/\s*\/\s*/, ",").split(/[\s,]+/).filter(Boolean);
      const alphaToken = parts[3] ?? "1";
      const alpha = alphaToken.endsWith("%")
        ? Number.parseFloat(alphaToken) / 100
        : Number.parseFloat(alphaToken);
      return Number.isFinite(alpha) && alpha > 0;
    };
    const isOpaque = (color) => {
      const value = String(color).trim().toLowerCase();
      if (value === "transparent") return false;
      const match = value.match(/^rgba?\((.*)\)$/i);
      if (!match) return true;
      const parts = match[1].replace(/\s*\/\s*/, ",").split(/[\s,]+/).filter(Boolean);
      const alphaToken = parts[3] ?? "1";
      const alpha = alphaToken.endsWith("%")
        ? Number.parseFloat(alphaToken) / 100
        : Number.parseFloat(alphaToken);
      return Number.isFinite(alpha) && alpha >= 1;
    };
    const backgroundFor = (element) => {
      const layers = [];
      let opaqueBackgroundFound = false;
      for (let current = element; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (Number(style.opacity) !== 1) {
          return { status: "inconclusive", reason: "ancestor-opacity", layers };
        }
        if (opaqueBackgroundFound) continue;
        if (style.backgroundImage && style.backgroundImage !== "none") {
          return { status: "inconclusive", reason: "background-image-or-gradient", layers };
        }
        if (style.backdropFilter && style.backdropFilter !== "none") {
          return { status: "inconclusive", reason: "backdrop-filter", layers };
        }
        layers.push(style.backgroundColor);
        if (isOpaque(style.backgroundColor)) opaqueBackgroundFound = true;
        if (layers.length >= 30) break;
      }
      if (!layers.some(hasVisibleAlpha)) {
        return { status: "inconclusive", reason: "transparent-background-chain", layers };
      }
      return { status: "resolved", reason: null, layers };
    };
    const samples = [];
    const stateFor = (element) => {
      const matchesSelfOrAncestor = (selector) => element.matches(selector) || Boolean(element.closest(selector));
      if (matchesSelfOrAncestor(":disabled,[aria-disabled='true']")) return "disabled";
      if (matchesSelfOrAncestor("[aria-selected='true'],[aria-checked='true'],[aria-pressed='true'],:checked,[data-state='active'],.active")) return "selected";
      if (matchesSelfOrAncestor("[aria-busy='true'],[data-loading='true'],.loading")) return "loading";
      if (matchesSelfOrAncestor("[aria-invalid='true'],:invalid,.is-invalid,.error")) return "error";
      if (matchesSelfOrAncestor(":focus-visible")) return "focus-visible";
      if (matchesSelfOrAncestor(":focus")) return "focus";
      return "default";
    };
    const addSample = (element, kind, style, pseudo = null) => {
      if (!isVisible(element)) return;
      const background = backgroundFor(element);
      const weight = Number.parseInt(style.fontWeight, 10) ||
        (style.fontWeight === "bold" ? 700 : 400);
      samples.push({
        selector: selectorFor(element),
        kind,
        pseudo,
        foreground: style.color,
        backgroundStatus: background.status,
        backgroundReason: background.reason,
        backgroundLayers: background.layers,
        fontSizePx: Number.parseFloat(style.fontSize),
        fontWeight: weight,
        state: stateFor(element)
      });
    };
    const addNonTextSample = (element, kind, foreground, componentPart, backgroundOverride = null) => {
      const background = backgroundOverride ?? backgroundFor(element.parentElement ?? element);
      samples.push({
        selector: selectorFor(element),
        kind,
        componentPart,
        pseudo: null,
        foreground,
        backgroundStatus: background.status,
        backgroundReason: background.reason,
        backgroundLayers: background.layers,
        fontSizePx: 0,
        fontWeight: 400,
        state: stateFor(element)
      });
    };

    for (const element of [...document.body.querySelectorAll("*")].slice(0, 1200)) {
      if (!isVisible(element)) continue;
      const hasDirectText = [...element.childNodes].some((node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
      );
      if (hasDirectText) addSample(element, "text", getComputedStyle(element));
      if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") &&
          element.hasAttribute("placeholder")) {
        const placeholderStyle = getComputedStyle(element, "::placeholder");
        addSample(element, "placeholder", placeholderStyle, "::placeholder");
      }
    }

    const controlSelector = [
      "button", "input", "select", "textarea", "[role='button']", "[role='tab']",
      "[role='checkbox']", "[role='radio']", "[role='switch']", "[aria-pressed]"
    ].join(",");
    for (const element of [...document.querySelectorAll(controlSelector)].slice(0, 400)) {
      if (!isVisible(element)) continue;
      const style = getComputedStyle(element);
      const outsideBackground = backgroundFor(element.parentElement ?? element);
      const hasVisibleBorder = ["Top", "Right", "Bottom", "Left"].some((side) => {
        const width = Number.parseFloat(style["border" + side + "Width"]);
        return Number.isFinite(width) && width > 0 &&
          !["none", "hidden"].includes(style["border" + side + "Style"]) &&
          hasVisibleAlpha(style["border" + side + "Color"]);
      });
      if (hasVisibleAlpha(style.backgroundColor) && !hasVisibleBorder) {
        addNonTextSample(
          element,
          "component-fill",
          style.backgroundColor,
          "background",
          style.backgroundImage && style.backgroundImage !== "none"
            ? { status: "inconclusive", reason: "component-background-image-or-gradient", layers: [] }
            : outsideBackground
        );
      }

      const borderSamples = new Map();
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        const width = Number.parseFloat(style["border" + side + "Width"]);
        const borderStyle = style["border" + side + "Style"];
        const borderColor = style["border" + side + "Color"];
        if (!Number.isFinite(width) || width <= 0 || borderStyle === "none" ||
            !hasVisibleAlpha(borderColor)) continue;
        if (!borderSamples.has(borderColor)) borderSamples.set(borderColor, []);
        borderSamples.get(borderColor).push(side.toLowerCase());
      }
      for (const [borderColor, sides] of borderSamples) {
        addNonTextSample(element, "component-boundary", borderColor, sides.join(","));
      }

      const outlineWidth = Number.parseFloat(style.outlineWidth);
      if (Number.isFinite(outlineWidth) && outlineWidth > 0 &&
          style.outlineStyle !== "none" && hasVisibleAlpha(style.outlineColor)) {
        addNonTextSample(element, "focus-indicator", style.outlineColor, "outline");
      }
    }

    const graphicSelector = [
      "svg path", "svg circle", "svg ellipse", "svg rect", "svg line",
      "svg polyline", "svg polygon"
    ].join(",");
    for (const element of [...document.querySelectorAll(graphicSelector)].slice(0, 300)) {
      if (!isVisible(element) || element.closest("[aria-hidden='true']")) continue;
      const style = getComputedStyle(element);
      const background = backgroundFor(element.parentElement ?? element);
      const colors = new Set();
      if (style.fill && style.fill !== "none" && hasVisibleAlpha(style.fill)) {
        colors.add(style.fill);
      }
      if (style.stroke && style.stroke !== "none" && hasVisibleAlpha(style.stroke)) {
        colors.add(style.stroke);
      }
      for (const color of colors) {
        addNonTextSample(element, "non-text-graphic", color, style.fill === color ? "fill" : "stroke", background);
      }
    }

    const root = document.documentElement;
    const body = document.body;
    const mediaDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const markerNodes = [root, body].filter(Boolean);
    let themeMarker = null;
    let themeMarkerSource = null;
    for (const node of markerNodes) {
      const candidates = [
        ["data-theme", node.getAttribute("data-theme")],
        ["data-bs-theme", node.getAttribute("data-bs-theme")],
        ["data-color-scheme", node.getAttribute("data-color-scheme")],
        ["class", [...node.classList].join(" ")]
      ];
      for (const [source, value] of candidates) {
        if (!value) continue;
        const match = String(value).toLowerCase().match(/(?:^|[\s_-])(dark|light)(?:$|[\s_-])/);
        if (match) {
          themeMarker = match[1];
          themeMarkerSource = source;
        }
      }
      if (themeMarker) break;
    }

    const rootStyle = getComputedStyle(root);
    const tokenNames = new Set();
    const hardcodedColorDeclarations = [];
    let hardcodedColorDeclarationCount = 0;
    const colorProperty = /^(?:color|background|background-color|border|border(?:-[a-z-]+)?(?:-color)?|outline|outline-color|text-decoration(?:-color)?|box-shadow|text-shadow|fill|stroke)$/i;
    const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|lab|color)\(|\b(?:black|white|red|green|blue|gray|grey|yellow|purple|orange|transparent)\b/i;
    let scannedCssRules = 0;
    let unreadableStylesheets = 0;
    const scanRules = (rules, depth = 0) => {
      if (!rules || depth > 12 || scannedCssRules >= 3000) return;
      for (const rule of rules) {
        if (scannedCssRules >= 3000) break;
        scannedCssRules += 1;
        if (rule.style) {
          for (let index = 0; index < rule.style.length; index += 1) {
            const property = rule.style.item(index);
            if (property.startsWith("--")) tokenNames.add(property);
            const value = rule.style.getPropertyValue(property).trim();
            if (rule.selectorText && colorProperty.test(property) && value &&
                !/\bvar\(/i.test(value) && colorLiteral.test(value)) {
              hardcodedColorDeclarationCount += 1;
              if (hardcodedColorDeclarations.length < 250) {
                hardcodedColorDeclarations.push({
                  selector: String(rule.selectorText).slice(0, 180),
                  property,
                  value: value.slice(0, 120),
                  source: "stylesheet"
                });
              }
            }
          }
        }
        if (rule.cssRules) scanRules(rule.cssRules, depth + 1);
      }
    };
    for (const sheet of [...document.styleSheets].slice(0, 200)) {
      try { scanRules(sheet.cssRules); } catch { unreadableStylesheets += 1; }
    }
    for (const element of [...document.querySelectorAll("[style]")].slice(0, 500)) {
      for (let index = 0; index < element.style.length; index += 1) {
        const property = element.style.item(index);
        const value = element.style.getPropertyValue(property).trim();
        if (colorProperty.test(property) && value &&
            !/\bvar\(/i.test(value) && colorLiteral.test(value)) {
          hardcodedColorDeclarationCount += 1;
          if (hardcodedColorDeclarations.length < 250) {
            hardcodedColorDeclarations.push({
              selector: selectorFor(element),
              property,
              value: value.slice(0, 120),
              source: "inline-style"
            });
          }
        }
      }
    }
    for (const element of [root, body].filter(Boolean)) {
      for (let index = 0; index < element.style.length; index += 1) {
        const property = element.style.item(index);
        if (property.startsWith("--")) tokenNames.add(property);
      }
    }

    const colorTokens = [];
    for (const [scope, element] of [["root", root], ["body", body]]) {
      if (!element) continue;
      const computed = getComputedStyle(element);
      for (const property of tokenNames) {
        const value = computed.getPropertyValue(property).trim();
        if (!value) continue;
        if (/color|surface|background|foreground|border|text|primary|secondary|accent|muted|success|warning|danger|error|card|panel|input|ring|popover|brand|link/i.test(property) ||
            /^(#|rgb|hsl|oklch|lab|color\()/i.test(value)) {
          colorTokens.push({ name: property, value: value.slice(0, 160), scope });
        }
      }
    }

    return {
      themeAudit: {
        requestedColorScheme: mediaDark ? "dark" : "light",
        rootColorScheme: rootStyle.colorScheme,
        themeMarker,
        themeMarkerSource,
        scannedCssRules,
        unreadableStylesheets,
        rootClasses: [...root.classList].slice(0, 30),
        bodyClasses: body ? [...body.classList].slice(0, 30) : [],
        colorTokens: colorTokens.slice(0, 200),
        hardcodedColorDeclarationCount,
        hardcodedColorDeclarations,
        colorTokenScan: {
          scannedCssRules,
          unreadableStylesheets
        }
      },
      contrastSamples: samples.slice(0, 800)
    };
  });
}

export async function applyThemeOverride(page, { theme, attribute = null } = {}) {
  if (!attribute) return;
  await page.evaluate(({ attribute: name, theme: selectedTheme }) => {
    const root = document.documentElement;
    if (name === "class") {
      root.classList.remove(selectedTheme === "dark" ? "light" : "dark");
      root.classList.add(selectedTheme);
    } else {
      root.setAttribute(name, selectedTheme);
    }
    window.dispatchEvent(new CustomEvent("jbqa:theme-override", {
      detail: { theme: selectedTheme }
    }));
  }, { attribute, theme });
  await page.waitForTimeout(50);
}

const COLOR_FUNCTION = /^rgba?\((.*)\)$/i;

function channel(value) {
  const input = value.trim();
  if (input.endsWith("%")) return Math.min(255, Math.max(0, Number.parseFloat(input) * 2.55));
  return Math.min(255, Math.max(0, Number.parseFloat(input)));
}

export function parseCssColor(value) {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase();
  const hex = input.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((part) => part + part).join("");
    if (digits.length !== 6 && digits.length !== 8) return null;
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1
    };
  }

  const match = input.match(COLOR_FUNCTION);
  if (!match) return null;
  const values = match[1].replace(/\s*\/\s*/, ",").split(/[\s,]+/).filter(Boolean);
  if (values.length < 3 || values.length > 4) return null;
  const components = values.slice(0, 3).map(channel);
  const alphaToken = values[3] ?? "1";
  const alpha = alphaToken.endsWith("%")
    ? Number.parseFloat(alphaToken) / 100
    : Number.parseFloat(alphaToken);
  if ([...components, alpha].some((part) => !Number.isFinite(part))) return null;
  return { r: components[0], g: components[1], b: components[2], a: Math.min(1, Math.max(0, alpha)) };
}

function composite(foreground, background) {
  const alpha = foreground.a;
  if (alpha >= 1) return { ...foreground, a: 1 };
  if (!background) return null;
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1
  };
}

function resolveBackground(layers) {
  if (!Array.isArray(layers) || !layers.length) return null;
  let result = null;
  // Layers are collected from the text element outward; composite in paint order.
  for (const colorText of [...layers].reverse()) {
    const layer = parseCssColor(colorText);
    if (!layer) return null;
    if (layer.a === 0) continue;
    result = composite(layer, result);
    if (!result) return null;
  }
  return result;
}

function linearize(value) {
  const channelValue = value / 255;
  return channelValue <= 0.04045
    ? channelValue / 12.92
    : ((channelValue + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color) {
  if (!color || ![color.r, color.g, color.b].every(Number.isFinite)) {
    throw new TypeError("A valid opaque RGB color is required");
  }
  return 0.2126 * linearize(color.r) +
    0.7152 * linearize(color.g) +
    0.0722 * linearize(color.b);
}

export function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function analyzeContrastSamples(samples, {
  normalTextRatio = 4.5,
  largeTextRatio = 3,
  nonTextRatio = 3
} = {}) {
  if (!Array.isArray(samples)) throw new TypeError("Contrast samples must be an array");
  for (const [name, value] of Object.entries({ normalTextRatio, largeTextRatio, nonTextRatio })) {
    if (!Number.isFinite(value) || value < 1 || value > 21) {
      throw new TypeError(name + " must be between 1 and 21");
    }
  }

  return Object.freeze(samples.map((sample) => {
    const base = {
      selector: sample.selector ?? null,
      kind: sample.kind ?? "text",
      componentPart: sample.componentPart ?? null,
      fontSizePx: Number(sample.fontSizePx) || null,
      fontWeight: Number(sample.fontWeight) || 400,
      state: sample.state ?? "default",
      interactionState: sample.interactionState ?? null,
      triggerSelector: sample.triggerSelector ?? null
    };
    if (sample.state === "disabled") {
      return Object.freeze({
        ...base,
        status: "exempt",
        reason: "inactive-ui-component",
        contrastRatio: null,
        requiredRatio: null,
        passed: null
      });
    }
    if (sample.backgroundStatus !== "resolved") {
      return Object.freeze({
        ...base,
        status: "inconclusive",
        reason: sample.backgroundReason ?? "background-not-resolved",
        contrastRatio: null,
        requiredRatio: null,
        passed: null
      });
    }

    const foreground = parseCssColor(sample.foreground);
    const background = resolveBackground(sample.backgroundLayers);
    if (!foreground || !background) {
      return Object.freeze({
        ...base,
        status: "inconclusive",
        reason: "unsupported-color-format",
        contrastRatio: null,
        requiredRatio: null,
        passed: null
      });
    }
    const renderedForeground = composite(foreground, background);
    if (!renderedForeground) {
      return Object.freeze({
        ...base,
        status: "inconclusive",
        reason: "foreground-transparency-without-known-backdrop",
        contrastRatio: null,
        requiredRatio: null,
        passed: null
      });
    }
    const isText = base.kind === "text" || base.kind === "placeholder";
    const isLargeText = base.fontSizePx >= 24 ||
      (base.fontSizePx >= 18.66 && base.fontWeight >= 700);
    const requiredRatio = isText
      ? (isLargeText ? largeTextRatio : normalTextRatio)
      : nonTextRatio;
    const ratio = contrastRatio(renderedForeground, background);
    return Object.freeze({
      ...base,
      status: "measured",
      reason: null,
      contrastRatio: Number(ratio.toFixed(3)),
      requiredRatio,
      passed: ratio >= requiredRatio
    });
  }));
}

export function summarizeContrastResults(results) {
  const measured = results.filter((item) => item.status === "measured");
  const failed = measured.filter((item) => item.passed === false);
  return Object.freeze({
    samples: results.length,
    measured: measured.length,
    failed: failed.length,
    passed: measured.length - failed.length,
    inconclusive: results.filter((item) => item.status === "inconclusive").length,
    exempt: results.filter((item) => item.status === "exempt").length
  });
}

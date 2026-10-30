export function getViewport(context = {}) {
  const width = Number(context.viewport?.width ?? context.viewportWidth);
  const height = Number(context.viewport?.height ?? context.viewportHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null
  };
}

export function getElements(context, key) {
  const value = context[key];
  return Array.isArray(value) ? value : [];
}

export function getElementLabel(element = {}) {
  return element.selector || element.name || element.tagName || "Unknown element";
}

export function isVisible(element = {}) {
  return element.visible !== false && element.display !== "none" && element.visibility !== "hidden";
}

export { responsiveRules } from "./responsive/index.js";
import { uiUxRules as baseUiUxRules } from "./ui-ux/index.js";
import { themeContrastRules } from "./ui-ux/theme-contrast.js";
import { layoutIntegrityRules } from "./ui-ux/layout-integrity.js";
export const uiUxRules = Object.freeze([
  ...baseUiUxRules,
  ...themeContrastRules,
  ...layoutIntegrityRules
]);
export { accessibilityRules } from "./accessibility/index.js";
export { performanceRules } from "./performance/index.js";
export { functionalRules } from "./functional/index.js";
export { consistencyRules } from "./consistency/index.js";

export const SPECIALIST_IDS = Object.freeze([
  "ui-ux",
  "responsive",
  "accessibility",
  "performance",
  "functional",
  "consistency",
  "code-quality",
  "security",
  "dependencies",
  "database"
]);

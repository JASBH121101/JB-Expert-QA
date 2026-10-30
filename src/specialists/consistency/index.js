import { getElements } from "../shared/context.js";

export const consistencyRules = [
  {
    id: "consistency.card-image-ratio",
    specialist: "consistency",
    evaluate(context) {
      const samples = getElements(context, "cards")
        .flatMap((card) => getElements(card, "imageRatios").map((ratio) => ({
          selector: card.selector ?? null,
          ratio: Number(ratio)
        })))
        .filter((item) => Number.isFinite(item.ratio) && item.ratio > 0);
      if (samples.length < 2) return [];
      const ratios = samples.map((item) => item.ratio);
      const spread = Math.max(...ratios) - Math.min(...ratios);
      const threshold = Number(context.thresholds?.cardImageRatioSpread ?? 0.2);
      if (spread < threshold) return [];
      return {
        id: "CONS-001",
        title: "Repeated card images have inconsistent proportions",
        description: "Image aspect ratios differ by " + spread.toFixed(2) + " across detected card components.",
        severity: "low",
        evidence: { samples, spread, threshold },
        recommendation: "Use a consistent image container ratio and object-fit strategy for repeated cards."
      };
    }
  },
  {
    id: "consistency.card-button-height",
    specialist: "consistency",
    evaluate(context) {
      const samples = getElements(context, "cards")
        .flatMap((card) => getElements(card, "buttonHeights").map((height) => ({
          selector: card.selector ?? null,
          height: Number(height)
        })))
        .filter((item) => Number.isFinite(item.height) && item.height > 0);
      if (samples.length < 2) return [];
      const heights = samples.map((item) => item.height);
      const spread = Math.max(...heights) - Math.min(...heights);
      const threshold = Number(context.thresholds?.cardButtonHeightSpreadPx ?? 8);
      if (spread <= threshold) return [];
      return {
        id: "CONS-002",
        title: "Repeated card controls have inconsistent heights",
        description: "Button heights differ by " + spread.toFixed(1) + "px across detected cards.",
        severity: "low",
        evidence: { samples, spread, threshold },
        recommendation: "Align repeated actions with shared component styles or consistent minimum heights."
      };
    }
  }
];

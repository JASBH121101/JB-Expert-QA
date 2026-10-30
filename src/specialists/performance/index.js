import { getElements } from "../shared/context.js";

export const performanceRules = [
  {
    id: "performance.large-transfer",
    specialist: "performance",
    evaluate(context) {
      const limit = Number(context.thresholds?.largeResourceBytes ?? 500000);
      return getElements(context, "resources")
        .filter((resource) => Number(resource.transferSize) >= limit && Number(resource.transferSize) > 0)
        .slice(0, 20)
        .map((resource, index) => ({
          id: "PERF-001-" + (index + 1),
          title: "Large resource transfer",
          description: "A resource transferred " + Math.round(Number(resource.transferSize) / 1024) + " KB.",
          severity: Number(resource.transferSize) >= limit * 2 ? "high" : "medium",
          location: resource.name ?? null,
          evidence: { transferSizeBytes: Number(resource.transferSize), initiatorType: resource.initiatorType },
          recommendation: "Compress images, use modern formats, remove unused payloads, and consider caching."
        }));
    }
  },
  {
    id: "performance.slow-resource",
    specialist: "performance",
    evaluate(context) {
      const limit = Number(context.thresholds?.slowResourceMs ?? 2500);
      return getElements(context, "resources")
        .filter((resource) => Number(resource.durationMs) >= limit)
        .slice(0, 20)
        .map((resource, index) => ({
          id: "PERF-002-" + (index + 1),
          title: "Slow-loading resource",
          description: "A resource took " + Math.round(Number(resource.durationMs)) + " ms to load.",
          severity: Number(resource.durationMs) >= limit * 2 ? "high" : "medium",
          location: resource.name ?? null,
          evidence: { durationMs: Number(resource.durationMs), initiatorType: resource.initiatorType },
          recommendation: "Inspect the resource origin, payload size, caching, and request waterfall."
        }));
    }
  },
  {
    id: "performance.image-dimensions",
    specialist: "performance",
    evaluate(context) {
      return getElements(context, "images")
        .filter((image) => image.visible !== false && (image.hasWidth !== true || image.hasHeight !== true))
        .slice(0, 30)
        .map((image, index) => ({
          id: "PERF-003-" + (index + 1),
          title: "Image dimensions are not reserved",
          description: "An image does not declare both width and height, which can contribute to layout shifts.",
          severity: "low",
          location: image.selector ?? null,
          evidence: { hasWidth: image.hasWidth, hasHeight: image.hasHeight },
          recommendation: "Provide intrinsic width and height attributes or reserve the image aspect ratio in CSS."
        }));
    }
  },
  {
    id: "performance.large-dom",
    specialist: "performance",
    evaluate(context) {
      const count = Number(context.domNodeCount);
      const limit = Number(context.thresholds?.largeDomNodeCount ?? 1500);
      if (!Number.isFinite(count) || count <= limit) return [];
      return {
        id: "PERF-004",
        title: "Large DOM tree",
        description: "The page contains " + count + " DOM elements, above the configured threshold of " + limit + ".",
        severity: count > limit * 2 ? "high" : "medium",
        evidence: { domNodeCount: count, threshold: limit },
        recommendation: "Reduce unnecessary wrappers, paginate long collections, and render large lists efficiently."
      };
    }
  }
];

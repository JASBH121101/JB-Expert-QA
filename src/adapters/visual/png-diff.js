import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";

const { PNG } = pngjs;

function validateRatio(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(name + " must be between 0 and 1");
  }
}

export function comparePngBuffers(baselineBuffer, actualBuffer, {
  threshold = 0.1,
  maxDiffPixelRatio = 0.005
} = {}) {
  validateRatio("threshold", threshold);
  validateRatio("maxDiffPixelRatio", maxDiffPixelRatio);
  if (!Buffer.isBuffer(baselineBuffer) || !baselineBuffer.length) {
    throw new TypeError("A non-empty baseline PNG buffer is required");
  }
  if (!Buffer.isBuffer(actualBuffer) || !actualBuffer.length) {
    throw new TypeError("A non-empty actual PNG buffer is required");
  }

  const baseline = PNG.sync.read(baselineBuffer);
  const actual = PNG.sync.read(actualBuffer);
  const baselineDimensions = { width: baseline.width, height: baseline.height };
  const actualDimensions = { width: actual.width, height: actual.height };

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return Object.freeze({
      status: "dimension-mismatch",
      passed: false,
      baselineDimensions,
      actualDimensions,
      totalPixels: actual.width * actual.height,
      diffPixels: null,
      diffPixelRatio: null,
      threshold,
      maxDiffPixelRatio,
      diffBuffer: null
    });
  }

  const diffImage = new PNG({ width: actual.width, height: actual.height });
  const diffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diffImage.data,
    actual.width,
    actual.height,
    { threshold, includeAA: false, alpha: 0.5 }
  );
  const totalPixels = actual.width * actual.height;
  const diffPixelRatio = totalPixels ? diffPixels / totalPixels : 0;

  return Object.freeze({
    status: "compared",
    passed: diffPixelRatio <= maxDiffPixelRatio,
    baselineDimensions,
    actualDimensions,
    totalPixels,
    diffPixels,
    diffPixelRatio,
    threshold,
    maxDiffPixelRatio,
    diffBuffer: PNG.sync.write(diffImage)
  });
}

export async function comparePngFiles({
  baselinePath,
  actualPath,
  diffPath,
  threshold = 0.1,
  maxDiffPixelRatio = 0.005
} = {}) {
  if (typeof baselinePath !== "string" || !baselinePath.trim()) {
    throw new TypeError("baselinePath is required");
  }
  if (typeof actualPath !== "string" || !actualPath.trim()) {
    throw new TypeError("actualPath is required");
  }
  const buffers = await Promise.all([readFile(baselinePath), readFile(actualPath)]);
  const result = comparePngBuffers(buffers[0], buffers[1], { threshold, maxDiffPixelRatio });
  let diffSaved = false;
  if (diffPath && result.diffBuffer) {
    await mkdir(dirname(diffPath), { recursive: true });
    await writeFile(diffPath, result.diffBuffer);
    diffSaved = true;
  }
  const { diffBuffer, ...summary } = result;
  return Object.freeze({
    ...summary,
    baselinePath,
    actualPath,
    diffPath: diffSaved ? diffPath : null
  });
}

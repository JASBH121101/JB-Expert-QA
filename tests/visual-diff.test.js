import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pngjs from "pngjs";
import { comparePngBuffers, comparePngFiles } from "../src/adapters/visual/png-diff.js";

const { PNG } = pngjs;

function fixture(width = 2, height = 2, changed = false) {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 20;
    image.data[index + 1] = 40;
    image.data[index + 2] = 60;
    image.data[index + 3] = 255;
  }
  if (changed) {
    image.data[0] = 250;
    image.data[1] = 0;
    image.data[2] = 0;
  }
  return PNG.sync.write(image);
}

test("visual diff passes identical PNGs", () => {
  const image = fixture();
  const result = comparePngBuffers(image, image);
  assert.equal(result.status, "compared");
  assert.equal(result.passed, true);
  assert.equal(result.diffPixels, 0);
  assert.equal(result.diffPixelRatio, 0);
  assert.ok(Buffer.isBuffer(result.diffBuffer));
});

test("visual diff measures changed pixels and returns a diff PNG", () => {
  const baseline = fixture();
  const current = fixture(2, 2, true);
  const result = comparePngBuffers(baseline, current, { maxDiffPixelRatio: 0 });
  assert.equal(result.status, "compared");
  assert.equal(result.passed, false);
  assert.equal(result.diffPixels, 1);
  assert.equal(result.diffPixelRatio, 0.25);
});

test("visual diff reports different dimensions as a blocking mismatch", () => {
  const result = comparePngBuffers(fixture(2, 2), fixture(3, 2));
  assert.equal(result.status, "dimension-mismatch");
  assert.equal(result.passed, false);
  assert.equal(result.diffBuffer, null);
});

test("file comparison writes a diff artifact without changing source images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jbqa-visual-"));
  try {
    const baselinePath = join(directory, "baseline.png");
    const actualPath = join(directory, "actual.png");
    const diffPath = join(directory, "diff", "result.png");
    const baseline = fixture();
    await writeFile(baselinePath, baseline);
    await writeFile(actualPath, fixture(2, 2, true));
    const result = await comparePngFiles({
      baselinePath,
      actualPath,
      diffPath,
      maxDiffPixelRatio: 0
    });
    assert.equal(result.passed, false);
    assert.equal(result.diffPath, diffPath);
    assert.ok((await readFile(diffPath)).length > 0);
    assert.deepEqual(await readFile(baselinePath), baseline);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("visual diff rejects invalid thresholds", () => {
  assert.throws(() => comparePngBuffers(fixture(), fixture(), { threshold: 2 }), /between 0 and 1/);
  assert.throws(() => comparePngBuffers(fixture(), fixture(), { maxDiffPixelRatio: -1 }), /between 0 and 1/);
});

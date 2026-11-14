import test from "node:test";
import assert from "node:assert/strict";
import { ResearchEngine } from "../src/research/research-engine.js";
import { KnowledgeStore, MemoryKnowledgeAdapter } from "../src/knowledge/knowledge-store.js";

const clock = () => new Date("2026-11-07T19:30:00.000Z");
const baseProvider = (overrides = {}) => ({
  id: "catalog-search",
  domains: ["fragrance"],
  async search() {
    return [{
      id: "entry-001",
      value: "vanilla, amber",
      status: "verified",
      confidence: 0.84,
      source: {
        name: "Perfume database",
        url: "https://example.com/perfume",
        type: "database",
      },
      observedAt: "2026-11-01T12:00:00.000Z",
    }];
  },
  ...overrides,
});

const request = {
  domain: "fragrance",
  subjectId: "perfume-001",
  field: "notes",
  query: "Vanilla amber perfume",
  providerId: "catalog-search",
};

test("stages source-backed provider results as unconfirmed candidates only", async () => {
  const engine = new ResearchEngine({ providers: [baseProvider()], clock });
  const result = await engine.research(request);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.decision, "pending_review");
  assert.equal(result.changesVerifiedData, false);
  assert.equal(result.candidates[0].evidence.status, "unconfirmed");
  assert.equal(result.candidates[0].decision, "pending_review");
  assert.equal(result.candidates[0].assessment.preferred, true);
  assert.equal(engine.getPendingCandidates().length, 1);
});

test("does not store candidates until explicit human approval", async () => {
  const engine = new ResearchEngine({ providers: [baseProvider()], clock });
  const result = await engine.research(request);
  const knowledgeStore = await KnowledgeStore.open({ adapter: new MemoryKnowledgeAdapter(), clock });

  await assert.rejects(
    () => engine.stageCandidate(result.candidates[0].candidateId, { knowledgeStore }),
    /Explicit human approval/,
  );
  assert.equal(knowledgeStore.getEvidenceStore().size, 0);

  const staged = await engine.stageCandidate(result.candidates[0].candidateId, {
    knowledgeStore,
    approved: true,
  });
  assert.equal(staged.staged, true);
  assert.equal(staged.status, "unconfirmed");
  assert.equal(staged.remainsUnconfirmed, true);
  assert.equal(knowledgeStore.getEvidenceStore().size, 1);
  assert.equal(engine.getPendingCandidates().length, 0);
});

test("prevents duplicate staging and re-research of a previously staged source record", async () => {
  const engine = new ResearchEngine({ providers: [baseProvider()], clock });
  const result = await engine.research(request);
  const knowledgeStore = await KnowledgeStore.open({ adapter: new MemoryKnowledgeAdapter(), clock });
  await engine.stageCandidate(result.candidates[0].candidateId, {
    knowledgeStore,
    approved: true,
  });
  await assert.rejects(
    () => engine.stageCandidate(result.candidates[0].candidateId, {
      knowledgeStore,
      approved: true,
    }),
    /not found/,
  );
  await assert.rejects(() => engine.research(request), /Duplicate research evidence ID/);
});

test("enforces provider domain restrictions and provider registration", async () => {
  const engine = new ResearchEngine({ providers: [baseProvider()], clock });
  await assert.rejects(() => engine.research({ ...request, domain: "technology" }), /does not support/);
  await assert.rejects(() => engine.research({ ...request, providerId: "missing" }), /not registered/);
});

test("validates provider output and rejects unsafe source URLs", async () => {
  const missingValue = new ResearchEngine({
    providers: [baseProvider({ async search() { return [{ id: "bad", confidence: 0.8, source: { name: "x", url: "https://example.com", type: "database" } }]; } })],
    clock,
  });
  await assert.rejects(() => missingValue.research(request), /non-null value/);

  const unsafe = new ResearchEngine({
    providers: [baseProvider({ async search() { return [{
      id: "unsafe",
      value: "claim",
      confidence: 0.8,
      source: { name: "Bad link", url: "javascript:alert(1)", type: "database" },
    }]; } })],
    clock,
  });
  await assert.rejects(() => unsafe.research(request), /valid URL|HTTP or HTTPS/);
});

test("limits result count and marks truncated provider responses", async () => {
  const provider = baseProvider({
    async search() {
      return [1, 2, 3].map(number => ({
        id: `entry-${number}`,
        value: `claim-${number}`,
        confidence: 0.8,
        source: { name: "Perfume database", url: `https://example.com/${number}`, type: "database" },
      }));
    },
  });
  const engine = new ResearchEngine({ providers: [provider], clock });
  const result = await engine.research({ ...request, limit: 2 });
  assert.equal(result.candidateCount, 2);
  assert.equal(result.truncated, true);
});

test("rejects duplicate provider IDs, invalid providers and invalid result limits", async () => {
  assert.throws(() => new ResearchEngine({ providers: [baseProvider(), baseProvider()], clock }), /Duplicate research provider/);
  assert.throws(() => new ResearchEngine({ providers: [{ id: "broken" }], clock }), /must implement search/);
  const engine = new ResearchEngine({ providers: [baseProvider()], clock });
  await assert.rejects(() => engine.research({ ...request, limit: 21 }), /between 1 and 20/);
});

test("does not stage invalid candidates or exceed pending candidate capacity", async () => {
  const provider = baseProvider({
    async search() {
      return [1, 2].map(number => ({
        id: `entry-${number}`,
        value: number,
        confidence: 0.8,
        source: { name: "Perfume database", url: `https://example.com/${number}`, type: "database" },
      }));
    },
  });
  const engine = new ResearchEngine({ providers: [provider], clock, maxPendingCandidates: 1 });
  await assert.rejects(() => engine.research(request), /capacity/);
  assert.equal(engine.getPendingCandidates().length, 0);

  const emptyEngine = new ResearchEngine({ providers: [baseProvider()], clock });
  await emptyEngine.research(request);
  await assert.rejects(() => emptyEngine.stageCandidate("candidate:wrong", {
    knowledgeStore: {},
    approved: true,
  }), /addEvidence/);
});


test("research candidates preserve source attribution, references and license metadata", async () => {
  const provider = baseProvider({
    id: "open-beauty-facts-cosmetics",
    async search() {
      return [{
        id: "3560070791460",
        value: ["en:body-mists"],
        confidence: 0.72,
        source: {
          name: "Open Beauty Facts",
          url: "https://world.openbeautyfacts.org/product/3560070791460",
          type: "database",
          attribution: "Contains information from Open Beauty Facts under ODbL 1.0.",
          references: [
            "https://world.openbeautyfacts.org/",
            "https://opendatacommons.org/licenses/odbl/1-0/",
          ],
          license: "ODbL 1.0; individual contents may have separate rights",
        },
        observedAt: "2026-11-08T14:00:00.000Z",
        note: "Raw categories only; product type awaits review.",
      }];
    },
  });
  const engine = new ResearchEngine({ providers: [provider], clock });
  const result = await engine.research({
    ...request,
    field: "category",
    providerId: "open-beauty-facts-cosmetics",
  });
  const source = result.candidates[0].evidence.source;
  assert.equal(source.attribution, "Contains information from Open Beauty Facts under ODbL 1.0.");
  assert.deepEqual(source.references, [
    "https://world.openbeautyfacts.org/",
    "https://opendatacommons.org/licenses/odbl/1-0/",
  ]);
  assert.match(source.license, /ODbL 1.0/u);
  assert.equal(result.candidates[0].evidence.status, "unconfirmed");
});

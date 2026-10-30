import { ExpertQAEngine, RuleRegistry } from "../src/index.js";
import config from "../config/default.config.json" with { type: "json" };

const registry = new RuleRegistry();

registry.register({
  id: "demo.missing-page-title",
  specialist: "accessibility",
  async evaluate(context) {
    if (context.hasDocumentTitle) return [];
    return {
      id: "A11Y-001",
      title: "Page title is missing",
      description: "The page does not expose a document title.",
      severity: "medium",
      recommendation: "Add a concise, descriptive HTML title."
    };
  }
});

const engine = new ExpertQAEngine({ registry, config });
const report = await engine.audit({ hasDocumentTitle: false });
console.log(JSON.stringify(report, null, 2));

import { readFile } from "node:fs/promises";
import { buildSccmReport } from "../packages/sccm/src/index.js";

const inventoryUrl = new URL("../packages/sccm/manifests/inventory.v1.json", import.meta.url);
const historyUrl = new URL("../packages/sccm/manifests/assessments.v1.json", import.meta.url);
const [inventoryText, historyText] = await Promise.all([
  readFile(inventoryUrl, "utf8"),
  readFile(historyUrl, "utf8")
]);
const inventory = JSON.parse(inventoryText);
const history = JSON.parse(historyText);
const report = buildSccmReport(inventory, history);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

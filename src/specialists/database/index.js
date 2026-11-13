import { projectRules } from "../project-rules.js";
import { operationalDatabaseRules } from "./operational-rules.js";

const existingDatabaseRules = projectRules.filter((rule) => rule.specialist === "database");

export const databaseSpecialistRules = Object.freeze([
  ...existingDatabaseRules,
  ...operationalDatabaseRules
]);

export { existingDatabaseRules, operationalDatabaseRules };

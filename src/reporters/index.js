import { formatMarkdownReport } from "./markdown.js";
import { formatHtmlReport } from "./html.js";

export function formatReport(report, format = "json") {
  if (format === "json") return JSON.stringify(report, null, 2);
  if (format === "markdown") return formatMarkdownReport(report);
  if (format === "html") return formatHtmlReport(report);
  throw new TypeError("Unsupported report format: " + format);
}

export { formatMarkdownReport, formatHtmlReport };

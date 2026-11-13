import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../assets/css/admin.css", import.meta.url), "utf8");
const normalizedCss = css.replace(/\s+/g, " ").trim();

test("admin layout containers are allowed to shrink to the viewport", () => {
  assert.ok(
    normalizedCss.includes(".admin-layout, .admin-sidebar, .admin-main, .admin-page-heading, .stat-grid, .stat-card, .admin-panel, .panel-heading, .table-wrap, .settings-form { min-width: 0; }"),
    "admin layout containers must have min-width: 0"
  );
});

test("the products table scrolls inside its own constrained wrapper", () => {
  assert.ok(
    normalizedCss.includes(".table-wrap { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }"),
    "the table wrapper must constrain and scroll its content"
  );
  assert.ok(
    normalizedCss.includes(".product-table { width: 100%; min-width: 590px; }"),
    "the table must preserve a readable minimum width"
  );
});

test("mobile admin content is constrained to the available viewport width", () => {
  assert.ok(
    normalizedCss.includes("@media (max-width: 760px) { .admin-main { width: 100%; max-width: 100%; }"),
    "the mobile breakpoint must constrain the admin main area"
  );
});

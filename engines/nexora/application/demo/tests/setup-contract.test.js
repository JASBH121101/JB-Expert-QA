import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../setup.html");
const js = read("../assets/js/setup.js");
const css = read("../assets/css/setup.css");
const scripts = [js, read("../assets/js/admin.js"), read("../assets/js/app.js")];
const scope = read("../../docs/PRODUCT-SCOPE.md");
const adminHtml = read("../admin.html");
const adminJs = read("../assets/js/admin.js");
const publicJs = read("../assets/js/app.js");
const adminCss = read("../assets/css/admin.css");
const publicCss = read("../assets/css/styles.css");

test("setup wizard exposes the four guided stages", () => {
  for (const step of [1, 2, 3, 4]) {
    assert.ok(html.includes('data-step="' + step + '"'), "missing setup step " + step);
  }
  assert.ok(html.includes('id="previous-step"'));
  assert.ok(html.includes('id="next-step"'));
  assert.ok(html.includes('id="save-setup"'));
});

test("the owner may register at most five WhatsApp numbers", () => {
  assert.ok(html.includes('id="phone-list"'));
  assert.ok(js.includes("state.phones.length>=5"));
  assert.ok(js.includes(".slice(0,5)"));
  assert.ok(js.includes("isMain") && js.includes("showPublic"));
});

test("industry templates cover the planned sectors", () => {
  for (const key of ["perfumery", "fashion", "technology", "gym", "automotive", "grocery", "other"]) {
    assert.ok(js.includes(key + ":{"), "missing template " + key);
  }
});

test("custom field definitions support groups, order, types and public visibility", () => {
  for (const token of ["required", "showPublic", "searchable", "width", "unitGroup", "options"]) {
    assert.ok(js.includes(token), "missing field property " + token);
  }
  for (const token of ["text", "number", "select", "multiselect", "boolean", "date", "textarea"]) {
    assert.ok(js.includes(token + ":"), "missing field type " + token);
  }
  assert.ok(js.includes("data-field-move"));
  assert.ok(js.includes("data-group-move"));
});

test("measurement units are separated by dimension", () => {
  for (const dimension of ["mass", "volume", "displacement", "length", "count", "digital", "area"]) {
    assert.ok(js.includes(dimension + ":["), "missing unit dimension " + dimension);
  }
  assert.ok(js.includes("unitsFor(f.unitGroup)"));
  assert.ok(js.includes('field("Memoria RAM","number",{unitGroup:"digital",unit:"GB"})'));
  assert.ok(js.includes('field("Cilindraje","number",{unitGroup:"displacement",unit:"cc"})'));
  assert.ok(js.includes('displacement:["cc"]'));
  assert.ok(js.includes('volume:["L","ml","gal","fl oz"]'));
  assert.ok(html.includes('<option value="displacement">Cilindraje de motor</option>'));
});

test("photographs are optional and appear in the preview only when enabled", () => {
  assert.ok(html.includes('id="photos-enabled"'));
  assert.ok(js.includes("photosEnabled:false"));
  assert.ok(js.includes("if(state.photosEnabled)"));
});

test("the demo does not collect a real password or claim production authentication", () => {
  assert.doesNotMatch(html, /type=["']password["']/i);
  assert.match(html, /no crea cuentas ni solicita contraseñas reales/i);
  assert.match(js, /mode:"demo-local-only"/);
  assert.match(js, /localStorage\.setItem\(STORE_KEY/);
});

test("the dynamic product preview has responsive layout rules", () => {
  assert.match(css, /\.product-preview\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /\.product-preview\s*\{[^}]*grid-template-columns:1fr/s);
});

test("the product scope keeps dynamic definitions in application data rather than dynamic SQL", () => {
  assert.match(scope, /nunca crean tablas SQL arbitrarias/i);
  assert.match(scope, /product_field_definitions/);
  assert.match(scope, /product_field_values/);
});

test("the admin product form consumes the selected dynamic template", () => {
  assert.ok(adminHtml.includes('id="dynamic-product-fields"'));
  assert.ok(adminJs.includes('localStorage.getItem(STUDIO_KEY)'));
  assert.ok(adminJs.includes("renderDynamicFields(product.attributes || {})"));
  assert.ok(adminJs.includes("collectDynamicValues()"));
  assert.ok(adminJs.includes('const queryAll = (selector, root = document) => Array.from(root.querySelectorAll(selector))'));
  assert.ok(adminJs.includes('queryAll("[data-custom-field]", dynamicFields)'));
  assert.doesNotMatch(adminJs, /const \$ = \(selector, root = document\)/);
  assert.ok(adminJs.includes("attributes,"));
});

test("product photo controls follow the optional-photo setting", () => {
  assert.ok(adminJs.includes("photoField.hidden = !photoUploadsEnabled()"));
  assert.ok(adminJs.includes('(products.find((item) => item.id === id)?.image || "")'));
  assert.ok(adminJs.includes('photoUploadsEnabled() && product.image ? safeImageSource(product.image)'));
  assert.ok(adminJs.includes('if (!photoUploadsEnabled()) $("#product-image").value = ""'));
  assert.ok(publicJs.includes("media.hidden = !(photosEnabled && product.image)"));
  assert.match(publicCss, /\.dialog-media\[hidden\]/);
});

test("draft products stay private while published products drive public category filters", () => {
  assert.ok(adminHtml.includes('id="product-published"'));
  assert.ok(adminJs.includes('product.published !== false'));
  assert.ok(adminJs.includes('$("#product-published").checked'));
  assert.ok(publicJs.includes('filter((product) => product.published !== false)'));
  assert.ok(publicJs.includes('products.map((product) => product.category)'));
  assert.ok(publicJs.includes('new Set([...(business.categories || []), ...dynamicCategories])'));
});

test("product prices support the configured primary and additional currencies", () => {
  assert.ok(adminHtml.includes('id="product-prices"'));
  assert.ok(adminJs.includes("enabledCurrencies()"));
  assert.ok(adminJs.includes("collectProductPrices()"));
  assert.ok(adminJs.includes("prices,"));
  assert.ok(publicJs.includes("productPrice(product)"));
  assert.ok(publicJs.includes('primaryCurrency()'));
  assert.ok(read("../assets/js/store.js").includes('money = (amount, currency = "USD")'));
  assert.ok(read("../index.html").includes('id="results-currency"'));
});

test("the configured setup profile drives the public site and hides the sector demo switcher", () => {
  assert.ok(publicJs.includes('id: "studio-config"'));
  assert.ok(publicJs.includes("studioConfig.identity?.description"));
  assert.ok(publicJs.includes("studioConfig.identity?.coverUrl"));
  assert.ok(publicJs.includes("phone.showPublic"));
  assert.ok(publicJs.includes("/^" + String.fromCharCode(92) + "d{8,15}$/"));
  assert.ok(publicJs.includes("visiblePhones.length < 2"));
  assert.ok(publicJs.includes("renderContactTargets"));
  assert.ok(publicJs.includes('document.documentElement.style.setProperty("--lime", primaryColor)'));
  assert.ok(adminJs.includes('id: "studio-config"'));
  assert.ok(adminJs.includes('businessSelect.closest("label")?.setAttribute("hidden", "")'));
  assert.ok(adminHtml.includes('id="admin-business-select"'));
  assert.ok(read("../index.html").includes('id="contact-phone-select"'));
});

test("the public product detail renders only fields marked as public", () => {
  assert.ok(publicJs.includes("field.showPublic"));
  assert.ok(publicJs.includes("product.attributes[field.id]"));
  assert.ok(adminJs.includes("return definition?.showPublic ?"));
  assert.match(publicCss, /\.attribute-group/);
});

test("the admin dynamic field grid collapses safely on narrow screens", () => {
  assert.match(adminCss, /\.dynamic-product-group\s*\{[^}]*grid-template-columns:repeat\(2/);
  assert.match(adminCss, /@media\(max-width:430px\)\s*\{\s*\.dynamic-product-group\s*\{\s*grid-template-columns:1fr/);
});

test("all demo JavaScript bundles parse without syntax errors", () => {
  for (const source of scripts) {
    assert.doesNotThrow(() => new Script(source));
  }
});

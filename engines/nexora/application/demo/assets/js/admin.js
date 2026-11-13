(() => {
  const demos = window.NEXORA_DEMOS || [];
  const $ = (selector) => document.querySelector(selector);
  const queryAll = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const make = (tag, text) => {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  };
  const safeImageSource = (value) => {
    try {
      const url = new URL(String(value), window.location.href);
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
      // Invalid image URLs use the local fallback below.
    }
    return "assets/img/product-placeholder.svg";
  };
  const businessSelect = $("#admin-business-select");
  const productRows = $("#admin-product-rows");
  const dialog = $("#product-form-dialog");
  const form = $("#product-form");
  const toast = $("#admin-toast");
  const dynamicFields = $("#dynamic-product-fields");
  const priceFields = $("#product-prices");
  const photoField = $("#product-image-field");
  const STUDIO_KEY = "nexora-studio:v1";
  const readStudioConfig = () => {
    try {
      const value = JSON.parse(localStorage.getItem(STUDIO_KEY) || "null");
      return value && value.schemaVersion === 1 && value.catalog ? value : null;
    } catch { return null; }
  };
  const studioConfig = readStudioConfig();
  const photoUploadsEnabled = () => studioConfig ? Boolean(studioConfig.catalog.photosEnabled) : true;
  const schemaGroups = () => studioConfig?.catalog?.groups || [];
  const primaryCurrency = () => studioConfig?.pricing?.primaryCurrency || "USD";
  const enabledCurrencies = () => {
    const listed = Array.isArray(studioConfig?.pricing?.enabledCurrencies)
      ? studioConfig.pricing.enabledCurrencies.filter((code) => /^[A-Z]{3}$/.test(String(code)))
      : ["USD"];
    const currencies = [...new Set([primaryCurrency(), ...listed])];
    return currencies.length ? currencies : ["USD"];
  };
  const productPrice = (product, currency = primaryCurrency()) => {
    if (product?.prices && Object.prototype.hasOwnProperty.call(product.prices, currency)) return product.prices[currency];
    return currency === "USD" ? product?.price : null;
  };
  const renderProductPrices = (product = null) => {
    const savedPrices = product?.prices || {};
    priceFields.replaceChildren(...enabledCurrencies().map((currency) => {
      const label = make("label", "Precio (" + currency + ")");
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.inputMode = "decimal";
      input.dataset.productPrice = currency;
      const saved = Object.prototype.hasOwnProperty.call(savedPrices, currency)
        ? savedPrices[currency]
        : (currency === primaryCurrency() && product ? product.price : "");
      input.value = saved === null || saved === undefined ? "" : String(saved);
      label.append(input);
      return label;
    }));
  };
  const collectProductPrices = () => {
    const prices = {};
    for (const input of queryAll("[data-product-price]", priceFields)) {
      const raw = input.value.trim();
      if (!raw) continue;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0) return null;
      prices[input.dataset.productPrice] = amount;
    }
    return prices;
  };
  const studioTypeLabels = {
    perfumery: "Perfumería",
    fashion: "Ropa y calzado",
    technology: "Tecnología",
    gym: "Gimnasio y fitness",
    automotive: "Repuestos y vehículos",
    grocery: "Alimentos y abarrotes",
    other: "Catálogo personalizado"
  };
  const studioPhone = (studioConfig?.business?.phones || []).find((phone) => phone.isMain && phone.showPublic)
    || (studioConfig?.business?.phones || []).find((phone) => phone.showPublic);
  const studioBusiness = studioConfig ? {
    id: "studio-config",
    name: studioConfig.business.name || "Mi negocio",
    tagline: studioTypeLabels[studioConfig.business.type] || studioTypeLabels.other,
    categories: [],
    products: [],
    whatsapp: studioPhone?.number || "",
    contact: "Consulta directamente con el negocio por WhatsApp."
  } : null;
  let business = studioBusiness || demos.find((item) => item.id === businessSelect?.value) || demos[0];
  if (studioConfig && businessSelect) businessSelect.closest("label")?.setAttribute("hidden", "");
  let products = business ? NexoraStore.getProducts(business) : [];
  let toastTimer;

  if (!business) return;

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
  };
  const persistProducts = () => {
    if (!NexoraStore.saveProducts(business.id, products)) {
      showToast("No fue posible guardar. El almacenamiento local puede estar lleno.");
      return false;
    }
    render();
    return true;
  };
  const render = () => {
    const categories = new Set(products.map((item) => item.category).filter(Boolean));
    const publishedProducts = products.filter((item) => item.published !== false);
    $("#stat-products").textContent = String(publishedProducts.length);
    $("#stat-categories").textContent = String(new Set(publishedProducts.map((item) => item.category).filter(Boolean)).size);
    $("#stat-featured").textContent = String(publishedProducts.filter((item) => item.featured).length);
    $("#admin-empty").hidden = products.length > 0;

    const rows = products.map((product) => {
      const row = make("tr");
      const productCell = make("td");
      const productWrap = make("div");
      productWrap.classList.add("table-product");
      const image = make("img");
      image.src = photoUploadsEnabled() && product.image ? safeImageSource(product.image) : "assets/img/product-placeholder.svg";
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => { image.src = "assets/img/product-placeholder.svg"; }, { once: true });
      const productText = make("span");
      productText.append(make("strong", product.name), make("small", product.detail || "Sin detalle"));
      productWrap.append(image, productText);
      productCell.append(productWrap);

      const categoryCell = make("td", product.category);
      const priceCell = make("td");
      const currentPrice = productPrice(product);
      priceCell.append(make("strong", currentPrice === null || currentPrice === undefined || currentPrice === ""
        ? "Consultar"
        : NexoraStore.money(currentPrice, primaryCurrency())));
      const stateCell = make("td");
      const isPublished = product.published !== false;
      const state = make("span", isPublished ? "Publicado" : "Borrador");
      state.classList.add("state-pill");
      if (!isPublished) state.classList.add("is-draft");
      stateCell.append(state);

      const actionsCell = make("td");
      const actions = make("div");
      actions.classList.add("row-actions");
      const edit = make("button", "✎");
      edit.classList.add("row-action");
      edit.type = "button";
      edit.dataset.edit = product.id;
      edit.setAttribute("aria-label", "Editar " + product.name);
      const remove = make("button", "×");
      remove.classList.add("row-action", "is-danger");
      remove.type = "button";
      remove.dataset.delete = product.id;
      remove.setAttribute("aria-label", "Eliminar " + product.name);
      actions.append(edit, remove);
      actionsCell.append(actions);
      row.append(productCell, categoryCell, priceCell, stateCell, actionsCell);
      return row;
    });
    productRows.replaceChildren(...rows);
  };
  const loadSettings = () => {
    const settings = NexoraStore.getSettings(business);
    $("#setting-name").value = settings.name;
    $("#setting-whatsapp").value = settings.whatsapp;
    $("#setting-contact").value = settings.contact;
  };
  const renderDynamicFields = (values = {}) => {
    dynamicFields.replaceChildren();
    const groups = schemaGroups().filter((item) => Array.isArray(item.fields) && item.fields.length);
    if (!groups.length) {
      const note = make("p", "No hay campos personalizados. Puedes configurarlos desde «Configurar negocio».");
      note.className = "dynamic-empty";
      dynamicFields.append(note);
      return;
    }
    groups.forEach((group) => {
      const section = make("section");
      section.className = "dynamic-product-group";
      section.append(make("h3", group.name));
      group.fields.forEach((field) => {
        const label = make("label");
        if (field.width === "full" || field.type === "textarea") label.classList.add("is-full");
        label.append(document.createTextNode(field.label + (field.required ? " *" : "")));
        let control;
        const saved = values[field.id] ?? "";
        if (field.type === "textarea") {
          control = document.createElement("textarea");
          control.value = Array.isArray(saved) ? saved.join(", ") : String(saved);
        } else if (field.type === "select" || field.type === "multiselect") {
          control = document.createElement("select");
          if (field.type === "multiselect") { control.multiple = true; control.size = Math.min(4, Math.max(2, (field.options || []).length)); }
          if (field.type === "select") {
            const empty = make("option", "Seleccionar…");
            empty.value = "";
            control.append(empty);
          }
          (field.options || []).forEach((option) => {
            const item = make("option", option);
            item.value = option;
            item.selected = Array.isArray(saved) ? saved.includes(option) : saved === option;
            control.append(item);
          });
        } else if (field.type === "boolean") {
          control = document.createElement("input");
          control.type = "checkbox";
          control.checked = saved === true || saved === "true";
        } else {
          control = document.createElement("input");
          control.type = field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
          if (field.type === "number") control.step = "any";
          control.value = Array.isArray(saved) ? saved.join(", ") : String(saved);
        }
        control.dataset.customField = field.id;
        control.dataset.customType = field.type;
        if (field.required) control.required = true;
        label.append(control);
        if (field.type === "number" && field.unit) {
          const unit = make("small", field.unit);
          unit.className = "dynamic-field-unit";
          label.append(unit);
        }
        section.append(label);
      });
      dynamicFields.append(section);
    });
  };
  const collectDynamicValues = () => {
    const attributes = {};
    for (const control of queryAll("[data-custom-field]", dynamicFields)) {
      const key = control.dataset.customField;
      if (control.dataset.customType === "boolean") attributes[key] = control.checked;
      else if (control.dataset.customType === "multiselect") attributes[key] = [...control.selectedOptions].map((option) => option.value);
      else if (control.dataset.customType === "number") attributes[key] = control.value === "" ? null : Number(control.value);
      else attributes[key] = control.value.trim();
    }
    return attributes;
  };
  const setPhotoFieldVisibility = () => {
    photoField.hidden = !photoUploadsEnabled();
    $("#product-image").required = false;
    if (!photoUploadsEnabled()) $("#product-image").value = "";
  };
  const resetProductForm = () => {
    form.reset();
    $("#product-id").value = "";
    $("#product-form-title").textContent = "Nuevo producto";
    $("#product-published").checked = true;
    renderDynamicFields();
    renderProductPrices();
    setPhotoFieldVisibility();
  };
  const openCreate = () => {
    resetProductForm();
    $("#product-category").value = business.categories[0] || "";
    $("#product-image").value = photoUploadsEnabled() ? (business.products[0]?.image || "") : "";
    dialog.showModal();
  };
  const openEdit = (id) => {
    const product = products.find((item) => item.id === id);
    if (!product) return;
    resetProductForm();
    $("#product-form-title").textContent = "Editar producto";
    $("#product-id").value = product.id;
    $("#product-name").value = product.name;
    $("#product-category").value = product.category;
    renderProductPrices(product);
    $("#product-old-price").value = product.oldPrice ?? "";
    $("#product-description").value = product.description;
    $("#product-image").value = product.image || "";
    $("#product-featured").checked = Boolean(product.featured);
    $("#product-published").checked = product.published !== false;
    renderDynamicFields(product.attributes || {});
    setPhotoFieldVisibility();
    dialog.showModal();
  };

  businessSelect.addEventListener("change", () => {
    business = demos.find((item) => item.id === businessSelect.value) || demos[0];
    products = NexoraStore.getProducts(business);
    render();
    loadSettings();
    showToast("Catálogo cambiado a " + business.name + ".");
  });
  $("#new-product-button").addEventListener("click", openCreate);
  $("#product-form-close").addEventListener("click", () => dialog.close());
  $("#cancel-product").addEventListener("click", () => dialog.close());
  productRows.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit]");
    const deleteButton = event.target.closest("[data-delete]");
    if (editButton) openEdit(editButton.dataset.edit);
    if (deleteButton) {
      const selected = products.find((item) => item.id === deleteButton.dataset.delete);
      if (!selected || !window.confirm("¿Eliminar " + selected.name + " de esta demostración?")) return;
      products = products.filter((item) => item.id !== selected.id);
      if (persistProducts()) showToast("Producto eliminado de la demo.");
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#product-id").value || ("demo-" + Date.now().toString(36));
    const attributes = collectDynamicValues();
    const prices = collectProductPrices();
    if (prices === null) {
      showToast("Revisa los importes: cada moneda debe tener un número válido igual o mayor que cero.");
      return;
    }
    const primaryPrice = Object.prototype.hasOwnProperty.call(prices, primaryCurrency())
      ? prices[primaryCurrency()]
      : null;
    const product = {
      id,
      name: $("#product-name").value.trim(),
      category: $("#product-category").value.trim(),
      price: primaryPrice,
      prices,
      published: $("#product-published").checked,
      oldPrice: $("#product-old-price").value ? Number($("#product-old-price").value) : null,
      description: $("#product-description").value.trim(),
      image: photoUploadsEnabled() ? $("#product-image").value.trim() : (products.find((item) => item.id === id)?.image || ""),
      detail: Object.entries(attributes).filter(([,value]) => value !== "" && value !== null && value !== false && !(Array.isArray(value) && !value.length)).map(([key,value]) => {
        const definition = schemaGroups().flatMap((item) => item.fields || []).find((field) => field.id === key);
        return definition?.showPublic ? definition.label + ": " + (Array.isArray(value) ? value.join(", ") : String(value)) : "";
      }).filter(Boolean).join(" · ").slice(0,180),
      attributes,
      tag: "Demo",
      featured: $("#product-featured").checked
    };
    if (!product.name || !product.category || !product.description) {
      showToast("Revisa los campos obligatorios.");
      return;
    }
    if (product.oldPrice !== null && (!Number.isFinite(product.oldPrice) || product.price === null || product.oldPrice <= product.price)) {
      showToast("El precio anterior debe ser mayor que el precio actual.");
      return;
    }
    const existing = products.some((item) => item.id === id);
    products = existing ? products.map((item) => item.id === id ? product : item) : [product, ...products];
    if (persistProducts()) {
      dialog.close();
      showToast(existing ? "Producto actualizado en la demo." : "Producto agregado a la demo.");
    }
  });
  $("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const settings = {
      name: $("#setting-name").value.trim(),
      whatsapp: $("#setting-whatsapp").value.trim(),
      contact: $("#setting-contact").value.trim()
    };
    const digits = settings.whatsapp.replace(/\D/g, "");
    if (settings.name.length < 2 || digits.length < 8 || digits.length > 15) {
      showToast("Revisa el nombre y el número de WhatsApp.");
      return;
    }
    if (!NexoraStore.saveSettings(business.id, settings)) {
      showToast("No fue posible guardar la configuración local.");
      return;
    }
    showToast("Configuración guardada en este navegador.");
  });
  loadSettings();
  render();
})();
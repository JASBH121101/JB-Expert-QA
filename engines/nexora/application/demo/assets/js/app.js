(() => {
  const demos = window.NEXORA_DEMOS || [];
  const readStudioConfig = () => {
    try {
      const value = JSON.parse(localStorage.getItem("nexora-studio:v1") || "null");
      return value && value.schemaVersion === 1 && value.catalog ? value : null;
    } catch { return null; }
  };
  const studioConfig = readStudioConfig();
  const photosEnabled = studioConfig ? Boolean(studioConfig.catalog.photosEnabled) : true;
  const $ = (selector) => document.querySelector(selector);
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
  const businessSelect = $("#business-select");
  const categoryList = $("#category-list");
  const productGrid = $("#product-grid");
  const searchInput = $("#product-search");
  const emptyState = $("#empty-state");
  const toast = $("#toast");
  const dialog = $("#product-dialog");
  const studioMode = Boolean(studioConfig);
  const studioTypeLabels = {
    perfumery: "PERFUMERÍA",
    fashion: "ROPA Y CALZADO",
    technology: "TECNOLOGÍA",
    gym: "GIMNASIO Y FITNESS",
    automotive: "REPUESTOS Y VEHÍCULOS",
    grocery: "ALIMENTOS Y ABARROTES",
    other: "CATÁLOGO PERSONALIZADO"
  };
  const visiblePhones = (studioConfig?.business?.phones || []).filter((phone) => phone.showPublic && /^\d{8,15}$/.test(String(phone.number || "")));
  const primaryPhone = visiblePhones.find((phone) => phone.isMain) || visiblePhones[0];
  const studioBusiness = studioMode ? {
    id: "studio-config",
    name: studioConfig.business.name || "Mi negocio",
    tagline: studioTypeLabels[studioConfig.business.type] || studioTypeLabels.other,
    headline: ["Descubre", "nuestro catálogo."],
    description: studioConfig.identity?.description || "Consulta los productos y comunícate directamente con el negocio.",
    heroImage: studioConfig.identity?.coverUrl || "assets/img/product-placeholder.svg",
    featureLabel: "Catálogo del negocio",
    whatsapp: primaryPhone?.number || "",
    contact: "Consulta directamente con el negocio por WhatsApp.",
    categories: [],
    products: []
  } : null;
  let business = studioBusiness || demos.find((item) => item.id === businessSelect?.value) || demos[0];
  if (studioMode && businessSelect) businessSelect.closest("label")?.setAttribute("hidden", "");
  let settings = business ? NexoraStore.getSettings(business) : {};
  let products = business ? NexoraStore.getProducts(business) : [];
  const primaryCurrency = () => studioConfig?.pricing?.primaryCurrency || "USD";
  const productPrice = (product) => {
    if (product?.prices && Object.prototype.hasOwnProperty.call(product.prices, primaryCurrency())) {
      return product.prices[primaryCurrency()];
    }
    return primaryCurrency() === "USD" ? product?.price : null;
  };
  let activeCategory = "all";
  let searchTerm = "";
  let toastTimer;

  if (!business) return;

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
  };
  const buildWhatsApp = (message) => NexoraStore.whatsappURL(settings.whatsapp, message);
  const setWhatsAppLink = (element, message) => {
    const url = buildWhatsApp(message);
    element.href = url || "#";
    element.setAttribute("aria-disabled", String(!url));
    element.onclick = url ? null : (event) => {
      event.preventDefault();
      showToast("Configura un número de WhatsApp válido en el panel de demostración.");
    };
  };

  const renderCategories = () => {
    const dynamicCategories = products.map((product) => product.category).filter(Boolean);
    const availableCategories = [...new Set([...(business.categories || []), ...dynamicCategories])];
    const labels = ["Todos", ...availableCategories];
    const buttons = labels.map((label, index) => {
      const value = index === 0 ? "all" : label;
      const button = make("button", label);
      button.classList.add("category-chip");
      if (activeCategory === value) button.classList.add("is-active");
      button.type = "button";
      button.dataset.category = value;
      return button;
    });
    categoryList.replaceChildren(...buttons);
  };

  const productCard = (product) => {
    const article = make("article");
    article.classList.add("product-card");
    const imageWrap = make("div");
    imageWrap.classList.add("product-image");
    if (photosEnabled && product.image) {
      const image = make("img");
      image.src = safeImageSource(product.image);
      image.alt = product.name || "Producto del catálogo";
      image.loading = "lazy";
      image.addEventListener("error", () => { image.src = "assets/img/product-placeholder.svg"; }, { once: true });
      imageWrap.append(image);
    } else {
      imageWrap.classList.add("is-no-photo");
      imageWrap.append(make("span", "Sin fotografía"));
    }

    if (product.tag) {
      const tag = make("span", product.tag);
      tag.classList.add("product-tag");
      imageWrap.append(tag);
    }
    const quickButton = make("button", "↗");
    quickButton.classList.add("product-quick");
    quickButton.type = "button";
    quickButton.dataset.productId = product.id;
    quickButton.setAttribute("aria-label", "Ver detalles de " + product.name);
    imageWrap.append(quickButton);

    const info = make("div");
    info.classList.add("product-info");
    const category = make("span", product.category);
    category.classList.add("product-category");
    info.append(category);
    info.append(make("h3", product.name));
    const detail = make("p", product.detail || "Consulta más información");
    detail.classList.add("product-detail");
    info.append(detail);
    const priceRow = make("div");
    priceRow.classList.add("price-row");
    const amount = productPrice(product);
    const price = make("span", amount === null || amount === undefined || amount === "" ? "Consultar precio" : NexoraStore.money(amount, primaryCurrency()));
    price.classList.add("product-price");
    priceRow.append(price);
    if (amount !== null && amount !== undefined && Number(product.oldPrice) > Number(amount)) {
      const oldPrice = make("del", NexoraStore.money(product.oldPrice, primaryCurrency()));
      oldPrice.classList.add("old-price");
      priceRow.append(oldPrice);
    }
    info.append(priceRow);
    article.append(imageWrap, info);
    return article;
  };

  const filteredProducts = () => products.filter((product) => {
    const categoryMatch = activeCategory === "all" || product.category === activeCategory;
    const text = [product.name, product.category, product.description, product.detail].join(" ").toLowerCase();
    return categoryMatch && text.includes(searchTerm);
  });

  const renderProducts = () => {
    const matches = filteredProducts();
    productGrid.replaceChildren(...matches.map(productCard));
    emptyState.hidden = matches.length > 0;
    $("#results-count").textContent = matches.length + (matches.length === 1 ? " producto" : " productos");
    $("#results-currency").textContent = (studioMode ? "Precios en " : "Precios de muestra · ") + primaryCurrency();
  };

  const renderBusiness = () => {
    settings = NexoraStore.getSettings(business);
    products = NexoraStore.getProducts(business).filter((product) => product.published !== false);
    activeCategory = "all";
    searchTerm = "";
    searchInput.value = "";
    $("#business-kicker").textContent = settings.name.toUpperCase() + " · " + business.tagline;
    const headline = $("#hero-title");
    const secondLine = make("span", business.headline[1]);
    headline.replaceChildren(document.createTextNode(business.headline[0]), document.createElement("br"), secondLine);
    $("#hero-description").textContent = studioMode
      ? (studioConfig.identity?.description || business.description)
      : business.description;
    const coverUrl = studioMode ? (studioConfig.identity?.coverUrl || business.heroImage) : business.heroImage;
    $("#hero-image").src = safeImageSource(coverUrl);
    $("#hero-image").alt = "Imagen ilustrativa de " + settings.name;
    $("#hero-feature-label").textContent = business.featureLabel;
    $("#hero-total").textContent = String(products.length).padStart(2, "0");
    $("#business-contact-copy").textContent = settings.contact;
    const primaryColor = studioConfig?.identity?.primaryColor;
    if (studioMode && /^#[0-9a-f]{6}$/i.test(String(primaryColor || ""))) {
      document.documentElement.style.setProperty("--lime", primaryColor);
      document.documentElement.style.setProperty("--lime-dark", primaryColor);
    }
    const logo = studioConfig?.identity?.logoUrl;
    const brandMark = document.querySelector(".site-header .brand-mark");
    if (studioMode && brandMark) {
      if (logo && /^https?:\/\//i.test(logo)) {
        const image = make("img");
        image.src = safeImageSource(logo);
        image.alt = "Logotipo de " + settings.name;
        brandMark.replaceChildren(image);
        brandMark.classList.add("has-logo");
      } else {
        brandMark.textContent = "N";
      }
    }
    renderContactTargets();
    renderCategories();
    renderProducts();
  };

  const renderContactTargets = () => {
    const picker = $("#contact-phone-select");
    const wrapper = $("#contact-phone-switch");
    if (!picker || !wrapper) return;
    if (!studioMode) {
      wrapper.hidden = true;
      return;
    }
    picker.replaceChildren(...visiblePhones.map((phone, index) => {
      const option = make("option", phone.number);
      option.value = phone.number;
      option.selected = phone.number === settings.whatsapp || (!settings.whatsapp && index === 0);
      return option;
    }));
    wrapper.hidden = visiblePhones.length < 2;
    if (visiblePhones.length) settings.whatsapp = picker.value || primaryPhone?.number || "";
    else settings.whatsapp = "";
    setWhatsAppLink($("#header-whatsapp"), "Hola, me gustaría recibir más información de " + settings.name + ".");
    setWhatsAppLink($("#main-whatsapp"), "Hola, me gustaría recibir más información del catálogo de " + settings.name + ".");
  };

  const openProduct = (id) => {
    const product = products.find((item) => item.id === id);
    if (!product) return;
    const image = $("#dialog-image");
    const media = image.closest(".dialog-media");
    media.hidden = !(photosEnabled && product.image);
    if (photosEnabled && product.image) {
      image.src = safeImageSource(product.image);
      image.alt = product.name;
      image.onerror = () => { image.src = "assets/img/product-placeholder.svg"; };
    }
    $("#dialog-category").textContent = product.category;
    $("#dialog-title").textContent = product.name;
    $("#dialog-description").textContent = product.description || "Consulta con el negocio para conocer más detalles.";
    const attributeList = $("#dialog-attributes");
    attributeList.replaceChildren();
    const definitions = (studioConfig?.catalog?.groups || []);
    definitions.forEach((group) => {
      const entries = (group.fields || []).filter((field) => field.showPublic && Object.prototype.hasOwnProperty.call(product.attributes || {}, field.id));
      if (!entries.length) return;
      const block = make("section");
      block.className = "attribute-group";
      block.append(make("h4", group.name));
      entries.forEach((field) => {
        const value = product.attributes[field.id];
        if (value === "" || value === null || value === undefined || value === false || (Array.isArray(value) && !value.length)) return;
        const line = make("div");
        line.className = "attribute-line";
        const label = make("span", field.label);
        const rendered = Array.isArray(value) ? value.join(", ") : String(value);
        const valueNode = make("strong", field.type === "number" && field.unit ? rendered + " " + field.unit : rendered);
        line.append(label, valueNode);
        block.append(line);
      });
      if (block.querySelector(".attribute-line")) attributeList.append(block);
    });
    if (!attributeList.childElementCount && product.detail) {
      const attribute = make("span", product.detail);
      attribute.classList.add("attribute-pill");
      attributeList.append(attribute);
    }

    const price = $("#dialog-price");
    const amount = productPrice(product);
    const priceText = amount === null || amount === undefined || amount === ""
      ? "Consultar precio"
      : NexoraStore.money(amount, primaryCurrency());
    price.replaceChildren(document.createTextNode(priceText));
    if (amount !== null && amount !== undefined && Number(product.oldPrice) > Number(amount)) {
      const oldPrice = make("del", NexoraStore.money(product.oldPrice, primaryCurrency()));
      price.append(oldPrice);
    }
    const inquiry = "Hola, me interesa " + product.name + (amount === null || amount === undefined || amount === "" ? "" : " (" + priceText + ")") + ". ¿Me pueden brindar más información?";
    setWhatsAppLink($("#dialog-whatsapp"), inquiry);
    dialog.showModal();
  };

  if (!studioMode) {
    businessSelect.addEventListener("change", () => {
      business = demos.find((item) => item.id === businessSelect.value) || demos[0];
      renderBusiness();
    });
  }
  $("#contact-phone-select")?.addEventListener("change", (event) => {
    settings.whatsapp = event.target.value;
    setWhatsAppLink($("#header-whatsapp"), "Hola, me gustaría recibir más información de " + settings.name + ".");
    setWhatsAppLink($("#main-whatsapp"), "Hola, me gustaría recibir más información del catálogo de " + settings.name + ".");
  });
  categoryList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    activeCategory = button.dataset.category;
    renderCategories();
    renderProducts();
  });
  productGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-product-id]");
    if (button) openProduct(button.dataset.productId);
  });
  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim().toLocaleLowerCase("es");
    renderProducts();
  });
  $("#clear-filters").addEventListener("click", () => {
    activeCategory = "all";
    searchTerm = "";
    searchInput.value = "";
    renderCategories();
    renderProducts();
  });
  $("#dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      searchInput.focus();
    }
  });
  $("#current-year").textContent = String(new Date().getFullYear());
  $("#hero-image").addEventListener("error", () => {
    $("#hero-image").src = "assets/img/product-placeholder.svg";
  }, { once: true });
  renderBusiness();
})();
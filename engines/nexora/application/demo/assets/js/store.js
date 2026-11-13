(() => {
  const PREFIX = "nexora-demo-v1";
  const safeRead = (key, fallback) => {
    try {
      const raw = localStorage.getItem(PREFIX + ":" + key);
      return raw === null ? structuredClone(fallback) : JSON.parse(raw);
    } catch {
      return structuredClone(fallback);
    }
  };
  const safeWrite = (key, value) => {
    try {
      localStorage.setItem(PREFIX + ":" + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const money = (amount, currency = "USD") => {
    const code = /^[A-Z]{3}$/.test(String(currency || "")) ? currency : "USD";
    try {
      return new Intl.NumberFormat("es-NI", {
        style: "currency", currency: code, maximumFractionDigits: 2
      }).format(Number(amount) || 0);
    } catch {
      return code + " " + (Number(amount) || 0).toFixed(2);
    }
  };
  const digitsOnly = (value) => String(value ?? "").replace(/\D/g, "");
  const whatsappURL = (number, message) => {
    const digits = digitsOnly(number);
    if (digits.length < 8 || digits.length > 15) return "";
    return "https://wa.me/" + digits + "?text=" + encodeURIComponent(message);
  };
  const getProducts = (business) => safeRead("products:" + business.id, business.products);
  const saveProducts = (businessId, products) => safeWrite("products:" + businessId, products);
  const getSettings = (business) => ({
    name: business.name,
    whatsapp: business.whatsapp,
    contact: business.contact
  , ...safeRead("settings:" + business.id, {}) });
  const saveSettings = (businessId, settings) => safeWrite("settings:" + businessId, settings);
  window.NexoraStore = { escapeHTML, money, whatsappURL, getProducts, saveProducts, getSettings, saveSettings };
})();
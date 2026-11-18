export const DEFAULT_CURRENCIES = Object.freeze({
  NIO: Object.freeze({ code: "NIO", name: "Nicaraguan córdoba", minorUnit: 2 }),
  USD: Object.freeze({ code: "USD", name: "United States dollar", minorUnit: 2 }),
  MXN: Object.freeze({ code: "MXN", name: "Mexican peso", minorUnit: 2 }),
  CRC: Object.freeze({ code: "CRC", name: "Costa Rican colón", minorUnit: 2 }),
  HNL: Object.freeze({ code: "HNL", name: "Honduran lempira", minorUnit: 2 }),
  GTQ: Object.freeze({ code: "GTQ", name: "Guatemalan quetzal", minorUnit: 2 }),
  PAB: Object.freeze({ code: "PAB", name: "Panamanian balboa", minorUnit: 2 }),
  COP: Object.freeze({ code: "COP", name: "Colombian peso", minorUnit: 2 }),
  BRL: Object.freeze({ code: "BRL", name: "Brazilian real", minorUnit: 2 }),
  EUR: Object.freeze({ code: "EUR", name: "Euro", minorUnit: 2 }),
  GBP: Object.freeze({ code: "GBP", name: "Pound sterling", minorUnit: 2 }),
  JPY: Object.freeze({ code: "JPY", name: "Japanese yen", minorUnit: 0 }),
  KWD: Object.freeze({ code: "KWD", name: "Kuwaiti dinar", minorUnit: 3 })
});

export function normalizeCurrencyCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function createCurrencyRegistry(customCurrencies = {}) {
  if (customCurrencies === null || typeof customCurrencies !== "object" || Array.isArray(customCurrencies)) {
    throw new TypeError("customCurrencies must be a plain object");
  }
  const currencies = { ...DEFAULT_CURRENCIES };
  for (const [rawCode, metadata] of Object.entries(customCurrencies)) {
    const code = normalizeCurrencyCode(rawCode);
    if (!code || metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
        metadata.code !== code || typeof metadata.name !== "string" || metadata.name.trim() === "" ||
        !Number.isInteger(metadata.minorUnit) || metadata.minorUnit < 0 || metadata.minorUnit > 4) {
      throw new TypeError("currency metadata is invalid for " + rawCode);
    }
    currencies[code] = Object.freeze({ code, name: metadata.name.trim(), minorUnit: metadata.minorUnit });
  }
  return Object.freeze(currencies);
}

export function getCurrency(code, registry = DEFAULT_CURRENCIES) {
  const normalized = normalizeCurrencyCode(code);
  const metadata = normalized ? registry[normalized] : undefined;
  if (!metadata) throw new RangeError("currency code is not registered: " + String(code));
  return metadata;
}

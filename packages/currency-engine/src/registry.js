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
  KWD: Object.freeze({ code: "KWD", name: "Kuwaiti dinar", minorUnit: 3 }),
  AUD: Object.freeze({ code: "AUD", name: "Australian dollar", minorUnit: 2 }),
  CAD: Object.freeze({ code: "CAD", name: "Canadian dollar", minorUnit: 2 }),
  CHF: Object.freeze({ code: "CHF", name: "Swiss franc", minorUnit: 2 }),
  CNY: Object.freeze({ code: "CNY", name: "Chinese yuan", minorUnit: 2 }),
  INR: Object.freeze({ code: "INR", name: "Indian rupee", minorUnit: 2 }),
  AED: Object.freeze({ code: "AED", name: "UAE dirham", minorUnit: 2 }),
  SAR: Object.freeze({ code: "SAR", name: "Saudi riyal", minorUnit: 2 }),
  SGD: Object.freeze({ code: "SGD", name: "Singapore dollar", minorUnit: 2 }),
  SEK: Object.freeze({ code: "SEK", name: "Swedish krona", minorUnit: 2 }),
  NOK: Object.freeze({ code: "NOK", name: "Norwegian krone", minorUnit: 2 }),
  DKK: Object.freeze({ code: "DKK", name: "Danish krone", minorUnit: 2 }),
  NZD: Object.freeze({ code: "NZD", name: "New Zealand dollar", minorUnit: 2 }),
  ZAR: Object.freeze({ code: "ZAR", name: "South African rand", minorUnit: 2 }),
  PLN: Object.freeze({ code: "PLN", name: "Polish złoty", minorUnit: 2 }),
  CZK: Object.freeze({ code: "CZK", name: "Czech koruna", minorUnit: 2 }),
  THB: Object.freeze({ code: "THB", name: "Thai baht", minorUnit: 2 }),
  KRW: Object.freeze({ code: "KRW", name: "South Korean won", minorUnit: 0 }),
  CLP: Object.freeze({ code: "CLP", name: "Chilean peso", minorUnit: 0 }),
  PEN: Object.freeze({ code: "PEN", name: "Peruvian sol", minorUnit: 2 }),
  DOP: Object.freeze({ code: "DOP", name: "Dominican peso", minorUnit: 2 }),
  ARS: Object.freeze({ code: "ARS", name: "Argentine peso", minorUnit: 2 }),
  PHP: Object.freeze({ code: "PHP", name: "Philippine peso", minorUnit: 2 }),
  MYR: Object.freeze({ code: "MYR", name: "Malaysian ringgit", minorUnit: 2 }),
  HKD: Object.freeze({ code: "HKD", name: "Hong Kong dollar", minorUnit: 2 }),
  ISK: Object.freeze({ code: "ISK", name: "Icelandic króna", minorUnit: 0 }),
  EGP: Object.freeze({ code: "EGP", name: "Egyptian pound", minorUnit: 2 }),
  MAD: Object.freeze({ code: "MAD", name: "Moroccan dirham", minorUnit: 2 }),
  NGN: Object.freeze({ code: "NGN", name: "Nigerian naira", minorUnit: 2 }),
  KES: Object.freeze({ code: "KES", name: "Kenyan shilling", minorUnit: 2 }),
  UAH: Object.freeze({ code: "UAH", name: "Ukrainian hryvnia", minorUnit: 2 }),
  CLF: Object.freeze({ code: "CLF", name: "Chilean unidad de fomento", minorUnit: 4 }),
  UYW: Object.freeze({ code: "UYW", name: "Uruguayan unidad previsional", minorUnit: 4 })
});

export function normalizeCurrencyCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createCurrencyRegistry(customCurrencies = {}) {
  if (!isPlainRecord(customCurrencies)) {
    throw new TypeError("customCurrencies must be a plain object");
  }
  const currencies = { ...DEFAULT_CURRENCIES };
  for (const [rawCode, metadata] of Object.entries(customCurrencies)) {
    const code = normalizeCurrencyCode(rawCode);
    if (!code || !isPlainRecord(metadata) ||
        metadata.code !== code || typeof metadata.name !== "string" || metadata.name.trim() === "" ||
        !Number.isInteger(metadata.minorUnit) || metadata.minorUnit < 0 || metadata.minorUnit > 4) {
      throw new TypeError("currency metadata is invalid for " + rawCode);
    }
    currencies[code] = Object.freeze({ code, name: metadata.name.trim(), minorUnit: metadata.minorUnit });
  }
  return Object.freeze(currencies);
}

export function getCurrency(code, registry = DEFAULT_CURRENCIES) {
  if (!isPlainRecord(registry)) throw new TypeError("currency registry must be a plain object");
  const normalized = normalizeCurrencyCode(code);
  const metadata = normalized && Object.hasOwn(registry, normalized) ? registry[normalized] : undefined;
  if (!metadata) throw new RangeError("currency code is not registered: " + String(code));
  if (!isPlainRecord(metadata) || metadata.code !== normalized ||
      typeof metadata.name !== "string" || metadata.name.trim() === "" ||
      !Number.isInteger(metadata.minorUnit) || metadata.minorUnit < 0 || metadata.minorUnit > 4) {
    throw new TypeError("currency registry metadata is invalid for " + normalized);
  }
  return metadata;
}

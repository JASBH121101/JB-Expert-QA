import { DEFAULT_CURRENCIES, getCurrency } from "./registry.js";

const MAX_DECIMAL_LENGTH = 48;

function assertMoney(value, registry = DEFAULT_CURRENCIES) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "currency") || !Object.hasOwn(value, "minorUnits") ||
      typeof value.minorUnits !== "bigint") {
    throw new TypeError("money must be an exact { currency, minorUnits: bigint } value");
  }
  getCurrency(value.currency, registry);
  return value;
}

export function decimalToMinorUnits(amount, currencyCode, registry = DEFAULT_CURRENCIES) {
  if (typeof amount !== "string" || amount.length > MAX_DECIMAL_LENGTH ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) {
    throw new TypeError("amount must be a plain decimal string without grouping or exponent notation");
  }
  const { minorUnit } = getCurrency(currencyCode, registry);
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > minorUnit) {
    throw new RangeError("amount has more fractional digits than the currency minor unit");
  }
  const scale = 10n ** BigInt(minorUnit);
  const fractionValue = minorUnit === 0 ? 0n : BigInt((fraction + "0".repeat(minorUnit)).slice(0, minorUnit) || "0");
  const units = BigInt(whole) * scale + fractionValue;
  return negative && units !== 0n ? -units : units;
}

export function minorUnitsToDecimal(minorUnits, currencyCode, registry = DEFAULT_CURRENCIES) {
  if (typeof minorUnits !== "bigint") throw new TypeError("minorUnits must be bigint");
  const { minorUnit } = getCurrency(currencyCode, registry);
  const negative = minorUnits < 0n;
  const absolute = negative ? -minorUnits : minorUnits;
  const scale = 10n ** BigInt(minorUnit);
  const whole = absolute / scale;
  if (minorUnit === 0) return (negative ? "-" : "") + whole.toString();
  const fraction = (absolute % scale).toString().padStart(minorUnit, "0");
  return (negative ? "-" : "") + whole.toString() + "." + fraction;
}

export function createMoney(amount, currency, registry = DEFAULT_CURRENCIES) {
  const code = getCurrency(currency, registry).code;
  return Object.freeze({ currency: code, minorUnits: decimalToMinorUnits(amount, code, registry) });
}

export function createMoneyFromMinorUnits(minorUnits, currency, registry = DEFAULT_CURRENCIES) {
  const code = getCurrency(currency, registry).code;
  if (typeof minorUnits !== "bigint") throw new TypeError("minorUnits must be bigint");
  return Object.freeze({ currency: code, minorUnits });
}

export function serializeMoney(value, registry = DEFAULT_CURRENCIES) {
  const money = assertMoney(value, registry);
  return Object.freeze({
    schema: "jb.currency.money/v1",
    currency: money.currency,
    minorUnits: money.minorUnits.toString()
  });
}

export function deserializeMoney(value, registry = DEFAULT_CURRENCIES) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 3 || value.schema !== "jb.currency.money/v1" ||
      typeof value.currency !== "string" || typeof value.minorUnits !== "string" ||
      !/^-?(?:0|[1-9]\d*)$/.test(value.minorUnits)) {
    throw new TypeError("serialized money record is invalid");
  }
  return createMoneyFromMinorUnits(BigInt(value.minorUnits), value.currency, registry);
}

function assertSameCurrency(left, right, registry) {
  assertMoney(left, registry);
  assertMoney(right, registry);
  if (left.currency !== right.currency) throw new RangeError("money arithmetic requires matching currencies");
}

export function addMoney(left, right, registry = DEFAULT_CURRENCIES) {
  assertSameCurrency(left, right, registry);
  return createMoneyFromMinorUnits(left.minorUnits + right.minorUnits, left.currency, registry);
}

export function subtractMoney(left, right, registry = DEFAULT_CURRENCIES) {
  assertSameCurrency(left, right, registry);
  return createMoneyFromMinorUnits(left.minorUnits - right.minorUnits, left.currency, registry);
}

export function compareMoney(left, right, registry = DEFAULT_CURRENCIES) {
  assertSameCurrency(left, right, registry);
  return left.minorUnits < right.minorUnits ? -1 : left.minorUnits > right.minorUnits ? 1 : 0;
}

export function multiplyMoneyByInteger(value, multiplier, registry = DEFAULT_CURRENCIES) {
  assertMoney(value, registry);
  if (typeof multiplier !== "bigint") throw new TypeError("multiplier must be bigint");
  return createMoneyFromMinorUnits(value.minorUnits * multiplier, value.currency, registry);
}

export function formatMoney(value, { locale = "es-NI", registry = DEFAULT_CURRENCIES, ...options } = {}) {
  const money = assertMoney(value, registry);
  const metadata = getCurrency(money.currency, registry);
  const exactDecimal = minorUnitsToDecimal(money.minorUnits, money.currency, registry);
  const formatter = new Intl.NumberFormat(locale, {
    ...options,
    style: "currency",
    currency: money.currency,
    minimumFractionDigits: metadata.minorUnit,
    maximumFractionDigits: metadata.minorUnit
  });
  return formatter.format(exactDecimal);
}

export function moneyToDecimalString(value, registry = DEFAULT_CURRENCIES) {
  const money = assertMoney(value, registry);
  return minorUnitsToDecimal(money.minorUnits, money.currency, registry);
}

import { DEFAULT_CURRENCIES, getCurrency } from "./registry.js";
import { createMoneyFromMinorUnits } from "./money.js";

function parsePositiveDecimal(value) {
  if (typeof value !== "string" || value.length > 40 ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) {
    throw new TypeError("FX rate must be a positive plain decimal string with at most 18 fractional digits");
  }
  const [whole, fraction = ""] = value.split(".");
  const numerator = BigInt(whole + fraction);
  if (numerator <= 0n) throw new RangeError("FX rate must be greater than zero");
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

function roundRatio(numerator, denominator, mode) {
  if (denominator <= 0n) throw new RangeError("rounding denominator must be positive");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (mode === "down") return quotient;
  const twice = remainder * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  if (mode === "half-up") return quotient + 1n;
  if (mode === "half-even") return quotient % 2n === 0n ? quotient : quotient + 1n;
  throw new TypeError("rounding must be half-up, half-even, or down");
}

function parseTimestamp(value, label) {
  if (typeof value !== "string") throw new TypeError(label + " must be an ISO timestamp");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw new TypeError(label + " must include an explicit timezone");
  }
  return timestamp;
}

function assertMoney(value, registry) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 || typeof value.currency !== "string" ||
      typeof value.minorUnits !== "bigint") {
    throw new TypeError("money must contain a currency and bigint minorUnits");
  }
  const metadata = getCurrency(value.currency, registry);
  if (value.currency !== metadata.code) {
    throw new TypeError("money currency must use its canonical uppercase ISO code");
  }
  return value;
}

export async function convertMoney(value, targetCurrency, {
  rateProvider,
  registry = DEFAULT_CURRENCIES,
  clock = Date.now,
  maxRateAgeMs = 24 * 60 * 60 * 1000,
  timeoutMs = 5_000,
  rounding = "half-up"
} = {}) {
  const source = assertMoney(value, registry);
  const target = getCurrency(targetCurrency, registry);
  if (typeof clock !== "function" ||
      !Number.isSafeInteger(maxRateAgeMs) || maxRateAgeMs < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
      !["half-up", "half-even", "down"].includes(rounding)) {
    throw new TypeError("FX conversion bounds or rounding mode are invalid");
  }
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("clock must return a non-negative safe integer timestamp");
  if (source.currency === target.code) {
    return Object.freeze({
      money: createMoneyFromMinorUnits(source.minorUnits, target.code, registry),
      rate: null,
      convertedAt: new Date(now).toISOString()
    });
  }
  if (!rateProvider || typeof rateProvider.getRate !== "function") {
    throw new TypeError("an explicit FX rateProvider is required for currency conversion");
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const pending = Promise.resolve().then(() => rateProvider.getRate({
    from: source.currency,
    to: target.code,
    at: new Date(now).toISOString(),
    signal: controller.signal
  }));
  pending.catch(() => {});
  try {
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("FX_RATE_PROVIDER_TIMEOUT"));
      }, timeoutMs);
    });
    const result = await Promise.race([pending, timeout]);
    if (timedOut) throw new Error("FX_RATE_PROVIDER_TIMEOUT");
    if (result === null || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).length !== 6 ||
        !Object.hasOwn(result, "from") || !Object.hasOwn(result, "to") ||
        !Object.hasOwn(result, "rate") || !Object.hasOwn(result, "source") ||
        !Object.hasOwn(result, "asOf") || !Object.hasOwn(result, "validUntil")) {
      throw new TypeError("FX provider response must have exact from/to/rate/source/asOf/validUntil fields");
    }
    if (result.from !== source.currency || result.to !== target.code ||
        typeof result.source !== "string" || result.source.trim() === "" || result.source.length > 256) {
      throw new TypeError("FX provider returned an unexpected currency pair or source");
    }
    const asOf = parseTimestamp(result.asOf, "FX asOf");
    const validUntil = parseTimestamp(result.validUntil, "FX validUntil");
    if (asOf > now || validUntil <= now || now - asOf > maxRateAgeMs || validUntil <= asOf) {
      throw new RangeError("FX rate is future-dated, stale, or expired");
    }
    const { numerator: rateNumerator, denominator: rateDenominator } = parsePositiveDecimal(result.rate);
    const sourceScale = 10n ** BigInt(getCurrency(source.currency, registry).minorUnit);
    const targetScale = 10n ** BigInt(target.minorUnit);
    const absolute = source.minorUnits < 0n ? -source.minorUnits : source.minorUnits;
    const numerator = absolute * rateNumerator * targetScale;
    const denominator = rateDenominator * sourceScale;
    const rounded = roundRatio(numerator, denominator, rounding);
    const convertedUnits = source.minorUnits < 0n ? -rounded : rounded;
    return Object.freeze({
      money: createMoneyFromMinorUnits(convertedUnits, target.code, registry),
      rate: Object.freeze({
        from: source.currency, to: target.code, value: result.rate,
        source: result.source.trim(),
        asOf: new Date(asOf).toISOString(),
        validUntil: new Date(validUntil).toISOString(),
        rounding
      }),
      convertedAt: new Date(now).toISOString()
    });
  } finally {
    clearTimeout(timer);
  }
}

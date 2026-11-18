import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CURRENCIES, createCurrencyRegistry, getCurrency, createMoney, createMoneyFromMinorUnits,
  decimalToMinorUnits, minorUnitsToDecimal, moneyToDecimalString, serializeMoney,
  deserializeMoney, addMoney, subtractMoney, compareMoney, multiplyMoneyByInteger,
  formatMoney, convertMoney
} from "../src/index.js";

const NOW = Date.parse("2026-11-18T14:00:00Z");

test("registry has regional currencies and minor-unit metadata", () => {
  assert.equal(DEFAULT_CURRENCIES.NIO.minorUnit, 2);
  assert.equal(DEFAULT_CURRENCIES.USD.minorUnit, 2);
  assert.equal(DEFAULT_CURRENCIES.JPY.minorUnit, 0);
  assert.equal(DEFAULT_CURRENCIES.KWD.minorUnit, 3);
  assert.equal(DEFAULT_CURRENCIES.CAD.minorUnit, 2);
  assert.equal(DEFAULT_CURRENCIES.CHF.minorUnit, 2);
  assert.equal(DEFAULT_CURRENCIES.INR.minorUnit, 2);
  assert.equal(DEFAULT_CURRENCIES.KRW.minorUnit, 0);
  assert.equal(DEFAULT_CURRENCIES.CLF.minorUnit, 4);
  assert.equal(DEFAULT_CURRENCIES.UYW.minorUnit, 4);
  assert.equal(decimalToMinorUnits("1.2345", "CLF"), 12345n);
  assert.equal(decimalToMinorUnits("1.2345", "UYW"), 12345n);
  assert.equal(decimalToMinorUnits("1500", "KRW"), 1500n);
  const registry = createCurrencyRegistry({ XTS: { code: "XTS", name: "Test currency", minorUnit: 2 } });
  assert.equal(registry.XTS.minorUnit, 2);
  assert.throws(() => createCurrencyRegistry({ BAD: { code: "NO", name: "bad", minorUnit: 2 } }));
});

test("stores decimal values exactly as integer minor units without float arithmetic", () => {
  assert.equal(decimalToMinorUnits("10913.25", "NIO"), 1091325n);
  assert.equal(decimalToMinorUnits("-0.05", "USD"), -5n);
  assert.equal(decimalToMinorUnits("250", "JPY"), 250n);
  assert.equal(decimalToMinorUnits("1.234", "KWD"), 1234n);
  assert.equal(minorUnitsToDecimal(1091325n, "NIO"), "10913.25");
  assert.equal(minorUnitsToDecimal(-5n, "USD"), "-0.05");
  assert.throws(() => decimalToMinorUnits("1.001", "USD"), /fractional digits/);
  assert.throws(() => decimalToMinorUnits("1e3", "USD"), /decimal string/);
});

test("money operations require matching currency and use BigInt", () => {
  const a = createMoney("10.25", "USD");
  const b = createMoney("2.75", "USD");
  assert.equal(moneyToDecimalString(addMoney(a, b)), "13.00");
  assert.equal(moneyToDecimalString(subtractMoney(a, b)), "7.50");
  assert.equal(compareMoney(a, b), 1);
  assert.equal(moneyToDecimalString(multiplyMoneyByInteger(a, 3n)), "30.75");
  assert.throws(() => addMoney(a, createMoney("1.00", "EUR")), /matching currencies/);
});

test("serializes minor units as integer strings for JSON and restores exact value", () => {
  const money = createMoney("-123.45", "EUR");
  const serialized = serializeMoney(money);
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), {
    schema: "jb.currency.money/v1", currency: "EUR", minorUnits: "-12345"
  });
  assert.equal(moneyToDecimalString(deserializeMoney(serialized)), "-123.45");
  assert.throws(() => deserializeMoney({ ...serialized, extra: true }));
});

test("formats exact money by locale without changing stored value", () => {
  const money = createMoney("1234.50", "NIO");
  assert.match(formatMoney(money, { locale: "es-NI" }), /C\$|NIO/);
  assert.match(formatMoney(money, { locale: "en-US" }), /NIO/);
  assert.equal(moneyToDecimalString(money), "1234.50");
  assert.match(formatMoney(createMoney("1500", "JPY"), { locale: "ja-JP" }), /JPY|￥|¥/);
});

test("conversion requires an injected current rate source and records provenance", async () => {
  const provider = { async getRate({ from, to }) {
    assert.equal(from, "USD");
    assert.equal(to, "EUR");
    return { from, to, rate: "0.92", source: "fixture:ECB-reference",
      asOf: "2026-11-18T12:00:00Z", validUntil: "2026-11-19T12:00:00Z" };
  } };
  const result = await convertMoney(createMoney("100.00", "USD"), "EUR", {
    rateProvider: provider, clock: () => NOW, maxRateAgeMs: 24 * 60 * 60 * 1000
  });
  assert.equal(moneyToDecimalString(result.money), "92.00");
  assert.equal(result.rate.value, "0.92");
  assert.equal(result.rate.source, "fixture:ECB-reference");
  assert.equal(result.rate.rounding, "half-up");
});

test("conversion refuses absent, stale, expired, future, malformed and mismatched rates", async () => {
  const money = createMoney("1.00", "USD");
  await assert.rejects(() => convertMoney(money, "EUR", { clock: () => NOW }), /rateProvider/);
  const bad = (overrides = {}) => ({
    async getRate() {
      return { from: "USD", to: "EUR", rate: "0.9", source: "fixture",
        asOf: "2026-11-18T13:00:00Z", validUntil: "2026-11-18T15:00:00Z", ...overrides };
    }
  });
  await assert.rejects(() => convertMoney(money, "EUR", {
    rateProvider: bad(), clock: () => NOW, maxRateAgeMs: 1000
  }), /stale/);
  await assert.rejects(() => convertMoney(money, "EUR", {
    rateProvider: bad({ validUntil: "2026-11-18T13:59:00Z" }), clock: () => NOW
  }), /expired/);
  await assert.rejects(() => convertMoney(money, "EUR", {
    rateProvider: bad({ asOf: "2026-11-18T14:01:00Z" }), clock: () => NOW
  }), /future-dated/);
  await assert.rejects(() => convertMoney(money, "EUR", {
    rateProvider: bad({ from: "GBP" }), clock: () => NOW
  }), /unexpected currency pair/);
  await assert.rejects(() => convertMoney(money, "EUR", {
    rateProvider: bad({ rate: "0" }), clock: () => NOW
  }), /greater than zero/);
});

test("uses explicit half-up, half-even and down rounding", async () => {
  const provider = { async getRate() {
    return { from: "USD", to: "JPY", rate: "1.5", source: "fixture",
      asOf: "2026-11-18T13:59:00Z", validUntil: "2026-11-18T15:00:00Z" };
  } };
  const amount = createMoney("1.00", "USD");
  const halfUp = await convertMoney(amount, "JPY", { rateProvider: provider, clock: () => NOW, rounding: "half-up" });
  const halfEven = await convertMoney(amount, "JPY", { rateProvider: provider, clock: () => NOW, rounding: "half-even" });
  const down = await convertMoney(amount, "JPY", { rateProvider: provider, clock: () => NOW, rounding: "down" });
  assert.equal(halfUp.money.minorUnits, 2n);
  assert.equal(halfEven.money.minorUnits, 2n);
  assert.equal(down.money.minorUnits, 1n);
});

test("rejects unknown currencies and fractional digits beyond registry precision", () => {
  assert.throws(() => createMoney("1.001", "USD"));
  assert.throws(() => createMoneyFromMinorUnits(100n, "XXX"));
});

test("same-currency display conversion preserves exact minor units without an FX provider", async () => {
  const amount = createMoney("90071992547409.91", "NIO");
  const result = await convertMoney(amount, "NIO", { clock: () => NOW });
  assert.equal(result.money.minorUnits, amount.minorUnits);
  assert.equal(result.rate, null);
  assert.equal(moneyToDecimalString(result.money), "90071992547409.91");
});

test("provider timeout aborts the adapter and never returns a converted amount", async () => {
  let aborted = false;
  const provider = {
    getRate({ signal }) {
      return new Promise(() => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      });
    }
  };
  await assert.rejects(() => convertMoney(createMoney("1.00", "USD"), "EUR", {
    rateProvider: provider, clock: () => NOW, timeoutMs: 100
  }), /FX_RATE_PROVIDER_TIMEOUT/);
  assert.equal(aborted, true);
});

test("negative amounts keep their sign after explicit FX rounding", async () => {
  const provider = { async getRate() {
    return { from: "USD", to: "EUR", rate: "0.92", source: "fixture",
      asOf: "2026-11-18T13:59:00Z", validUntil: "2026-11-18T15:00:00Z" };
  } };
  const result = await convertMoney(createMoney("-10.00", "USD"), "EUR", {
    rateProvider: provider, clock: () => NOW
  });
  assert.equal(moneyToDecimalString(result.money), "-9.20");
});


test("currency lookup rejects inherited registry entries and malformed metadata", () => {
  const inherited = Object.create({ USD: DEFAULT_CURRENCIES.USD });
  assert.throws(() => getCurrency("USD", inherited), /plain object/);

  const nullPrototypeRegistry = Object.create(null);
  nullPrototypeRegistry.USD = DEFAULT_CURRENCIES.USD;
  assert.equal(getCurrency("USD", nullPrototypeRegistry).code, "USD");

  assert.throws(() => createCurrencyRegistry(Object.create({ EUR: DEFAULT_CURRENCIES.EUR })), /plain object/);
});


test("money operations reject forged non-canonical currency identifiers", async () => {
  const forged = Object.freeze({ currency: "usd", minorUnits: 100n });
  assert.throws(() => serializeMoney(forged), /canonical uppercase ISO code/);
  assert.throws(() => addMoney(forged, createMoney("1.00", "USD")), /canonical uppercase ISO code/);
  await assert.rejects(() => convertMoney(forged, "EUR", {
    rateProvider: { async getRate() { throw new Error("provider must not be called"); } },
    clock: () => NOW
  }), /canonical uppercase ISO code/);
});

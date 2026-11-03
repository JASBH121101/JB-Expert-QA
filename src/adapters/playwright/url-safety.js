import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const LOCAL_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".test",
  ".invalid",
  ".onion"
];

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function parseIPv6Groups(address) {
  let value = address.toLowerCase().split("%")[0];

  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const ipv4 = value.slice(separator + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    const first = ((octets[0] << 8) | octets[1]).toString(16);
    const second = ((octets[2] << 8) | octets[3]).toString(16);
    value = value.slice(0, separator + 1) + first + ":" + second;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  if (halves.length === 1 && left.length !== 8) return null;
  const zeroCount = 8 - left.length - right.length;
  if (halves.length === 2 && zeroCount < 1) return null;

  const groups = [
    ...left,
    ...(halves.length === 2 ? Array(zeroCount).fill("0") : []),
    ...right
  ].map((part) => Number.parseInt(part, 16));

  return groups.length === 8 && groups.every((part) =>
    Number.isInteger(part) && part >= 0 && part <= 0xffff
  ) ? groups : null;
}

function isPrivateIPv6(address) {
  const groups = parseIPv6Groups(address);
  if (!groups) return true;

  const allZero = groups.every((part) => part === 0);
  const loopback = groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1;
  if (allZero || loopback) return true;

  // IPv4-mapped IPv6 addresses inherit the IPv4 address classification.
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const ipv4 = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff
    ].join(".");
    return isPrivateIPv4(ipv4);
  }

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // Unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // Link-local
  if ((first & 0xff00) === 0xff00) return true; // Multicast

  // Accept only global-unicast space; deny transition and documentation ranges.
  if ((first & 0xe000) !== 0x2000) return true;
  if (first === 0x2001 && (groups[1] <= 0x01ff || groups[1] === 0x0db8)) return true;
  if (first === 0x2002) return true; // 6to4 transition range
  return false;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !isPrivateIPv4(address);
  if (family === 6) return !isPrivateIPv6(address);
  return false;
}

export function createUrlSafetyGuard({
  allowPrivateNetworks = false,
  dnsLookup = lookup
} = {}) {
  if (typeof allowPrivateNetworks !== "boolean") {
    throw new TypeError("allowPrivateNetworks must be a boolean");
  }
  if (typeof dnsLookup !== "function") {
    throw new TypeError("dnsLookup must be a function");
  }

  const verifiedHosts = new Map();

  return async function assertSafeHttpUrl(input) {
    let parsed;
    try {
      parsed = input instanceof URL ? new URL(input.href) : new URL(input);
    } catch {
      throw new TypeError("Target must be a valid absolute URL");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new TypeError("Only http and https URLs are supported");
    }
    if (parsed.username || parsed.password) {
      throw new TypeError("URLs containing embedded credentials are not allowed");
    }

    if (allowPrivateNetworks) return parsed;

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (!hostname) throw new TypeError("Target URL must contain a hostname");
    if (LOCAL_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
      throw new TypeError("Local and reserved hostnames are blocked for remote audits");
    }

    const family = isIP(hostname);
    if (family) {
      if (!isPublicAddress(hostname)) {
        throw new TypeError("Private, loopback, link-local, or reserved IP destinations are blocked");
      }
      return parsed;
    }

    let verification = verifiedHosts.get(hostname);
    if (!verification) {
      verification = (async () => {
        let records;
        try {
          records = await dnsLookup(hostname, { all: true, verbatim: true });
        } catch {
          throw new TypeError("Could not resolve and verify the target hostname");
        }
        if (!Array.isArray(records) || records.length === 0 ||
            records.some((record) => !record || !isPublicAddress(record.address))) {
          throw new TypeError("Target hostname resolves to a private or reserved network address");
        }
      })();
      verifiedHosts.set(hostname, verification);
    }

    try {
      await verification;
    } catch (error) {
      verifiedHosts.delete(hostname);
      throw error;
    }
    return parsed;
  };
}

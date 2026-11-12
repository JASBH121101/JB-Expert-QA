import { DOMAINS } from "../core/domains.js";
import { SOURCE_TYPES } from "../core/evidence.js";
import { assertFetch, createJsonReader, isoNow, requireText } from "./provider-utils.js";

const TECHAPI_BASE = "https://gettechapi.github.io/TechAPI/v1";
const TECHAPI_RESOURCE_TYPES = Object.freeze({
  smartphones: "smartphone",
  tablets: "tablet",
  watches: "smartwatch",
  pdas: "pda",
  laptops: "laptop",
  monitors: "monitor",
  socs: "soc",
  gpus: "gpu",
  cpus: "cpu",
  "device-catalog": "device",
});

const TECHAPI_FIELDS = Object.freeze({
  name: ["name"],
  identity: ["name"],
  manufacturer: ["brand.name", "manufacturer.name", "manufacturer", "brand"],
  manufacturer_country: ["brand.country", "manufacturer.country"],
  release_date: ["release_date"],
  msrp_usd: ["msrp_usd"],
  ram_gb: ["ram_gb", "memory.ram_gb"],
  storage_gb: ["storage_gb", "storage.capacity_gb"],
  storage_options_gb: ["storage_options_gb", "storage.options_gb"],
  chipset: ["soc.name", "processor.name", "chipset", "cpu_name"],
  soc: ["soc.name", "soc"],
  gpu: ["soc.gpu_name", "gpu.name", "gpu_name", "gpu"],
  process_nm: ["soc.process_nm", "process_nm"],
  transistors_billion: ["transistors_billion"],
  cpu_config: ["cpu_config"],
  npu_tops: ["npu_tops"],
  modem: ["modem"],
  gpu_cores: ["gpu_cores"],
  gpu_clock_mhz: ["gpu_clock_mhz"],
  display_size: ["display.size_inch", "size_inch", "display.size_in", "display_size_inch"],
  display_resolution: ["display.resolution", "resolution", "display.resolution_px"],
  aspect_ratio: ["display.aspect_ratio", "aspect_ratio"],
  refresh_rate: ["display.refresh_hz", "refresh_hz", "display.refresh_rate_hz"],
  display_type: ["display.type", "display.technology", "panel_type"],
  panel_type: ["panel_type", "display.panel_type"],
  curvature: ["curvature", "display.curvature"],
  hdr: ["hdr", "display.hdr"],
  rating: ["rating"],
  features: ["features"],
  brightness_nits: ["display.brightness_nits", "display.brightness", "brightness_nits"],
  ppi: ["display.ppi", "ppi"],
  cameras: ["cameras", "camera"],
  main_camera_mp: ["cameras"],
  battery_mah: ["battery_mah", "battery.capacity_mah"],
  battery_wh: ["battery_wh", "battery.capacity_wh"],
  charging_wired_w: ["charging_wired_w", "charging.wired_w"],
  charging_wireless_w: ["charging_wireless_w", "charging.wireless_w"],
  weight_g: ["weight_g", "weight.grams"],
  dimensions: ["dimensions"],
  water_resistance: ["ip_rating", "water_resistance"],
  operating_system: ["os", "operating_system"],
  connectivity: ["connectivity"],
  audio: ["audio"],
  ports: ["ports"],
  memory_type: ["memory_type", "ram_type"],
  storage_type: ["storage_type"],
  cpu_cores: ["cpu.cores", "processor.cores", "cpu_cores", "cores"],
  cpu_threads: ["cpu.threads", "processor.threads", "cpu_threads", "threads"],
  cpu: ["cpu.name", "cpu", "cpu_name", "name"],
  gpu_memory_gb: ["gpu.memory_gb", "gpu_memory_gb", "memory_gb"],
  architecture: ["architecture", "cpu_config.architecture"],
  socket: ["socket"],
  process_node: ["process_node"],
  p_cores: ["p_cores"],
  e_cores: ["e_cores"],
  base_clock_ghz: ["base_clock_ghz"],
  boost_clock_ghz: ["boost_clock_ghz"],
  l3_cache_mb: ["l3_cache_mb"],
  tdp_w: ["tdp_w"],
  max_tdp_w: ["max_tdp_w"],
  integrated_graphics: ["integrated_graphics"],
  memory_support: ["memory_support"],
  memory_gb: ["memory_gb"],
  memory_bus_bit: ["memory_bus_bit"],
  memory_bandwidth_gbps: ["memory_bandwidth_gbps"],
  base_clock_mhz: ["base_clock_mhz"],
  boost_clock_mhz: ["boost_clock_mhz"],
  pcie_version: ["pcie_version"],
  fp32_tflops: ["fp32_tflops"],
  cuda_cores: ["cuda_cores"],
  stream_processors: ["stream_processors"],
  rt_cores: ["rt_cores"],
  tensor_cores: ["tensor_cores"],
  device_category: ["device_category"],
  gpu_type: ["gpu_type"],
  os: ["os"],
  os_version: ["os_version"],
  model_numbers: ["model_numbers"],
  codenames: ["codenames"],
  marketing_names: ["marketing_names"],
  form_factor: ["form_factor"],
  device_type_guess: ["device_type_guess"],
  soc_raw: ["soc_raw"],
  gpu_raw: ["gpu_raw"],
  screen_resolution: ["screen_resolution"],
  screen_density_dpi: ["screen_density_dpi"],
  android_sdk_min: ["android_sdk_min"],
  android_sdk_max: ["android_sdk_max"],
  release_year: ["release_year"],
  release_year_source: ["release_year_source"],
  promoted_to: ["promoted_to"],
});

function readPath(object, path) {
  return path.split(".").reduce((value, key) => value && typeof value === "object" ? value[key] : undefined, object);
}

function pickTechApiValue(record, field, resource) {
  if (field === "soc" && resource === "socs") return record.name;
  if (field === "gpu" && resource === "gpus") return record.name;
  if (field === "cpu" && resource === "cpus") return record.name;
  if (field === "main_camera_mp") {
    if (!Array.isArray(record.cameras)) return undefined;
    const primary = record.cameras.find(camera => ["main", "wide", "primary"].includes(String(camera?.type ?? "").toLowerCase()));
    return typeof primary?.mp === "number" ? primary.mp : undefined;
  }
  const paths = TECHAPI_FIELDS[field];
  if (!paths) throw new Error(`TechAPI provider does not support field: ${field}`);
  for (const path of paths) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * TechAPI is an optional, exact-slug lookup against its public static JSON files.
 * It deliberately does not download the category-wide catalogue indexes.
 *
 * IMPORTANT: dataset license is CC-BY-SA 4.0. Reusers must attribute TechAPI
 * and comply with share-alike requirements for adapted/redistributed data.
 */
export function createTechApiResearchProvider({
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  timeoutMs = 12_000,
  cacheTtlMs = 60 * 60_000,
  minRequestIntervalMs = 150,
} = {}) {
  assertFetch(fetchImpl);
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const readJson = createJsonReader(fetchImpl, {
    timeoutMs, cacheTtlMs, maxCacheEntries: 100, minRequestIntervalMs,
  });

  return Object.freeze({
    id: "techapi-static-specs",
    domains: Object.freeze([DOMAINS.TECHNOLOGY]),
    async search(request) {
      const query = requireText(request.query, "query");
      const field = requireText(request.field, "field");
      const match = query.match(/^([a-z]+(?:-[a-z]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/u);
      if (!match) throw new TypeError("TechAPI query must be an exact resource:slug pair, e.g. smartphones:galaxy-s26-ultra");
      const [, resource, slug] = match;
      if (!Object.hasOwn(TECHAPI_RESOURCE_TYPES, resource)) {
        throw new TypeError(`TechAPI resource is not supported: ${resource}`);
      }
      const valueField = field.trim().toLowerCase();
      const recordUrl = `${TECHAPI_BASE}/${resource}/${encodeURIComponent(slug)}/index.json`;
      const record = await readJson(recordUrl, "TechAPI record");
      if (record.slug !== slug || typeof record.name !== "string" || !record.name.trim()) {
        throw new TypeError("TechAPI detail response does not match the requested record slug");
      }
      const value = pickTechApiValue(record, valueField, resource);
      if (value === undefined || value === null || value === "") return [];

      const refs = Array.isArray(record.source_urls)
        ? record.source_urls.filter(url => typeof url === "string" && /^https?:\/\//u.test(url)).slice(0, 10)
        : [];
      const source = {
        name: "TechAPI",
        url: recordUrl,
        type: SOURCE_TYPES.DATABASE,
        references: refs,
        license: "CC-BY-SA-4.0",
        attribution: "Data from TechAPI",
      };
      return [{
        id: `${resource}:${slug}`,
        value,
        confidence: 0.8,
        source,
        observedAt: isoNow(clock),
        note: `TechAPI record metadata verified=${String(record.verified === true)}; this is the upstream dataset's label, not JBAE verification. Source URLs are retained for review. JBAE status remains unconfirmed. CC-BY-SA 4.0 attribution/share-alike obligations apply to reused data.`,
      }];
    },
  });
}



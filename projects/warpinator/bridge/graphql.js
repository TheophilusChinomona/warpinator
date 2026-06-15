// warpinator bridge — minimal GraphQL responder for model discovery so Warp's
// model picker shows our OpenRouter models. We answer the `freeAvailableModels`
// query (the logged-out / public model-discovery resolver) with a curated list;
// the selected model's `id` flows back as request.settings.model_config.base,
// which inference.js feeds to pi-ai.
//
// The response shape mirrors crates/graphql/src/api/queries/{free_available_models,
// get_feature_model_choices}.rs exactly (cynic camelCases field names; the
// FreeAvailableModelsResult union needs __typename).

// Pinned models always shown first (ids must be pi-ai openrouter ids).
const PINNED = [
  { id: "openrouter/owl-alpha", base: "owl-alpha", name: "Owl Alpha", provider: "UNKNOWN", desc: "OpenRouter cloaked model (warpinator default)" },
  { id: "openrouter/free", base: "free", name: "OpenRouter Free", provider: "UNKNOWN", desc: "OpenRouter's free auto-router (rate-limited)" },
  { id: "openrouter/auto", base: "auto", name: "OpenRouter Auto", provider: "UNKNOWN", desc: "OpenRouter auto-router" },
];

const DEFAULT_ID = "openrouter/owl-alpha";

function providerFromId(id) {
  const org = (id.split("/")[0] || "").toLowerCase();
  if (org.includes("anthropic")) return "ANTHROPIC";
  if (org.includes("openai")) return "OPENAI";
  if (org.includes("google")) return "GOOGLE";
  if (org.includes("x-ai") || org.includes("xai")) return "XAI";
  return "UNKNOWN";
}

// Map OpenRouter /models payload entries to picker choices, pinned first, deduped.
function buildChoicesFromOpenRouter(apiModels) {
  const choices = [...PINNED];
  const seen = new Set(PINNED.map((p) => p.id));
  for (const m of apiModels || []) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    choices.push({
      id: m.id,
      base: m.id.split("/").slice(1).join("/") || m.id,
      name: m.name || m.id,
      provider: providerFromId(m.id),
      desc: (m.description || "").slice(0, 140) || undefined,
    });
  }
  return choices;
}

let activeModels = PINNED;
function setActiveModels(choices) {
  if (Array.isArray(choices) && choices.length) activeModels = choices;
}

function llmInfo(m) {
  return {
    displayName: m.name,
    baseModelName: m.base,
    id: m.id,
    reasoningLevel: null,
    usageMetadata: { creditMultiplier: null, requestMultiplier: 0 },
    description: m.desc || null,
    disableReason: null,
    visionSupported: false,
    spec: null,
    provider: m.provider || "UNKNOWN",
    hostConfigs: [],
    pricing: { discountPercentage: null },
    contextWindow: { isConfigurable: false, min: 0, max: 200000, default: 200000 },
  };
}

function availableLlms() {
  return { defaultId: DEFAULT_ID, choices: activeModels.map(llmInfo), preferredCodexModelId: null };
}

function featureModelChoice() {
  const a = availableLlms();
  return { agentMode: a, planning: a, coding: a, cliAgent: a, computerUseAgent: a };
}

function freeAvailableModelsResponse() {
  return {
    data: {
      freeAvailableModels: {
        __typename: "FreeAvailableModelsOutput",
        featureModelChoice: featureModelChoice(),
        responseContext: { serverVersion: "warpinator-bridge" },
      },
    },
  };
}

// Returns a JSON-serializable response for a GraphQL POST body, or null if we
// don't handle this operation (caller should 404).
function handleGraphql(bodyText) {
  let j;
  try {
    j = JSON.parse(bodyText);
  } catch (_) {
    return null;
  }
  const q = j.query || "";
  if (/freeAvailableModels/.test(q)) {
    return freeAvailableModelsResponse();
  }
  return null;
}

const https = require("https");

// Fetch OpenRouter's model list and install it as the active picker list.
// Best-effort: on any failure the pinned list remains.
function refreshCatalog(apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: "openrouter.ai", path: "/api/v1/models", method: "GET", headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body).data || [];
            const choices = buildChoicesFromOpenRouter(data);
            setActiveModels(choices);
            resolve(choices.length);
          } catch (_) {
            resolve(0);
          }
        });
      }
    );
    req.on("error", () => resolve(0));
    req.setTimeout(8000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

module.exports = { handleGraphql, buildChoicesFromOpenRouter, PINNED, DEFAULT_ID, setActiveModels, refreshCatalog };

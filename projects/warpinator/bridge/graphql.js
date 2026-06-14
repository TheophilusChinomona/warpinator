// warpinator bridge — minimal GraphQL responder for model discovery so Warp's
// model picker shows our OpenRouter models. We answer the `freeAvailableModels`
// query (the logged-out / public model-discovery resolver) with a curated list;
// the selected model's `id` flows back as request.settings.model_config.base,
// which inference.js feeds to pi-ai.
//
// The response shape mirrors crates/graphql/src/api/queries/{free_available_models,
// get_feature_model_choices}.rs exactly (cynic camelCases field names; the
// FreeAvailableModelsResult union needs __typename).

// Curated models. `id` MUST be a model id pi-ai knows for the "openrouter" provider
// (see node_modules/@mariozechner/pi-ai/dist/models.generated.js).
const MODELS = [
  { id: "openrouter/owl-alpha", base: "owl-alpha", name: "Owl Alpha", provider: "UNKNOWN", desc: "OpenRouter cloaked model (warpinator default)" },
  { id: "openrouter/free", base: "free", name: "OpenRouter Free", provider: "UNKNOWN", desc: "OpenRouter's free auto-router (no cost; may be rate-limited)" },
  { id: "openrouter/auto", base: "auto", name: "OpenRouter Auto", provider: "UNKNOWN", desc: "OpenRouter auto-router (picks a model per request)" },
  { id: "anthropic/claude-haiku-4.5", base: "claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "ANTHROPIC", desc: "Fast, low-cost Anthropic" },
  { id: "anthropic/claude-3.5-haiku", base: "claude-3.5-haiku", name: "Claude 3.5 Haiku", provider: "ANTHROPIC", desc: "Cheap, capable" },
  { id: "google/gemini-2.5-flash", base: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "GOOGLE", desc: "Fast Google model" },
  { id: "google/gemini-2.5-pro", base: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "GOOGLE", desc: "High-quality Google model" },
];

const DEFAULT_ID = "openrouter/owl-alpha";

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
  return { defaultId: DEFAULT_ID, choices: MODELS.map(llmInfo), preferredCodexModelId: null };
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

module.exports = { handleGraphql, MODELS, DEFAULT_ID };

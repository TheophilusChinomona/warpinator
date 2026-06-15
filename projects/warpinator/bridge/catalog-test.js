const assert = require("assert");
const { buildChoicesFromOpenRouter, PINNED } = require("./graphql");

const api = [
  { id: "anthropic/claude-3.5-haiku", name: "Anthropic: Claude 3.5 Haiku" },
  { id: "openrouter/owl-alpha", name: "Owl Alpha" }, // duplicate of a pinned id
  { id: "x-ai/grok-2", name: "xAI: Grok 2" },
];
const choices = buildChoicesFromOpenRouter(api);
const ids = choices.map((c) => c.id);

assert.deepStrictEqual(ids.slice(0, PINNED.length), PINNED.map((p) => p.id), "pinned first");
assert.strictEqual(new Set(ids).size, ids.length, "no duplicate ids");
assert.ok(ids.includes("x-ai/grok-2"), "includes fetched model");
for (const c of choices) {
  assert.ok(c.id && c.name && c.base && c.provider, "choice fields present");
}
console.log(`catalog OK ✓ (${choices.length} models)`);

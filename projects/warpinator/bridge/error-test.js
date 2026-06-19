const assert = require("assert");
const { classifyError } = require("./inference");

assert.match(classifyError(new Error("No openrouter API key (request / ~/.pi/agent/auth.json / env)")), /Add your OpenRouter key/i);
assert.match(classifyError(new Error("401 Unauthorized")), /rejected the API key/i);
assert.match(classifyError(new Error("429 Too Many Requests")), /Rate limited/i);
assert.match(classifyError(new Error("model openrouter/nope not found")), /different model/i);
assert.match(classifyError(new Error("socket hang up")), /warpinator bridge error/i);
console.log("classifyError OK ✓");

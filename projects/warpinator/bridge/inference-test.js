// Standalone smoke test: prove pi-ai -> OpenRouter works with the user's key,
// independent of Warp. Simulates a decoded Warp Request with one user query.
const { runInference, PROVIDER, DEFAULT_MODEL } = require("./inference");

const fakeRequest = {
  metadata: { conversation_id: "" },
  task_context: { tasks: [] },
  input: { user_inputs: { inputs: [{ user_query: { query: "In one short sentence, what are you?" } }] } },
};

(async () => {
  console.log(`Testing ${PROVIDER}/${DEFAULT_MODEL}...\n`);
  process.stdout.write("REPLY: ");
  const text = await runInference(fakeRequest, {
    onDelta: (d) => process.stdout.write(d),
    onError: (e) => console.error(`\nERROR: ${e.message}`),
  });
  console.log("\n");
  console.log(text && !text.startsWith("⚠️") ? "INFERENCE OK ✓" : "INFERENCE FAILED ✗");
  process.exit(text && !text.startsWith("⚠️") ? 0 : 1);
})();

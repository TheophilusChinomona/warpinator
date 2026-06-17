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
  let text = "";
  let errored = null;
  await runInference(fakeRequest, {
    onDelta: (d) => { text += d; process.stdout.write(d); },
    onError: (e) => { errored = e; console.error(`\nERROR: ${e.message}`); },
  });
  console.log("\n");
  const ok = !errored && text.length > 0 && !text.startsWith("⚠️");
  console.log(ok ? "INFERENCE OK ✓" : "INFERENCE FAILED ✗");
  process.exit(ok ? 0 : 1);
})();

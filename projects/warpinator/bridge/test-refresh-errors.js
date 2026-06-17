const { refreshCatalog } = require("./graphql");

(async () => {
  console.log("Testing refreshCatalog error handling...");
  
  // Test 1: normal case
  console.log("\n[1] Normal fetch (from live API):");
  const n1 = await refreshCatalog(null);
  console.log(`   Result: ${n1} models loaded (or 0 on failure)`);
  
  // Test 2: verify function returns Promise and never throws
  console.log("\n[2] Function returns a Promise and never throws:");
  try {
    const result = refreshCatalog("invalid-key");
    if (result && typeof result.then === "function") {
      console.log("   ✓ Returns a Promise");
      const val = await result;
      console.log(`   ✓ Promise resolves to: ${val} (type: ${typeof val})`);
    }
  } catch (e) {
    console.log(`   ✗ ERROR: Function threw: ${e.message}`);
    process.exit(1);
  }
  
  console.log("\n=== All error handling tests PASS ===");
})();

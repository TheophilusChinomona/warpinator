// Phase 0 validation: encode the canned hello-world ResponseEvents and prove
// (a) protobufjs round-trips them, and (b) write raw bytes for independent
// protoc --decode validation.
const fs = require("fs");
const path = require("path");
const { loadSchema, helloStream } = require("./proto_loader");

const { ResponseEvent } = loadSchema();
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

const events = helloStream();
let ok = true;

events.forEach((evt, i) => {
  const variant = Object.keys(evt)[0];
  const err = ResponseEvent.verify(evt);
  if (err) {
    ok = false;
    console.error(`[${i}] ${variant}: VERIFY FAILED: ${err}`);
    return;
  }
  const msg = ResponseEvent.fromObject(evt);
  const bytes = ResponseEvent.encode(msg).finish();
  // round-trip decode
  const back = ResponseEvent.toObject(ResponseEvent.decode(bytes), {
    defaults: false,
    oneofs: true,
  });
  const roundtripVariant = back.type || Object.keys(back).find((k) => evt[k]);
  const file = path.join(outDir, `event-${i}-${variant}.bin`);
  fs.writeFileSync(file, bytes);
  console.log(
    `[${i}] ${variant}: encoded ${bytes.length} bytes, decoded oneof=${roundtripVariant} -> ${path.relative(process.cwd(), file)}`
  );
  console.log(`      base64: ${Buffer.from(bytes).toString("base64")}`);
});

console.log(ok ? "\nALL EVENTS VALID ✓" : "\nVALIDATION FAILED ✗");
process.exit(ok ? 0 : 1);

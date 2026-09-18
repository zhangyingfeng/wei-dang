// Entry point for the desktop app. tsx runs this directly in dev (see
// tauri.conf.json's beforeDevCommand); a packaged build compiles it via
// `npm run build` and runs the emitted dist/src/index.js instead — see
// docs/DESIGN.md for what release packaging (a compiled sidecar binary,
// icons, signing) still isn't set up.
import { createServer, listen } from "./server.js";

listen(createServer(), 4417);

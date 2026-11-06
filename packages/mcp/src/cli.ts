#!/usr/bin/env -S npx tsx
import { main } from "./server.js";
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

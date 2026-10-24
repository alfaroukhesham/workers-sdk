---
"wrangler": patch
---

Fix `wrangler dev` exiting on macOS with large assets directories

Large assets directories no longer cause `wrangler dev` to exit unexpectedly on macOS. Asset changes still trigger hot reloads on macOS and Windows.

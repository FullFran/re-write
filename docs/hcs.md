# HCS pin and local checks

RE;write adopts the Harness Composition Specification as described in [ADR-0001](adr/0001-adopt-hcs.md). The contract version is `0.1`, pinned in `hcs.pin.json` to commit `9f40641ebdff9aae73e797b1223b54bcc43a41b7` of `FullFran/hcs`. Private HCS content must not be committed to this repository.

To update the pin, change `hcs.pin.json` (and the supported version constant if the contract version changes), run `npm run hcs:fetch`, and regenerate the traceability matrix with `npm run hcs:trace`. Fetch requires an authenticated `gh` with access to HCS, or `HCS_SOURCE_DIR` pointing to a checkout at the pinned commit. The fetched schemas, requirements and conformance materials live in ignored `.hcs/<commit>/`.

Until HCS is public, CI can run the pin-format test in `npm test` without private access. Fetching, the traceability drift check (`npm run hcs:trace:check`) and the reference runner run locally only. `docs/conformance/traceability.md` is generated from the pinned `requirements.json` and `docs/conformance/traceability.map.json`; edit the map, never the matrix.

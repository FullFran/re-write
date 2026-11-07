"""Reference projection for HCS-0008 (host adapter), used by run.py for `projection` cases.

Input (case `input`):
  generation:       {"id": str, "entries": [{"id": str, "contributions": [contribution, ...]}, ...]}
                    entries in activation order.
  contribution:     {"kind": str, ...}
                    skill:       "name" (the Agent Skills name read from SKILL.md)
                    mcp-server:  "descriptor" (the server.json document at `path`)
                    other kinds: "settings": [{"name": str, "effect": "add"|"replace"|"remove"|"widen"|"narrow"}]
  projectableKinds: kinds the adapter can project into its engine.
  hostOwned:        engine-level names of host-owned settings.
  grantedSecrets:   {entry id: [input name, ...]} secrets the host grants per entry.
  activationPolicy: "all-or-nothing" | "partial" (HCS-0003 step 6).

Output: {"errors": [HCS-0006 errors with entry], "selected": [entry ids the host may report active]}.
`unsupported_contribution` leaves its entry out of `selected` but does not empty it under all-or-nothing
(HCS-0008-R017); every other error is a failure that does.

Engine-level names: a skill projects "skill/<name>", an MCP server "mcp/<server.json name>"; both with
effect "add". Extension kinds state their settings, because their meaning is distribution-defined.
The server.json check covers the members the schema requires and the HCS-0008-R011 secret rule only;
full validation against the MCP Registry schema is the adapter's job (HCS-0008 section 8).
"""

SERVER_REQUIRED = ("name", "description", "version")
OVERRIDING = {"add", "replace"}
FORBIDDEN_ON_HOST_OWNED = {"add", "replace", "remove", "widen"}


def _err(code, entry):
    return {"code": code, "entry": entry}


def _inputs(descriptor):
    """Yield (name, input) for every Input of a server.json document."""
    for package in descriptor.get("packages") or []:
        for key in ("environmentVariables", "runtimeArguments", "packageArguments"):
            for item in package.get(key) or []:
                yield item.get("name") or item.get("valueHint"), item
    for remote in descriptor.get("remotes") or []:
        for item in remote.get("headers") or []:
            yield item.get("name"), item
        for name, item in (remote.get("variables") or {}).items():
            yield name, item


def _check_descriptor(entry, descriptor, granted):
    """HCS-0008-R010 (required members), R011 (no secret values), R012 (secrets come from grants)."""
    if not isinstance(descriptor, dict) or any(not isinstance(descriptor.get(k), str) for k in SERVER_REQUIRED):
        return [_err("manifest_invalid", entry)], None
    for _, item in _inputs(descriptor):
        if item.get("isSecret") and ("value" in item or "default" in item):
            return [_err("manifest_invalid", entry)], None
    for name, item in _inputs(descriptor):
        if item.get("isSecret") and item.get("isRequired") and name not in granted:
            return [_err("permission_denied", entry)], None
    return [], descriptor["name"]


def project(inp):
    projectable = set(inp.get("projectableKinds", []))
    host_owned = set(inp.get("hostOwned", []))
    grants = inp.get("grantedSecrets", {})
    entries = inp["generation"]["entries"]
    errors, failed, unprojected, claims = [], set(), set(), {}

    def fail(code, eid):
        if {"code": code, "entry": eid} not in errors:
            errors.append(_err(code, eid))
        failed.add(eid)

    def report_unsupported(eid):                            # R004; R017: reported, not a failure
        if {"code": "unsupported_contribution", "entry": eid} not in errors:
            errors.append(_err("unsupported_contribution", eid))
        unprojected.add(eid)

    for entry in entries:
        eid = entry["id"]
        for c in entry["contributions"]:
            kind = c["kind"]
            if kind not in projectable:                     # R003, R004
                report_unsupported(eid)
                continue
            if kind == "skill":
                settings = [{"name": "skill/" + c["name"], "effect": "add"}]
            elif kind == "mcp-server":
                errs, name = _check_descriptor(eid, c.get("descriptor"), set(grants.get(eid, [])))
                if errs:
                    for e in errs:
                        fail(e["code"], eid)
                    continue
                settings = [{"name": "mcp/" + name, "effect": "add"}]
            else:
                settings = c.get("settings", [])
            for s in settings:
                if s["name"] in host_owned:
                    if s["effect"] in FORBIDDEN_ON_HOST_OWNED:  # R007; narrowing is allowed
                        fail("permission_denied", eid)
                elif s["effect"] in OVERRIDING:
                    claims.setdefault(s["name"], set()).add(eid)

    for name in sorted(claims):                             # R006: same engine-level name twice
        owners = claims[name]
        if len(owners) > 1:
            for eid in sorted(owners):
                fail("ambiguous_provider", eid)

    ids = [e["id"] for e in entries]
    if inp.get("activationPolicy", "all-or-nothing") == "partial":
        selected = [i for i in ids if i not in failed and i not in unprojected]       # R005
    else:                                                   # R017: only real failures empty the set
        selected = [] if failed else [i for i in ids if i not in unprojected]
    return {"errors": errors, "selected": selected}


def selftest():
    base = {"projectableKinds": ["skill"], "activationPolicy": "partial",
            "generation": {"id": "g1", "entries": [
                {"id": "a", "contributions": [{"kind": "skill", "name": "x"}]},
                {"id": "b", "contributions": [{"kind": "skill", "name": "x"}]},
                {"id": "c", "contributions": [{"kind": "mcp-server", "descriptor": {}}]}]}}
    got = project(base)
    assert got["selected"] == [], got
    assert {(e["code"], e["entry"]) for e in got["errors"]} == {
        ("ambiguous_provider", "a"), ("ambiguous_provider", "b"), ("unsupported_contribution", "c")}, got
    print("selftest: HCS-0008 reference projection passes")

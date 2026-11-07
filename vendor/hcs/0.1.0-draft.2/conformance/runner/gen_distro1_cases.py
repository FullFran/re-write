#!/usr/bin/env python3
"""Generate the HCS-0007 (DISTRO-1) conformance cases with fixture keys.

Usage: python3 conformance/runner/gen_distro1_cases.py [--check]

Fixture private keys are derived from public seeds (sha256 of a label) so the output is reproducible;
they are test keys only and protect nothing. Ed25519 signatures are deterministic, so running this
script twice writes identical files. --check exits 1 when a committed case differs from a fresh
generation. Host-level HCS-0007 cases are written by hand and are not touched.
"""
import base64
import copy
import hashlib
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import distro1  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
CASES = ROOT / "conformance" / "cases" / "HCS-0007"
ENV_T = "urn:hcs:schema:hcs-0007:signed-catalog:0.1#/$defs/envelope"
KS_T = "urn:hcs:schema:hcs-0007:signed-catalog:0.1#/$defs/keySet"
OCI = "application/vnd.oci.image.layer.v1.tar+gzip"
NOW = "2026-11-06T12:00:00Z"
ASSIGNMENT = {"tenant": "t-0001", "profile": "desktop", "channel": "stable"}


def seed(label):
    return hashlib.sha256(("hcs-distro-1 fixture key " + label).encode()).digest()


def b64(data):
    return base64.b64encode(data).decode()


def pub(label):
    return b64(distro1.public_key(seed(label)))


def sign(doc, payload_type, *labels, keyids=None):
    doc = {k: v for k, v in doc.items() if k != "signatures"}
    msg = distro1.signing_input(payload_type, doc)
    keyids = keyids or labels
    doc["signatures"] = [{"keyid": kid, "sig": b64(distro1.sign(seed(lab), msg))} for lab, kid in zip(labels, keyids)]
    return doc


def online(label, nb="2026-01-01T00:00:00Z", na="2027-01-01T00:00:00Z"):
    return {"keyid": label, "keytype": "ed25519", "public": pub(label), "notBefore": nb, "notAfter": na}


ANCHOR = {"keys": [{"keyid": "root-1", "keytype": "ed25519", "public": pub("root-1")}], "threshold": 1}


def key_set(keys=None, version=3, threshold=None, signers=("root-1",)):
    ks = {"hcsVersion": "0.1", "version": version, "keys": keys or [online("online-1")]}
    if threshold is not None:
        ks["threshold"] = threshold
    return sign(ks, distro1.KEY_SET_PAYLOAD_TYPE, *signers)


def catalog(*entries):
    entries = entries or ({"id": "dev.example.notes", "version": "1.4.0", "contentHash": "sha256:" + "4f" * 32,
                           "size": 18342, "mediaType": OCI,
                           "contributions": [{"kind": "skill", "path": "skills/take-notes"}]},)
    return {"hcsVersion": "0.1", "id": "dev.example.desktop", "version": "2026.11.06-1", "entries": list(entries)}


def envelope(sequence=42, expires="2026-11-13T00:00:00Z", binding=None, cat=None, signers=("online-1",), **extra):
    env = {"hcsVersion": "0.1", "sequence": sequence, "expires": expires, "binding": binding or dict(ASSIGNMENT),
           "catalog": cat or catalog()}
    env.update(extra)
    return sign(env, distro1.ENVELOPE_PAYLOAD_TYPE, *signers)


def state(doc, field):
    return {field: doc[field], "digest": distro1.content_digest(doc)}


def verify_input(env, ks=None, last=None, assignment=None, now=NOW):
    inp = {"check": "envelope", "now": now, "trustAnchor": ANCHOR, "keySet": ks or key_set(), "envelope": env,
           "assignment": assignment or dict(ASSIGNMENT)}
    if last is not None:
        inp["lastAccepted"] = last
    return inp


def key_set_input(ks, last=None, now=NOW, anchor=ANCHOR):
    inp = {"check": "key-set", "now": now, "trustAnchor": anchor, "keySet": ks}
    if last is not None:
        inp["lastKeySet"] = last
    return inp


def ok():
    return {"outcome": "valid"}


def bad(code):
    return {"outcome": "invalid", "errors": [{"code": code}]}


def cases():
    out = []

    def add(req, pol, name, description, level, inp, expect, target=None):
        case = {"description": description, "requirements": [req], "level": level}
        if target:
            case["target"] = target
        case.update({"input": inp, "expect": expect})
        out.append((req, pol, name, case))

    env = envelope()
    # R001 envelope shape
    add("HCS-0007-R001", "valid", "full-envelope", "A signed envelope with every member.", "document", env, ok(), ENV_T)
    e = copy.deepcopy(env); del e["sequence"]
    add("HCS-0007-R001", "invalid", "missing-sequence", "No sequence member.", "document", e, bad("manifest_invalid"), ENV_T)
    e = copy.deepcopy(env); e["expires"] = "2026-11-13T00:00:00+01:00"
    add("HCS-0007-R001", "invalid", "expires-with-offset", "expires must be UTC with Z.", "document", e, bad("manifest_invalid"), ENV_T)
    e = copy.deepcopy(env); e["signatures"][0]["sig"] = e["signatures"][0]["sig"][:-4] + "=="
    add("HCS-0007-R001", "invalid", "short-signature", "A signature that is not 64 bytes.", "document", e, bad("manifest_invalid"), ENV_T)
    e = copy.deepcopy(env); e["tenant"] = "t-0001"
    add("HCS-0007-R001", "invalid", "binding-member-at-top-level", "Binding members belong in binding, not at top level.", "document", e, bad("manifest_invalid"), ENV_T)
    e = copy.deepcopy(env); e["hcsVersion"] = "0.2"
    add("HCS-0007-R001", "invalid", "unsupported-hcs-version", "hcsVersion is read before the shape.", "document", e, bad("unsupported_hcs_version"), ENV_T)

    # R002 key set shape
    ks = key_set()
    add("HCS-0007-R002", "valid", "full-key-set", "A root-signed key set with one online key.", "document", ks, ok(), KS_T)
    k = copy.deepcopy(ks); k["keys"][0]["keytype"] = "rsa"
    add("HCS-0007-R002", "invalid", "rsa-key", "Only ed25519 keys.", "document", k, bad("manifest_invalid"), KS_T)
    k = copy.deepcopy(ks); k["keys"].append(dict(k["keys"][0], public=pub("online-2")))
    add("HCS-0007-R002", "invalid", "duplicate-keyid", "Two keys share a keyid.", "document", k, bad("manifest_invalid"), KS_T)
    k = copy.deepcopy(ks); k["keys"] = []
    add("HCS-0007-R002", "invalid", "no-keys", "A key set lists at least one key.", "document", k, bad("manifest_invalid"), KS_T)

    # R003 signature input
    small = {"hcsVersion": "0.1", "sequence": 1, "b": "z", "a": [1, True, None], "signatures": []}
    add("HCS-0007-R003", "valid", "signing-input", "PAE over sorted, whitespace-free JSON without signatures.", "distribution",
        {"check": "signing-input", "payloadType": distro1.ENVELOPE_PAYLOAD_TYPE, "document": small},
        {"signingInput": distro1.signing_input(distro1.ENVELOPE_PAYLOAD_TYPE, small).decode()})
    tricky = {"x-example": {"": 1, "\U0001f600": 2, "é": "\u000f\"\\"}, "sequence": 1}
    add("HCS-0007-R003", "invalid", "utf16-key-order", "Keys sort by UTF-16 code units: U+1F600 before U+E000, the reverse of code point order; control characters escape as \\u00XX.",
        "distribution", {"check": "signing-input", "payloadType": distro1.ENVELOPE_PAYLOAD_TYPE, "document": tricky},
        {"signingInput": distro1.signing_input(distro1.ENVELOPE_PAYLOAD_TYPE, tricky).decode()})
    unsigned = {k: v for k, v in env.items() if k != "signatures"}
    pretty = json.dumps(unsigned, indent=2).encode()
    wrong = dict(unsigned, signatures=[{"keyid": "online-1", "sig": b64(distro1.sign(
        seed("online-1"), distro1.pae(distro1.ENVELOPE_PAYLOAD_TYPE, pretty)))}])
    add("HCS-0007-R003", "invalid", "signed-over-pretty-json", "Signed over indented JSON instead of the canonical form.", "distribution",
        verify_input(wrong), bad("signature_invalid"))
    wrong = dict(unsigned, signatures=[{"keyid": "online-1", "sig": b64(distro1.sign(
        seed("online-1"), distro1.signing_input(distro1.KEY_SET_PAYLOAD_TYPE, unsigned)))}])
    add("HCS-0007-R003", "invalid", "wrong-payload-type", "Signed with the key-set payload type: domain separation rejects it.", "distribution",
        verify_input(wrong), bad("signature_invalid"))

    # R004 number domain
    e = envelope(**{"x-example-limit": 9007199254740991})
    add("HCS-0007-R004", "valid", "max-safe-integer", "The largest safe integer is in the domain.", "document", e, ok(), ENV_T)
    e = copy.deepcopy(env); e["x-example-ratio"] = 0.5
    add("HCS-0007-R004", "invalid", "fraction", "A non-integer number anywhere is rejected.", "document", e, bad("manifest_invalid"), ENV_T)
    e = copy.deepcopy(env); e["catalog"]["x-example-big"] = 9007199254740992
    add("HCS-0007-R004", "invalid", "beyond-safe-range", "2^53 inside the catalog is outside the domain.", "document", e, bad("manifest_invalid"), ENV_T)

    # R005 signatures and threshold
    add("HCS-0007-R005", "valid", "one-of-one", "One valid signature, threshold 1.", "distribution", verify_input(env), ok())
    ks2 = key_set([online("online-1"), online("online-2")], threshold=2)
    add("HCS-0007-R005", "valid", "two-of-two", "Two distinct keys meet threshold 2.", "distribution",
        verify_input(envelope(signers=("online-1", "online-2")), ks2), ok())
    add("HCS-0007-R005", "invalid", "unsigned", "No signatures.", "distribution",
        verify_input({k: v for k, v in env.items() if k != "signatures"}), bad("signature_invalid"))
    e = copy.deepcopy(env); e["sequence"] = 43
    add("HCS-0007-R005", "invalid", "content-changed-after-signing", "sequence edited after signing.", "distribution",
        verify_input(e), bad("signature_invalid"))
    add("HCS-0007-R005", "invalid", "unknown-key", "Signed by a key outside the key set.", "distribution",
        verify_input(envelope(signers=("online-2",))), bad("signature_invalid"))
    add("HCS-0007-R005", "invalid", "root-key-signs-catalog", "The root key signs key sets, not catalogs.", "distribution",
        verify_input(envelope(signers=("root-1",))), bad("signature_invalid"))
    twin = key_set([online("online-1"), dict(online("online-1"), keyid="online-1-alias")], threshold=2)
    add("HCS-0007-R005", "invalid", "same-key-twice", "One key listed under two keyids counts once; threshold 2 is not met.", "distribution",
        verify_input(sign(env, distro1.ENVELOPE_PAYLOAD_TYPE, "online-1", "online-1",
                          keyids=("online-1", "online-1-alias")), twin), bad("signature_invalid"))

    # R006 binding
    add("HCS-0007-R006", "valid", "binding-matches", "Binding equals the host assignment.", "distribution", verify_input(env), ok())
    add("HCS-0007-R006", "invalid", "other-channel", "Signed for channel beta; the host is assigned stable.", "distribution",
        verify_input(envelope(binding=dict(ASSIGNMENT, channel="beta"))), bad("permission_denied"))
    add("HCS-0007-R006", "invalid", "missing-member", "A binding without tenant does not match a host assigned to a tenant.", "distribution",
        verify_input(envelope(binding={"profile": "desktop", "channel": "stable"})), bad("permission_denied"))

    # R007 expiry
    add("HCS-0007-R007", "valid", "one-second-left", "One second before expiry.", "distribution",
        verify_input(envelope(expires="2026-11-06T12:00:01Z")), ok())
    add("HCS-0007-R007", "invalid", "expires-now", "expires equal to the current time is expired.", "distribution",
        verify_input(envelope(expires=NOW)), bad("signature_invalid"))
    add("HCS-0007-R007", "invalid", "frozen-catalog", "A validly signed catalog that expired a week ago (freeze attack).", "distribution",
        verify_input(envelope(expires="2026-10-30T00:00:00Z")), bad("signature_invalid"))

    # R008 sequence
    add("HCS-0007-R008", "valid", "newer", "sequence 42 after 41.", "distribution",
        verify_input(env, last={"sequence": 41, "digest": "sha256:" + "00" * 32}), ok())
    add("HCS-0007-R008", "valid", "same-content-again", "The same envelope fetched again is accepted.", "distribution",
        verify_input(env, last=state(env, "sequence")), ok())
    add("HCS-0007-R008", "invalid", "older", "sequence 42 after 43 (rollback).", "distribution",
        verify_input(env, last={"sequence": 43, "digest": "sha256:" + "00" * 32}), bad("rollback_rejected"))
    other = envelope(cat=catalog({"id": "dev.example.other", "version": "1", "contentHash": "sha256:" + "11" * 32, "size": 1,
                                  "mediaType": OCI, "contributions": [{"kind": "skill", "path": "s"}]}))
    add("HCS-0007-R008", "invalid", "reused-sequence", "sequence 42 again with a different catalog.", "distribution",
        verify_input(other, last=state(env, "sequence")), bad("rollback_rejected"))

    # R009 order
    add("HCS-0007-R009", "valid", "binding-before-expiry", "Wrong channel and expired: binding is checked first.", "distribution",
        verify_input(envelope(binding=dict(ASSIGNMENT, channel="beta"), expires="2026-10-30T00:00:00Z")), bad("permission_denied"))
    e = copy.deepcopy(env); e["sequence"] = 40
    add("HCS-0007-R009", "invalid", "signature-before-sequence", "Bad signature and an old sequence: only signature_invalid is reported.", "distribution",
        verify_input(e, last={"sequence": 41, "digest": "sha256:" + "00" * 32}), bad("signature_invalid"))

    # R010 catalog validated after the envelope
    add("HCS-0007-R010", "valid", "catalog-valid", "Envelope and catalog both valid.", "distribution", verify_input(env), ok())
    entry = catalog()["entries"][0]
    add("HCS-0007-R010", "invalid", "signed-duplicate-entry", "A correctly signed catalog with a repeated entry id still fails HCS-0001.", "distribution",
        verify_input(envelope(cat=catalog(entry, entry))), {"outcome": "invalid", "errors": [{"code": "duplicate_entry", "entry": entry["id"]}]})
    e2 = copy.deepcopy(entry); del e2["mediaType"]
    add("HCS-0007-R010", "invalid", "signed-invalid-catalog", "A correctly signed catalog without mediaType fails HCS-0001.", "distribution",
        verify_input(envelope(cat=catalog(e2))), bad("manifest_invalid"))

    # R011 key set root signatures
    add("HCS-0007-R011", "valid", "root-signed", "Key set signed by the enrolled root key.", "distribution", key_set_input(ks), ok())
    add("HCS-0007-R011", "invalid", "online-key-signs-key-set", "An online key cannot sign a key set.", "distribution",
        key_set_input(key_set(signers=("online-1",))), bad("signature_invalid"))
    anchor2 = {"keys": ANCHOR["keys"] + [{"keyid": "root-2", "keytype": "ed25519", "public": pub("root-2")}], "threshold": 2}
    add("HCS-0007-R011", "invalid", "root-threshold-not-met", "Trust anchor threshold 2, one root signature.", "distribution",
        key_set_input(ks, anchor=anchor2), bad("signature_invalid"))

    # R012 key set version
    add("HCS-0007-R012", "valid", "rotation", "Version 4 replaces version 3.", "distribution",
        key_set_input(key_set([online("online-2")], version=4), last=state(ks, "version")), ok())
    add("HCS-0007-R012", "invalid", "older-key-set", "Version 2 after version 3.", "distribution",
        key_set_input(key_set(version=2), last=state(ks, "version")), bad("rollback_rejected"))
    add("HCS-0007-R012", "invalid", "same-version-new-keys", "Version 3 again with other keys.", "distribution",
        key_set_input(key_set([online("online-2")], version=3), last=state(ks, "version")), bad("rollback_rejected"))

    # R013 no currently valid key
    add("HCS-0007-R013", "valid", "one-key-valid", "One expired key and one valid key.", "distribution",
        key_set_input(key_set([online("online-old", "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), online("online-1")])), ok())
    add("HCS-0007-R013", "invalid", "all-keys-expired", "Every online key has expired.", "distribution",
        key_set_input(key_set([online("online-old", "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z")])), bad("signature_invalid"))

    # R014 key validity window
    future = key_set([online("online-1"), online("online-2", nb=NOW)])
    add("HCS-0007-R014", "valid", "not-before-inclusive", "A key whose notBefore equals now already signs.", "distribution",
        verify_input(envelope(signers=("online-2",)), future), ok())
    edge = key_set([online("online-1"), online("online-2", nb="2026-01-01T00:00:00Z", na=NOW)])
    add("HCS-0007-R014", "invalid", "not-after-exclusive", "A key whose notAfter equals now no longer signs.", "distribution",
        verify_input(envelope(signers=("online-2",)), edge), bad("signature_invalid"))
    early = key_set([online("online-1"), online("online-2", nb="2026-12-01T00:00:00Z")])
    add("HCS-0007-R014", "invalid", "not-yet-valid", "A key that becomes valid next month does not sign today.", "distribution",
        verify_input(envelope(signers=("online-2",)), early), bad("signature_invalid"))
    return out


def render(case):
    return json.dumps(case, indent=2, ensure_ascii=False) + "\n"


def main():
    drift = []
    for req, pol, name, case in cases():
        path = CASES / req / pol / f"{name}.json"
        text = render(case)
        if "--check" in sys.argv:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                drift.append(str(path.relative_to(ROOT)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    if "--check" in sys.argv:
        if drift:
            sys.exit("HCS-0007 cases differ from a fresh generation:\n  " + "\n  ".join(drift))
        print("HCS-0007 generated cases up to date")
    else:
        print(f"wrote {len(cases())} HCS-0007 cases")


if __name__ == "__main__":
    main()

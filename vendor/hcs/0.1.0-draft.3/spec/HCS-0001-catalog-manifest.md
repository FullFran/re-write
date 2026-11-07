# HCS-0001 Catalog manifest

| Field | Value |
| --- | --- |
| Status | Draft |
| Version | 0.1.0-draft |
| Requires | HCS-0000, HCS-0002 (capability references), HCS-0006 (error codes) |
| Replaces | none |
| Schema | `schemas/hcs-0001/catalog-manifest/v0.1/catalog-manifest.schema.json` (`urn:hcs:schema:hcs-0001:catalog-manifest:0.1`) |

## 1. Scope

A catalog manifest is the desired state of a harness distribution: which packages a host should have, at which versions, with which content digests and sizes, what each package contributes, and where it can run. It is data only. A host reads it, checks it, fetches and verifies content, and hands the result to resolution (HCS-0003) and lifecycle (HCS-0004).

No existing standard covers this: OCI indexes describe transport, TUF targets metadata describes hashes and lengths without contributions, and product manifests such as `openclaw.plugin.json` are product-specific (see [composition-map.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/research/composition-map.md) section 3).

Out of scope here: signing, freshness and rollback protection of the manifest (DISTRO-1, built on TUF properties, see [docs/standards/tuf.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/standards/tuf.md)); how a contribution is launched (TOOLS-1 for `mcp-server`); permission requests (HCS-0005).

## 2. Example

```json
{
  "hcsVersion": "0.1",
  "id": "dev.example.desktop",
  "version": "2026.11.06-1",
  "entries": [
    {
      "id": "dev.example.notes",
      "version": "1.4.0",
      "contentHash": "sha256:4f1c3b0a8e9d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b",
      "size": 18342,
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "contributions": [
        { "kind": "skill", "path": "skills/take-notes", "provides": ["dev.example.notes.capture@1"] }
      ],
      "requires": ["dev.example.search@1"],
      "compatibility": { "platforms": [{ "os": "linux", "architecture": "amd64" }] },
      "x-example-channel": "stable"
    }
  ]
}
```

## 3. Document

| Member | Required | Type | Meaning |
| --- | --- | --- | --- |
| `hcsVersion` | yes | `"0.1"` | HCS contract of this document (HCS-0000 section 5) |
| `id` | yes | dotted id | identifies the catalog (the distribution channel), not a package |
| `version` | yes | opaque string | catalog revision; compared for equality only |
| `entries` | yes | array of entry | desired packages; may be empty |
| `x-*` | no | any | extension members (HCS-0000 section 7) |

### 3.1 Entry

| Member | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | dotted id | package id, unique in the catalog |
| `version` | yes | opaque string | package version ([ADR-0004](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/adr/0004-opaque-package-versions.md)) |
| `contentHash` | yes | digest | digest of the exact package bytes ([ADR-0003](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/adr/0003-digest-format.md)) |
| `size` | yes | integer ≥ 0 | length of the package bytes, in bytes |
| `mediaType` | yes | string | media type of the package bytes, as in an OCI descriptor (3.4) |
| `locations` | no | array of URI | where the bytes can be fetched; hints only, integrity comes from `contentHash` and `size` |
| `contributions` | yes | array of contribution, ≥ 1 | what the package adds to the host |
| `requires` | no | array of capability ref | capabilities the package needs (HCS-0002, HCS-0003) |
| `compatibility` | no | object | where the package can run: platforms and hosts (3.3) |
| `x-*` | no | any | extension members |

`contentHash` plus `size` mirror the `digest` plus `size` pair of an OCI descriptor and the `hashes` plus `length` pair of a TUF targets entry (see [docs/standards/oci.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/standards/oci.md)). HCS uses the OCI digest string grammar and restricts the algorithm to `sha256` and `sha512` with lowercase hex.

### 3.2 Contribution

| Member | Required | Type | Meaning |
| --- | --- | --- | --- |
| `kind` | yes | `skill`, `mcp-server` or an extension name | what the contribution is |
| `path` | yes | relative POSIX path | location inside the unpacked package |
| `provides` | no | array of capability ref | capabilities this contribution implements |
| `x-*` | no | any | extension members |

Core kinds reference external standards and do not restate them:

- `skill`: `path` names a directory that is an Agent Skill (a `SKILL.md` with frontmatter), as defined by the Agent Skills specification at the revision pinned in [docs/standards/agent-skills.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/standards/agent-skills.md). Its `allowed-tools` field is a request, never a grant (HCS-0005).
- `mcp-server`: `path` names an MCP server shipped in the package. How it is launched and which MCP revision it speaks are defined by the TOOLS-1 profile, not by HCS-0001 ([docs/standards/mcp.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/standards/mcp.md)).
- A distribution adds kinds as extension names (for example `x-example-theme`).

### 3.3 Compatibility

`compatibility.platforms` is a list of OCI platform objects (`os`, `architecture`, optional `variant`), using the OCI image index values (see [docs/standards/oci.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/standards/oci.md)). An absent list means "any platform". Packages that ship different bytes per platform are separate entries with distinct ids or a distinct catalog per platform; HCS 0.1 does not define multi-platform entries (OQ-0001-2).

`compatibility.hosts` is a list of items with a host `id` (dotted id, naming a host implementation, not an instance) and `versions`, the exact host versions the entry runs on ([ADR-0012](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/adr/0012-host-compatibility-by-exact-versions.md)). Host versions are opaque like package versions ([ADR-0004](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/adr/0004-opaque-package-versions.md)), so HCS defines no ranges: an item matches only when its `id` equals the host's id and `versions` contains the host's version as an equal string. An absent list means "any host".

### 3.4 Package format

`mediaType` tells the host how to turn the package bytes into a directory tree; contribution `path` values are relative to the root of that tree ([ADR-0011](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/adr/0011-package-format-is-an-oci-layer.md)).

- The core format is `application/vnd.oci.image.layer.v1.tar+gzip`: a tar archive compressed with gzip, as defined for OCI image layers in image-spec v1.1.1 `layer.md` ([docs/standards/oci.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/standards/oci.md)). The archive is applied to an empty directory, which becomes the package root. Every host implements it (R012), so a catalog that uses only this type can be consumed by any conforming host.
- A distribution can define further media types in a vendor tree (for example `application/vnd.example.package.v1.tar+gzip`); a host that does not implement one reports `unsupported_contribution` for the entry (R013) and leaves the rest of the catalog to resolution.
- A deterministic archive (R014) lists members in byte order of their names, stores zero modification times, owner and group ids and names, and is compressed with fixed settings and no gzip file name or timestamp. Determinism is a producer property; a host cannot check it and does not try.
- `size` and `contentHash` describe the compressed bytes exactly as fetched (R007), never the unpacked tree.

Document limits (R015) protect a host from a hostile document that exhausts memory or the parser stack before validation can reject it. The floor values let a producer know what every host accepts; a host can accept more.

## 4. Requirements

### 4.1 Document requirements

**[HCS-0001-R001]** A catalog manifest MUST validate against the HCS-0001 catalog manifest schema for the `hcsVersion` it declares.

**[HCS-0001-R002]** A host MUST read `hcsVersion` before any other validation and MUST report `unsupported_hcs_version`, not `manifest_invalid`, when it does not implement that contract.

**[HCS-0001-R003]** Entry `id` values MUST be unique within a catalog manifest; a host MUST report `duplicate_entry` for every repeated id.

**[HCS-0001-R004]** `contentHash` MUST be `sha256:` followed by 64 lowercase hex digits or `sha512:` followed by 128 lowercase hex digits.

**[HCS-0001-R005]** A contribution `path` MUST be relative, use `/` as separator, and MUST NOT contain a `..` segment.

**[HCS-0001-R006]** A contribution `kind` MUST be `skill`, `mcp-server` or an extension name.

**[HCS-0001-R011]** Every entry MUST declare `mediaType`.

### 4.2 Host requirements

**[HCS-0001-R007]** A host MUST verify that fetched package bytes have exactly `size` bytes and match `contentHash` before unpacking or executing any of them, and MUST report `integrity_mismatch` otherwise.

**[HCS-0001-R008]** A host MUST NOT activate an entry that has a contribution whose `kind` it does not implement, and MUST report `unsupported_contribution` for that entry.

**[HCS-0001-R009]** When `compatibility.platforms` is present, a host MUST NOT activate the entry unless one item matches the host platform, and MUST report `platform_incompatible` otherwise.

A platform item matches when `os` and `architecture` are equal to the host's and, if the item has `variant`, the host's variant is equal too.

**[HCS-0001-R010]** A host MUST validate a catalog manifest without executing code from any package.

**[HCS-0001-R016]** When `compatibility.hosts` is present, a host MUST NOT activate the entry unless one item names the host's id and lists the host's version exactly, and MUST report `version_incompatible` otherwise.

**[HCS-0001-R012]** A host MUST be able to unpack packages of media type `application/vnd.oci.image.layer.v1.tar+gzip` as described in section 3.4.

**[HCS-0001-R013]** A host MUST NOT activate an entry whose `mediaType` it does not implement, and MUST report `unsupported_contribution` for that entry.

**[HCS-0001-R014]** A producer SHOULD build package archives deterministically, so that `contentHash` changes only when the packaged content changes.

**[HCS-0001-R015]** A host SHOULD reject a document that exceeds its declared maximum size or maximum nesting depth with `manifest_invalid` before schema validation, and SHOULD declare limits of at least 4 MiB (4 194 304 bytes) and 64 levels.

## 5. Open questions

- OQ-0001-1: closed. `mediaType` is required and the core package format is the OCI layer media type (section 3.4, [ADR-0011](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/adr/0011-package-format-is-an-oci-layer.md)).
- OQ-0001-2: multi-platform entries (one id, per-platform digests, like an OCI image index).
- OQ-0001-3: reduced. `compatibility.hosts` with exact version lists is defined (section 3.3, R016). Remaining question: version ranges, which need a version ordering HCS does not define (ADR-0004).
- OQ-0001-4: closed here. The catalog `version` stays opaque; rollback protection is the envelope `sequence` of [HCS-0007](HCS-0007-signed-catalog.md).
- OQ-0001-5: closed here. The signature input over a catalog is defined by [HCS-0007](HCS-0007-signed-catalog.md) section 4.
- OQ-0001-6: archive member safety (absolute names, `..` segments, links, device files, OCI whiteout entries) when unpacking section 3.4 packages. A host needs a rule; which members HCS forbids and which error a violation reports is open.
- Mandatory entries (an entry that distribution policy forbids removing) stay a distribution extension; HCS-0000-R004 keeps such a member from changing any validity verdict ([lf-fit-distro-1-and-core-0.md](https://github.com/FullFran/hcs/blob/v0.1.0-draft.3/docs/research/lf-fit-distro-1-and-core-0.md) row 6).

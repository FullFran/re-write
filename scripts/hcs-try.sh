#!/usr/bin/env bash
# Walk the HCS host core end to end with the two fixture packages. Runs no package code.
# Usage: npm run hcs:try   (or: bash scripts/hcs-try.sh [work-dir])
set -u
cd "$(dirname "$0")/.."
work=${1:-$(mktemp -d)}
rw() { node src/cli/main.ts "$@"; }
step() { printf '\n== %s\n' "$*"; }

step "1. Build both packages twice: same digest each time"
for p in fixture-annotations knowledge-order; do
  rw package "fixtures/packages/$p" --out "$work/$p.tar.gz" --json > "$work/$p.json"
  rw package "fixtures/packages/$p" --out "$work/$p.again.tar.gz"
  cmp -s "$work/$p.tar.gz" "$work/$p.again.tar.gz" && echo "$p: identical bytes"
  # The host reads packages from its content-addressed store: <store>/<algorithm>/<digest>.
  hash=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).contentHash)' "$work/$p.json")
  mkdir -p "$work/store/${hash%%:*}" && cp "$work/$p.tar.gz" "$work/store/${hash%%:*}/${hash#*:}"
done

catalog() { # catalog <out> <knowledge-order provides> <annotations hash override>
  node -e '
    const fs = require("fs");
    const [work, out, provides, hash] = process.argv.slice(1);
    const pkg = (name) => JSON.parse(fs.readFileSync(`${work}/${name}.json`, "utf8"));
    const entry = (name, kind, prov) => {
      const p = pkg(name);
      return { id: `com.fullfran.rewrite.${name}`, version: "0.1.0", contentHash: p.contentHash, size: p.size,
        mediaType: p.mediaType,
        contributions: [{ kind, path: "index.mjs", ...(prov ? { provides: [prov] } : {}) }] };
    };
    const a = entry("fixture-annotations", "x-rewrite-extractor", "com.fullfran.rewrite.claims.extract@1");
    if (hash) a.contentHash = hash;
    const k = entry("knowledge-order", "x-rewrite-check", provides);
    fs.writeFileSync(out, JSON.stringify({ hcsVersion: "0.1", id: "com.fullfran.rewrite.demo", version: "1", entries: [a, k] }, null, 2));
  ' "$work" "$1" "$2" "$3"
}
catalog "$work/catalog.json" "" ""

step "2. Validate the catalog (HCS-0001)"
rw catalog validate "$work/catalog.json"

step "3. Apply without grants: denied, nothing becomes active (HCS-0005-R001)"
rw catalog apply "$work/catalog.json" --state "$work/state" --store "$work/store" --grants "$work/data"; echo "exit $?"

step "4. Grant what each package requests in its requests.json, then apply"
rw package-grant "$work/data" com.fullfran.rewrite.fixture-annotations com.fullfran.rewrite.book.read
rw package-grant "$work/data" com.fullfran.rewrite.fixture-annotations com.fullfran.rewrite.claims.propose
rw package-grant "$work/data" com.fullfran.rewrite.knowledge-order com.fullfran.rewrite.book.read
rw package-grant "$work/data" com.fullfran.rewrite.knowledge-order com.fullfran.rewrite.findings.propose
rw catalog apply "$work/catalog.json" --state "$work/state" --store "$work/store" --grants "$work/data"; echo "exit $?"

step "5. A catalog with a wrong digest: integrity_mismatch, the previous generation stays active (HCS-0001-R007, HCS-0004-R003)"
catalog "$work/bad.json" "" "sha256:$(printf '0%.0s' $(seq 64))"
rw catalog apply "$work/bad.json" --state "$work/state" --store "$work/store" --grants "$work/data"; echo "exit $?"
rw catalog status --state "$work/state"

step "6. A package that also provides continuity.check@1, a host built-in: ambiguous_provider (HCS-0003-R004)"
catalog "$work/ambiguous.json" "com.fullfran.rewrite.continuity.check@1" ""
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1]));c.entries.push({id:"com.fullfran.rewrite.needs-continuity",version:"1",contentHash:c.entries[1].contentHash,size:c.entries[1].size,mediaType:c.entries[1].mediaType,contributions:[{kind:"x-rewrite-check",path:"index.mjs"}],requires:["com.fullfran.rewrite.continuity.check@1"]});fs.writeFileSync(process.argv[1],JSON.stringify(c,null,2))' "$work/ambiguous.json"
rw catalog apply "$work/ambiguous.json" --state "$work/state" --store "$work/store" --grants "$work/data"; echo "exit $?"

printf '\nWork directory: %s\n' "$work"

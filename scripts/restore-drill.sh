#!/usr/bin/env bash
# Restore drill, run on the server: restores one encrypted backup from R2 into an isolated
# volume and container, checks the restored state, then removes everything it created.
# Production (its container and volume) is never touched; the drill container publishes no port.
# Prints counts and verdicts only, never manuscript text.
#
# Usage: restore-drill.sh [object-name]   (default: the newest backup in the bucket)
# Settings: the same env file as backup-r2.sh (REWRITE_BACKUP_ENV, default ~/.config/rewrite-backup/r2.env).
# Image: REWRITE_IMAGE (default rewrite-rewrite:latest, the image production runs).
set -euo pipefail

ENV_FILE="${REWRITE_BACKUP_ENV:-$HOME/.config/rewrite-backup/r2.env}"
IMAGE="${REWRITE_IMAGE:-rewrite-rewrite:latest}"
export PATH="/usr/local/bin:/usr/bin:/bin"
export LC_ALL=C

setting() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
endpoint="$(setting R2_ENDPOINT)"
bucket="$(setting R2_BUCKET)"
key_id="$(setting R2_ACCESS_KEY_ID)"
secret="$(setting R2_SECRET_ACCESS_KEY)"
passphrase="$(setting BACKUP_PASSPHRASE)"
for value in "$endpoint" "$bucket" "$key_id" "$secret" "$passphrase"; do
  if [ -z "$value" ]; then
    echo "drill failed: a setting is missing in $ENV_FILE" >&2
    exit 1
  fi
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
volume="rewrite-restore-drill-$stamp"
container="rewrite-restore-drill-$stamp"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Credentials go through stdin, so they never appear in the process list.
r2() { printf 'user = "%s:%s"\n' "$key_id" "$secret" | curl -fsS --max-time 300 --aws-sigv4 aws:amz:auto:s3 -K - "$@"; }

name="${1:-}"
if [ -z "$name" ]; then
  r2 -o "$work/list.xml" "${endpoint%/}/$bucket?list-type=2&prefix=rewrite-"
  name="$(grep -o '<Key>[^<]*</Key>' "$work/list.xml" | sed 's/<[^>]*>//g' | sort | tail -1)"
  if [ -z "$name" ]; then
    echo "drill failed: no backup found in the bucket" >&2
    exit 1
  fi
fi
echo "backup: $name"

r2 -o "$work/backup.gpg" "${endpoint%/}/$bucket/$name"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt \
  --output "$work/data.tar.gz" "$work/backup.gpg" 3<<<"$passphrase"
echo "decrypt: ok ($(du -h "$work/data.tar.gz" | cut -f1))"

# Restore into a fresh volume, owned like production's (the image's node user).
docker volume create "$volume" >/dev/null
docker run --rm -i --user 0 -v "$volume:/data" --entrypoint sh "$IMAGE" \
  -c 'tar xzf - -C /data && chown -R node:node /data' <"$work/data.tar.gz"
echo "restore: ok into volume $volume"

# Start the restored state as a separate service: no published port, dummy public settings.
docker run -d --name "$container" -v "$volume:/data" \
  --health-interval=1s --health-timeout=3s --health-retries=5 --health-start-period=5s \
  -e MCP_OAUTH_ISSUER=https://issuer.invalid \
  -e MCP_OAUTH_RESOURCE=https://drill.invalid/mcp \
  -e CLERK_PUBLISHABLE_KEY=pk_test_drill \
  "$IMAGE" >/dev/null
deadline=$((SECONDS + 60))
while :; do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$container")"
  [ "$health" = healthy ] && break
  if [ "$health" = unhealthy ] || [ "$SECONDS" -ge "$deadline" ]; then
    echo "drill failed: restored service did not become healthy ($health)" >&2
    docker logs --tail 20 "$container" >&2
    exit 1
  fi
  sleep 1
done
echo "service: healthy after restart on the restored volume"

# The restored files must be exactly the backup's files.
docker exec "$container" sh -c 'export LC_ALL=C; cd /data && find . -type f -print0 | sort -z | xargs -0 sha256sum' >"$work/restored.sums"
mkdir "$work/expected" && tar xzf "$work/data.tar.gz" -C "$work/expected"
(cd "$work/expected" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$work/expected.sums"
if ! cmp -s "$work/restored.sums" "$work/expected.sums"; then
  echo "drill failed: restored files differ from the backup" >&2
  diff <(awk '{print $2}' "$work/restored.sums") <(awk '{print $2}' "$work/expected.sums") | head -5 >&2
  diff "$work/restored.sums" "$work/expected.sums" | grep -c '^[<>]' >&2
  exit 1
fi
echo "files: $(wc -l <"$work/restored.sums") restored, identical to the backup"

# Every book must open, its git history must be intact, and access must stay per book.
docker exec -i "$container" node --input-type=module <<'EOF'
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Library } from '/app/src/application/library.ts';
import { decide } from '/app/src/application/decision.ts';

const library = new Library('/data');
const access = JSON.parse(readFileSync('/data/access.json', 'utf8')).books;
const books = Object.keys(access);
const members = [...new Set(books.flatMap((b) => access[b].members))];
let failures = 0;
const fail = (message) => { failures++; console.log(`FAIL ${message}`); };
const allowed = (subject, book) => decide({ library, subject, book, door: 'mcp', permission: 'com.fullfran.rewrite.book.read', entry: null }).allow;

for (const book of books) {
  const dir = join('/data/books', book);
  try { execFileSync('git', ['-C', dir, 'fsck', '--no-progress'], { stdio: 'pipe' }); } catch { fail(`${book}: git fsck`); }
  const owner = access[book].members[0];
  if (!owner) { fail(`${book}: no members`); continue; }
  const project = library.open(book, owner);
  const queue = project.reviewQueue();
  console.log(`book ${book}: ${project.scenes().length} scenes, ${project.claimViews().length} claims, ${queue.proposals.length} proposals, ${access[book].members.length} members, git ok`);
  for (const subject of members) {
    const expected = access[book].members.includes(subject);
    if (allowed(subject, book) !== expected) fail(`${book}: access for a ${expected ? 'member' : 'non-member'} is wrong`);
  }
  if (allowed('user_restore_drill_stranger', book)) fail(`${book}: a stranger is allowed`);
}
console.log(`access: ${books.length} books x ${members.length + 1} subjects checked, ${failures} failures`);
process.exit(failures ? 1 : 0);
EOF
echo "drill ok: $name restored, served and checked; removing the drill volume and container"

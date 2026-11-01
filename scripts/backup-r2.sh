#!/usr/bin/env bash
# Runs on the VPS: encrypts the RE;write data volume, uploads it to Cloudflare R2,
# then downloads that copy and checks it can be decrypted and read.
# The bucket only ever holds ciphertext. Settings live in an env file with these
# NAME=value lines, taken literally: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY, BACKUP_PASSPHRASE.
set -euo pipefail

ENV_FILE="${REWRITE_BACKUP_ENV:-$HOME/.config/rewrite-backup/r2.env}"
export PATH="/usr/local/bin:/usr/bin:/bin"

setting() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
endpoint="$(setting R2_ENDPOINT)"
bucket="$(setting R2_BUCKET)"
key_id="$(setting R2_ACCESS_KEY_ID)"
secret="$(setting R2_SECRET_ACCESS_KEY)"
passphrase="$(setting BACKUP_PASSPHRASE)"
for value in "$endpoint" "$bucket" "$key_id" "$secret" "$passphrase"; do
  if [ -z "$value" ]; then
    echo "backup failed: a setting is missing in $ENV_FILE" >&2
    exit 1
  fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="rewrite-$(date -u +%Y%m%dT%H%M%SZ).tar.gz.gpg"
url="${endpoint%/}/$bucket/$name"

# Credentials go through stdin, so they never appear in the process list.
r2() { printf 'user = "%s:%s"\n' "$key_id" "$secret" | curl -fsS --max-time 300 --aws-sigv4 aws:amz:auto:s3 -K - "$@"; }

container="$(docker ps -q -f name=rewrite.1 | head -1)"
if [ -z "$container" ]; then
  echo "backup failed: the rewrite service is not running" >&2
  exit 1
fi

docker exec "$container" tar czf - -C /data . >"$work/data.tar.gz"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --symmetric --cipher-algo AES256 \
  --output "$work/$name" "$work/data.tar.gz" 3<<<"$passphrase"

r2 -T "$work/$name" "$url"

# A backup nobody has read back is only a hope, so check the stored copy itself.
r2 -o "$work/check.gpg" "$url"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt \
  --output "$work/check.tar.gz" "$work/check.gpg" 3<<<"$passphrase"
tar tzf "$work/check.tar.gz" >"$work/listing"
if ! grep -qx './access.json' "$work/listing" || ! cmp -s "$work/data.tar.gz" "$work/check.tar.gz"; then
  echo "backup failed: the stored copy of $name does not match" >&2
  exit 1
fi

echo "$(date -u +%FT%TZ) backup ok: $name ($(du -h "$work/$name" | cut -f1))"

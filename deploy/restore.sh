#!/usr/bin/env bash
# Restore only into a new directory. Never overlay an active knowledge vault.
set -euo pipefail
umask 077
if (( $# != 2 )); then
  echo "Usage: bash deploy/restore.sh <backup.tar.gz> <new-restore-directory>" >&2; exit 2
fi
archive=$(realpath -e -- "$1")
parent=$(realpath -e -- "$(dirname -- "$2")")
name=$(basename -- "$2")
target="$parent/$name"
[[ -f $archive && -f $archive.sha256 && $name != . && $name != .. && ! -e $target && ! -L $target && $archive != *,* && $target != *,* ]] || { echo "Require a backup/checksum and a new destination directory." >&2; exit 2; }
expected=$(cat -- "$archive.sha256")
[[ $expected =~ ^[[:xdigit:]]{64}$ ]] || { echo "Invalid checksum file." >&2; exit 2; }
actual=$(sha256sum -- "$archive" | awk '{print $1}')
[[ $actual == "$expected" ]] || { echo "Checksum mismatch; nothing restored." >&2; exit 1; }
# Keep extraction within supported regular files/directories. No links or devices.
tar -tvzf "$archive" | awk 'substr($0,1,1)!="d" && substr($0,1,1)!="-" {bad=1} END {exit bad}' || { echo "Archive contains unsupported links or special files." >&2; exit 1; }
tar -tzPf "$archive" | while IFS= read -r member; do
  case "$member" in vault|vault/*|data|data/*|certificates|certificates/*) ;; *) echo "Unexpected archive path." >&2; exit 1 ;; esac
  clean=${member%/}
  case "/$clean/" in *'/../'*|*'/./'*|*'//'*) echo "Unsafe archive path." >&2; exit 1 ;; esac
done
helper=${NOTO_TOOL_IMAGE:-noto:local}
docker image inspect "$helper" >/dev/null
mkdir -- "$target"
docker run --rm --user 0:0 --network none --read-only --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --mount "type=bind,src=$archive,dst=/backup.tar.gz,readonly" --mount "type=bind,src=$target,dst=/restore" \
  --entrypoint /bin/sh "$helper" -ceu 'tar --numeric-owner -xzpf /backup.tar.gz -C /restore; test -d /restore/vault; test -f /restore/data/identity.json'
printf 'Restore complete: %s\nConfigure a new Compose instance with its vault, data and certificates directories.\n' "$target"

#!/usr/bin/env bash
# A consistent local backup of /vault + /data, and optionally the proxy CA.
set -euo pipefail
umask 077
if (( $# < 2 || $# > 3 )); then
  echo "Usage: bash deploy/backup.sh <noto-container> <new-backup.tar.gz> [proxy-container]" >&2; exit 2
fi
backend=$1
directory=$(realpath -e -- "$(dirname -- "$2")")
name=$(basename -- "$2")
proxy=${3:-}
archive="$directory/$name"
if [[ $name != *.tar.gz || $name == *$'\n'* || $name == *\\* || $directory == *,* || -e $archive || -e $archive.sha256 || -e $archive.info ]]; then
  echo "Choose a new .tar.gz path; existing backup files will not be overwritten." >&2; exit 2
fi
for target in /vault /data; do
  test -n "$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$target\"}}{{.Source}}{{end}}{{end}}" "$backend")" || { echo "Missing mount: $target" >&2; exit 2; }
done
image=$(docker inspect --format '{{.Image}}' "$backend")
reference=$(docker inspect --format '{{.Config.Image}}' "$backend")
running=$(docker inspect --format '{{.State.Running}}' "$backend")
proxy_running=false
extra=()
with_ca=no
if [[ -n $proxy ]]; then
  ca_type=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/certificates"}}{{.Type}}{{end}}{{end}}' "$proxy")
  ca_source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/certificates"}}{{.Source}}{{end}}{{end}}' "$proxy")
  [[ $ca_type == bind && -n $ca_source && $ca_source != *,* ]] || { echo "Proxy needs a /certificates bind mount." >&2; exit 2; }
  extra=(--mount "type=bind,src=$ca_source,dst=/certificates,readonly")
  proxy_running=$(docker inspect --format '{{.State.Running}}' "$proxy")
  with_ca=yes
fi
resume() {
  local result=$?
  trap - EXIT
  if [[ $running == true ]]; then docker start "$backend" >/dev/null || result=1; fi
  if [[ $proxy_running == true ]]; then docker start "$proxy" >/dev/null || result=1; fi
  exit "$result"
}
trap resume EXIT
if [[ $proxy_running == true ]]; then docker stop "$proxy" >/dev/null; fi
if [[ $running == true ]]; then docker stop "$backend" >/dev/null; fi
partial="$name.partial.$$"
docker run --rm --user 0:0 --network none --read-only --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add CHOWN \
  --volumes-from "$backend:ro" "${extra[@]}" --mount "type=bind,src=$directory,dst=/backup" \
  --entrypoint /bin/sh "$image" -ceu '
    umask 077
    output=$1; include_ca=$2; owner=$3
    test ! -e "/backup/$output"
    set -- vault data
    if [ "$include_ca" = yes ]; then set -- "$@" certificates; fi
    tar -czf "/backup/$output" -C / "$@"
    chown "$owner" "/backup/$output"
  ' backup "$partial" "$with_ca" "$(id -u):$(id -g)"
# Match restore.sh's supported archive types before publishing a backup.
tar -tvzf "$directory/$partial" | awk 'substr($0,1,1)!="d" && substr($0,1,1)!="-" {bad=1} END {exit bad}' || { echo "Backup contains unsupported links or special files; partial archive retained." >&2; exit 1; }
mv -n -- "$directory/$partial" "$archive"
[[ ! -e $directory/$partial ]] || { echo "Backup target appeared during the operation; partial archive retained." >&2; exit 1; }
sha256sum -- "$archive" | awk '{print $1}' > "$archive.sha256"
printf 'schema=1\nimage_id=%s\nimage_reference=%s\nincludes_ca=%s\n' "$image" "$reference" "$with_ca" > "$archive.info"
printf 'Backup complete: %s\n' "$archive"

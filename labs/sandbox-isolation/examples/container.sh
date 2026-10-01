#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
temp_base="${TMPDIR:-/tmp}"
root="$(mktemp -d "${temp_base%/}/hands-on-dsh-container-XXXXXXXX")"
run_id="$(basename "$root" | tr '[:upper:]' '[:lower:]')"
container="${run_id}-ssh"
network="${run_id}-net"
image="${run_id}:local"
cleanup_container() {
  local found labels
  found="$(docker container ls -a --filter "name=^/${container}$" --format '{{.Names}}')" || return 1
  if [[ -z "$found" ]]; then return 0; fi
  if [[ "$found" != "$container" ]]; then echo "unexpected container name: $found" >&2; return 1; fi
  labels="$(docker container inspect --format '{{index .Config.Labels "hands-on-dsh.task"}} {{index .Config.Labels "hands-on-dsh.run"}}' "$container")" || return 1
  if [[ "$labels" != "container-executor $run_id" ]]; then echo "refusing unowned container: $container" >&2; return 1; fi
  docker container rm -f "$container" >/dev/null || return 1
  found="$(docker container ls -a --filter "name=^/${container}$" --format '{{.Names}}')" || return 1
  [[ -z "$found" ]]
}

cleanup_network() {
  local found labels
  found="$(docker network ls --filter "name=^${network}$" --format '{{.Name}}')" || return 1
  if [[ -z "$found" ]]; then return 0; fi
  if [[ "$found" != "$network" ]]; then echo "unexpected network name: $found" >&2; return 1; fi
  labels="$(docker network inspect --format '{{index .Labels "hands-on-dsh.task"}} {{index .Labels "hands-on-dsh.run"}}' "$network")" || return 1
  if [[ "$labels" != "container-executor $run_id" ]]; then echo "refusing unowned network: $network" >&2; return 1; fi
  docker network rm "$network" >/dev/null || return 1
  found="$(docker network ls --filter "name=^${network}$" --format '{{.Name}}')" || return 1
  [[ -z "$found" ]]
}

cleanup_image() {
  local found labels
  found="$(docker image ls "$image" --format '{{.Repository}}:{{.Tag}}')" || return 1
  if [[ -z "$found" ]]; then return 0; fi
  if [[ "$found" != "$image" ]]; then echo "unexpected image tag: $found" >&2; return 1; fi
  labels="$(docker image inspect --format '{{index .Config.Labels "hands-on-dsh.task"}} {{index .Config.Labels "hands-on-dsh.run"}}' "$image")" || return 1
  if [[ "$labels" != "container-executor $run_id" ]]; then echo "refusing unowned image: $image" >&2; return 1; fi
  docker image rm "$image" >/dev/null || return 1
  found="$(docker image ls "$image" --format '{{.Repository}}:{{.Tag}}')" || return 1
  [[ -z "$found" ]]
}

cleanup_owned() {
  local failed=0
  cleanup_container || failed=1
  cleanup_network || failed=1
  cleanup_image || failed=1
  rm -f -- "$root/client_key" || failed=1
  if (( !failed )); then rm -rf -- "$root" || failed=1; fi
  if (( failed )); then
    echo "cleanup incomplete for $run_id; scratch retained at $root" >&2
    return 1
  fi
}

on_exit() {
  local status="$1"
  trap - EXIT
  if ! cleanup_owned; then exit 1; fi
  exit "$status"
}
trap 'on_exit $?' EXIT

mkdir -m 0777 "$root/a" "$root/b"
nonce="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
printf '%s' "$nonce" > "$root/b/canary"
ln -s "$root/b" "$root/a/escape"
ssh-keygen -q -t ed25519 -N '' -f "$root/client_key"
cp "$root/client_key.pub" "$root/a/authorized_keys"
chmod 0644 "$root/a/authorized_keys"

docker build --quiet \
  --label hands-on-dsh.task=container-executor \
  --label "hands-on-dsh.run=$run_id" \
  -f examples/Container.Dockerfile -t "$image" examples >&2
image_digest="$(docker image inspect --format '{{.Id}}' "$image")"
docker network create \
  --label hands-on-dsh.task=container-executor \
  --label "hands-on-dsh.run=$run_id" "$network" >/dev/null
docker create \
  --name "$container" \
  --label hands-on-dsh.task=container-executor \
  --label "hands-on-dsh.run=$run_id" \
  --network "$network" \
  --publish 127.0.0.1::2222 \
  --mount "type=bind,src=$root/a,dst=/work" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --memory 256m \
  --cpus 1 \
  --user 10001:10001 \
  --tmpfs /run/ssh:rw,nosuid,nodev,size=1m,uid=10001,gid=10001 \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m,uid=10001,gid=10001 \
  "$image" sh -c 'ssh-keygen -q -t ed25519 -N "" -f /run/ssh/host_key && cp /work/authorized_keys /run/ssh/authorized_keys && chmod 600 /run/ssh/authorized_keys && exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config' >/dev/null
docker start "$container" >/dev/null
remote_node="$(docker exec "$container" node --version)"
effective_uid="$(docker exec "$container" id -u)"
if [[ "$effective_uid" != 10001 ]]; then echo 'container did not run as the lab user' >&2; exit 1; fi

docker inspect "$container" > "$root/inspect.json"
node -e '
  const fs = require("node:fs");
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0];
  const h = c.HostConfig;
  const mount = c.Mounts;
  const port = c.NetworkSettings.Ports["2222/tcp"];
  const tmpfs = h.Tmpfs ?? {};
  if (c.Config.User !== "10001:10001" || !h.ReadonlyRootfs ||
      !h.CapDrop?.includes("ALL") || !h.SecurityOpt?.includes("no-new-privileges") ||
      h.PidsLimit !== 64 || h.Memory !== 268435456 || h.NanoCpus !== 1000000000 ||
      Object.keys(tmpfs).sort().join(",") !== "/run/ssh,/tmp" ||
      tmpfs["/run/ssh"] !== "rw,nosuid,nodev,size=1m,uid=10001,gid=10001" ||
      tmpfs["/tmp"] !== "rw,nosuid,nodev,size=16m,uid=10001,gid=10001" ||
      h.NetworkMode !== process.argv[3] || mount.length !== 1 ||
      mount[0].Source !== process.argv[2] || mount[0].Destination !== "/work" ||
      mount[0].RW !== true || port.length !== 1 || port[0].HostIp !== "127.0.0.1") {
    throw new Error("container restrictions differ from the experiment: " + JSON.stringify({
      user: c.Config.User, readonly: h.ReadonlyRootfs, capDrop: h.CapDrop,
      securityOpt: h.SecurityOpt, network: h.NetworkMode,
      pidsLimit: h.PidsLimit, memory: h.Memory, nanoCpus: h.NanoCpus, tmpfs,
      mount: mount.map(m => ({source: m.Source, destination: m.Destination, rw: m.RW})),
      port, expectedMount: process.argv[2], expectedNetwork: process.argv[3],
    }));
  }
' "$root/inspect.json" "$root/a" "$network"

port="$(docker port "$container" 2222/tcp | sed -n 's/^127\.0\.0\.1://p')"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then echo 'missing loopback SSH port' >&2; exit 1; fi
for _ in {1..30}; do
  if docker exec "$container" test -f /run/ssh/host_key.pub; then break; fi
  sleep 1
done
host_public="$(docker exec "$container" cat /run/ssh/host_key.pub)"
printf '[127.0.0.1]:%s %s\n' "$port" "$host_public" > "$root/known_hosts"
cat > "$root/ssh_config" <<EOF
Host dsh-container
  HostName 127.0.0.1
  Port $port
  User lab
  IdentityFile $root/client_key
  UserKnownHostsFile $root/known_hosts
  StrictHostKeyChecking yes
  IdentitiesOnly yes
  BatchMode yes
  ForwardAgent no
  ControlMaster no
EOF
chmod 0600 "$root/ssh_config" "$root/known_hosts"

docker exec "$container" sh -c 'printf "%s" "$1" > /work/direct.bin' _ "$nonce"
direct_exit=0
ssh -F "$root/ssh_config" dsh-container "printf '%s' '$nonce' > /work/ssh.bin"
ssh_exit=0

helper_hash="$(docker exec "$container" sha256sum /opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js | awk '{print $1}')"
mkdir -m 0700 "$root/bin"
cat > "$root/bin/ssh" <<'EOF'
#!/bin/sh
exec /usr/bin/ssh -F "$DSH_SSH_CONFIG" "$@"
EOF
chmod 0700 "$root/bin/ssh"
provider_report="$(PATH="$root/bin:$PATH" DSH_SSH_CONFIG="$root/ssh_config" node --import tsx examples/remote-provider.ts "$helper_hash" "$nonce")"
node -e 'const v=JSON.parse(process.argv[1]);if(v.exitCode!==0||v.outsideDenied!==true)process.exit(1)' "$provider_report"

if docker exec "$container" sh -c 'cat /work/../tenant-b/canary >/dev/null 2>&1'; then
  cross_workspace_read_exit=0
else
  cross_workspace_read_exit=$?
fi
if docker exec "$container" sh -c 'cat /work/escape/canary >/dev/null 2>&1'; then
  symlink_read_exit=0
else
  symlink_read_exit=$?
fi
if docker exec "$container" sh -c 'printf "%s" "$1" > /work/../tenant-b/outside.bin' _ "$nonce" 2>/dev/null; then
  echo 'tenant B write was unexpectedly available' >&2
  exit 1
fi
if docker exec "$container" sh -c 'printf "%s" "$1" > /work/escape/outside.bin' _ "$nonce" 2>/dev/null; then
  echo 'tenant B symlink write was unexpectedly available' >&2
  exit 1
fi
printf '%s' "$nonce" > "$root/expected"
cmp -s "$root/expected" "$root/a/direct.bin"
cmp -s "$root/expected" "$root/a/ssh.bin"
cmp -s "$root/expected" "$root/a/provider.bin"
cmp -s "$root/expected" "$root/a/process.bin"
cmp -s "$root/expected" "$root/b/canary"
artifact_hex="$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("hex"))' "$root/a/provider.bin")"
if [[ -e "$root/b/outside.bin" ]]; then echo 'tenant B was modified' >&2; exit 1; fi
if (( cross_workspace_read_exit != 1 || symlink_read_exit != 1 )); then
  echo 'cross-workspace access was unexpectedly available' >&2
  exit 1
fi

if ! cleanup_owned; then trap - EXIT; exit 1; fi
trap - EXIT
printf '{"directExit":%d,"sshExit":%d,"crossWorkspaceReadExit":%d,"symlinkReadExit":%d,"crossWorkspaceWriteDenied":true,"symlinkWriteDenied":true,"restrictionsVerified":true,"limitsVerified":true,"effectiveUid":%d,"artifactBytesVerified":true,"providerArtifactBytesVerified":true,"providerCrossWorkspaceDenied":true,"tenantBUnchanged":true,"cleanupVerified":true,"artifactHex":"%s","remoteNode":"%s","imageDigest":"%s","helperHash":"%s"}\n' \
  "$direct_exit" "$ssh_exit" "$cross_workspace_read_exit" "$symlink_read_exit" "$effective_uid" "$artifact_hex" "$remote_node" "$image_digest" "$helper_hash"

#!/bin/sh
# Start Document Server + two user containers for the Office flow test.
set -e
cd "$(dirname "$0")"
IMG=${IMG:-dsh-poc-office:patched}
docker network create dshpoc >/dev/null 2>&1 || true
docker rm -f oo-ds dsh-a dsh-b >/dev/null 2>&1 || true
docker run -d --name oo-ds --network dshpoc -e JWT_ENABLED=true -e JWT_SECRET=poc-jwt-secret-not-for-production \
  -e ALLOW_PRIVATE_IP_ADDRESS=true -v "$PWD/../../assets/fonts:/usr/share/fonts/truetype/custom:ro" onlyoffice/documentserver:9.4.0 >/dev/null
for u in a b; do
  [ $u = a ] && p=13081 || p=13082
  docker run -d --name dsh-$u --hostname dsh-$u --network dshpoc -e DMXAPI_KEY \
    --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
    -p 127.0.0.1:$p:3080 -v dshpoc-home-$u:/data/home -v dshpoc-work-$u:/data/work \
    -v "$PWD/managed.office.$u.yml:/managed/patch.yml:ro" "$IMG" \
    sh -c 'exec dsh --profile web --patch /managed/patch.yml --no-open --trusted-host localhost:8080' >/dev/null
done

#!/bin/sh
# Build once, then restart on crash.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/server" || exit 1

go build -o tag-server . || exit 1
echo "build ok"

mkdir -p "$ROOT/logs"
while true; do
    echo "$(date): starting server"
    ./tag-server -logfile "$ROOT/logs/server.log" "$@"
    echo "$(date): server exited (status $?), restarting in 3s..."
    sleep 3
done

#!/bin/sh
# Build once, then restart on crash.
cd "$(dirname "$0")/server" || exit 1

go build -o ../tag-server . || exit 1
echo "build ok"

cd ..
while true; do
    echo "$(date): starting server"
    ./tag-server -logfile logs/server.log "$@"
    echo "$(date): server exited (status $?), restarting in 3s..."
    sleep 3
done

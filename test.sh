#! /bin/bash

find ./test/ -type f -name "*.log" -exec bash -c 'curl -X POST -H "Lumberjack-App: Test" -H "Lumberjack-Env: Test" -H "Authorization: test" --data-binary @{} http://127.0.0.1:7777/logs' \;

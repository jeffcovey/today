#!/bin/bash
cd /opt/today
npx dotenvx run -- sqlite3 .data/today.db "PRAGMA wal_checkpoint(PASSIVE);" >/dev/null 2>&1

#!/bin/sh
# Loob puhta andmebaasi, rakendab migratsioonid ja käivitab testid.
# Kasutus: PGHOST=/tmp/pgsaldo PGPORT=54329 sh tests/run_db_tests.sh
set -e
cd "$(dirname "$0")/.."
P="psql -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists saldo_test" >/dev/null
$P -c "create database saldo_test" >/dev/null
$P -d saldo_test -f tests/supabase_stub.sql
$P -d saldo_test -f supabase/migrations/0001_saldo.sql
$P -d saldo_test -f supabase/migrations/0002_storage.sql
$P -d saldo_test -f supabase/migrations/0003_invoice_design.sql
$P -d saldo_test -f tests/test_db.sql 2>&1 | grep -E "OK|FAIL|ERROR|LÄBITUD|import:" | sed 's/^psql:[^ ]* NOTICE:  //'

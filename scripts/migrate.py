#!/usr/bin/env python3
"""Custom Postgres migration runner (replaces node-pg-migrate). Migrations
live in migrations/NNNN_name.sql, each split into a "-- up" and a
"-- down" section, applied/reverted in filename order and tracked in a
schema_migrations table."""
import os
import re
import sys
import time
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

UP_RE = re.compile(r"--\s*up\s*\n(.*?)(?=\n--\s*down\s*\n|\Z)", re.IGNORECASE | re.DOTALL)
DOWN_RE = re.compile(r"--\s*down\s*\n(.*)\Z", re.IGNORECASE | re.DOTALL)


def _connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not set.", file=sys.stderr)
        sys.exit(1)
    sslmode = "require" if os.environ.get("DB_SSL") == "true" else "disable"
    sep = "&" if "?" in database_url else "?"
    return psycopg.connect(f"{database_url}{sep}sslmode={sslmode}")


def _ensure_tracking_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                 id TEXT PRIMARY KEY,
                 applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
               )"""
        )
    conn.commit()


def _migration_files():
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def _split_sections(sql_text):
    up_match = UP_RE.search(sql_text)
    down_match = DOWN_RE.search(sql_text)
    return (
        up_match.group(1).strip() if up_match else "",
        down_match.group(1).strip() if down_match else "",
    )


def _applied_ids(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM schema_migrations")
        return {row[0] for row in cur.fetchall()}


def up():
    conn = _connect()
    try:
        _ensure_tracking_table(conn)
        applied = _applied_ids(conn)
        ran_any = False
        for path in _migration_files():
            migration_id = path.stem
            if migration_id in applied:
                continue
            up_sql, _ = _split_sections(path.read_text())
            print(f"Applying {migration_id}...")
            with conn.cursor() as cur:
                cur.execute(up_sql)
                cur.execute("INSERT INTO schema_migrations (id) VALUES (%s)", [migration_id])
            conn.commit()
            ran_any = True
        print("Already up to date." if not ran_any else "Migrations complete.")
    finally:
        conn.close()


def down():
    conn = _connect()
    try:
        _ensure_tracking_table(conn)
        applied = _applied_ids(conn)
        for path in reversed(_migration_files()):
            migration_id = path.stem
            if migration_id not in applied:
                continue
            _, down_sql = _split_sections(path.read_text())
            print(f"Reverting {migration_id}...")
            with conn.cursor() as cur:
                cur.execute(down_sql)
                cur.execute("DELETE FROM schema_migrations WHERE id = %s", [migration_id])
            conn.commit()
            return
        print("No migrations to revert.")
    finally:
        conn.close()


def baseline():
    """Marks every migration file as already applied, without running its
    SQL — for adopting a database that was already fully migrated by the
    previous tool (node-pg-migrate) before this runner existed."""
    conn = _connect()
    try:
        _ensure_tracking_table(conn)
        applied = _applied_ids(conn)
        with conn.cursor() as cur:
            for path in _migration_files():
                migration_id = path.stem
                if migration_id in applied:
                    continue
                print(f"Baselining {migration_id} (marking applied, not running)...")
                cur.execute("INSERT INTO schema_migrations (id) VALUES (%s)", [migration_id])
        conn.commit()
    finally:
        conn.close()


def create(name):
    timestamp = int(time.time())
    filename = MIGRATIONS_DIR / f"{timestamp}_{name}.sql"
    filename.write_text("-- up\n\n\n-- down\n")
    print(f"Created {filename}")


def main():
    if len(sys.argv) < 2:
        print("Usage: migrate.py <up|down|baseline|create NAME>", file=sys.stderr)
        sys.exit(1)
    command = sys.argv[1]
    if command == "up":
        up()
    elif command == "down":
        down()
    elif command == "baseline":
        baseline()
    elif command == "create":
        if len(sys.argv) < 3:
            print("Usage: migrate.py create NAME", file=sys.stderr)
            sys.exit(1)
        create(sys.argv[2])
    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

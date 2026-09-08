#!/usr/bin/env python3
"""One-time loader: create the PostgreSQL schema and seed it from data.sqlite.

`data.sqlite` is only the seed source here -- once this has run, server.py talks
to PostgreSQL exclusively and never touches the file again.

    FAMILYTREE_DATABASE_URL=postgresql://familytree@localhost/familytree \\
        python migrate_sqlite_to_pg.py

Pass --reset to DROP the app tables first (destructive -- wipes the target).
The helper functions here are also used by tests/pg_fixture.py.
"""
import argparse
import os
import sqlite3
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent
SCHEMA_SQL = ROOT / "schema.sql"
DEFAULT_SQLITE = ROOT / "data.sqlite"

# Copied from SQLite, in FK-safe order. Users / Sessions are intentionally left
# out: a fresh deployment bootstraps its own admin via ensure_initial_admin().
SEED_TABLES = ["People", "Spouses", "Parents", "Roots", "RootMembers"]
# Tables whose id is a real IDENTITY column -- their sequence needs realigning
# after the explicit-id INSERTs above.
IDENTITY_TABLES = ["Roots", "RootMembers", "Users"]
# Drop order (children first) for --reset and the test fixture.
ALL_APP_TABLES = ["Sessions", "Users", "RootMembers", "Roots", "Parents", "Spouses", "People"]


def apply_schema(pg):
    """Run schema.sql. Every statement is IF NOT EXISTS, so this is idempotent."""
    pg.execute(SCHEMA_SQL.read_text())


def drop_all_tables(pg):
    for table in ALL_APP_TABLES:
        pg.execute(f"DROP TABLE IF EXISTS {table} CASCADE")


def seed_from_sqlite(pg, sqlite_path=DEFAULT_SQLITE):
    """Copy SEED_TABLES from the SQLite file into the (already-schema'd) target.
    Returns {table: row_count}."""
    src = sqlite3.connect(sqlite_path)
    src.row_factory = sqlite3.Row
    counts = {}
    try:
        for table in SEED_TABLES:
            rows = src.execute(f"SELECT * FROM {table}").fetchall()
            counts[table] = len(rows)
            if not rows:
                continue
            cols = list(rows[0].keys())
            col_list = ", ".join(cols)
            placeholders = ", ".join(["%s"] * len(cols))
            with pg.cursor() as cur:
                cur.executemany(
                    f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})",
                    [tuple(r[c] for c in cols) for r in rows],
                )
    finally:
        src.close()

    # The explicit-id INSERTs bypassed the IDENTITY sequences; set each so the
    # next generated id follows the max present (or starts at 1 when empty).
    for table in IDENTITY_TABLES:
        pg.execute(
            f"SELECT setval(pg_get_serial_sequence(%s, 'id'), "
            f"GREATEST(COALESCE((SELECT MAX(id) FROM {table}), 1), 1), "
            f"(SELECT MAX(id) FROM {table}) IS NOT NULL)",
            (table.lower(),),
        )
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE), help="source SQLite file")
    parser.add_argument("--database-url", default=os.environ.get("FAMILYTREE_DATABASE_URL"),
                        help="target Postgres URL (default: $FAMILYTREE_DATABASE_URL)")
    parser.add_argument("--reset", action="store_true", help="DROP the app tables first")
    args = parser.parse_args()

    if not args.database_url:
        parser.error("no target database: set FAMILYTREE_DATABASE_URL or pass --database-url")
    if not Path(args.sqlite).is_file():
        parser.error(f"source SQLite file not found: {args.sqlite}")

    with psycopg.connect(args.database_url) as pg:
        if args.reset:
            drop_all_tables(pg)
            print("dropped existing app tables")
        apply_schema(pg)
        print("applied schema.sql")
        counts = seed_from_sqlite(pg, args.sqlite)
    for table, n in counts.items():
        print(f"  {table}: {n} rows")
    print("done")


if __name__ == "__main__":
    main()

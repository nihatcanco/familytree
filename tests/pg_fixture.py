"""Shared setup for the test suite: reset a scratch PostgreSQL database and
seed it from the repo's data.sqlite.

Needs a reachable PostgreSQL. Point TEST_DATABASE_URL at it, or start the
bundled one:  docker compose -f docker-compose.test.yml up -d  (listens on :5433).
"""
import os
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from migrate_sqlite_to_pg import apply_schema, drop_all_tables, seed_from_sqlite  # noqa: E402

DEFAULT_URL = "postgresql://familytree:familytree@localhost:5433/familytree_test"


def database_url():
    return os.environ.get("TEST_DATABASE_URL", DEFAULT_URL)


def reset_and_seed():
    """Drop every app table, re-apply schema.sql, seed from data.sqlite, and
    wipe accounts so the server bootstraps a known admin. Returns the URL to
    hand to the server subprocess."""
    url = database_url()
    with psycopg.connect(url) as conn:
        drop_all_tables(conn)
        apply_schema(conn)
        seed_from_sqlite(conn, ROOT / "data.sqlite")
        conn.execute("DELETE FROM Sessions")
        conn.execute("DELETE FROM Users")
    return url

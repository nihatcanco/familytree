"""Shared setup for the test suite: reset a scratch PostgreSQL database and
seed it with a small synthetic family tree.

Needs a reachable PostgreSQL. Point TEST_DATABASE_URL at it, or start the
bundled one:  docker compose -f docker-compose.test.yml up -d  (listens on :5433).
"""
import os
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = ROOT / "schema.sql"

DEFAULT_URL = "postgresql://familytree:familytree@localhost:5433/familytree_test"

# Drop order (children first).
_APP_TABLES = ["sessions", "users", "rootmembers", "roots", "parents", "spouses", "people"]

# A synthetic three-generation tree: two families joined by marriages, enough
# people / couples / roots to exercise rendering, connectors and focus mode
# without shipping real data. (id, name, surname, gender)
_PEOPLE = [
    (1, "Ahmet", "Yılmaz", 1),  (2, "Ayşe", "Yılmaz", 2),
    (3, "Mehmet", "Yılmaz", 1), (4, "Fatma", "Kaya", 2),
    (5, "Zeynep", "Yılmaz", 2), (6, "Ali", "Yılmaz", 1),
    (7, "Veli", "Yılmaz", 1),   (8, "Hasan", "Kaya", 1),
    (9, "Elif", "Kaya", 2),     (10, "Can", "Kaya", 1),
    (11, "Deniz", "Yılmaz", 2), (12, "Ege", "Yılmaz", 1),
    (13, "Selin", "Demir", 2),  (14, "Kaya", "Demir", 1),
    (15, "Nur", "Demir", 2),
]
_SPOUSES = [(1, 2), (3, 5), (4, 8), (6, 11)]
_PARENTS = [  # (childId, parent1Id, parent2Id)
    (3, 1, 2), (4, 1, 2),
    (6, 3, 5), (7, 3, 5),
    (9, 4, 8), (10, 4, 8),
    (12, 6, 11),
]
_ROOTS = [(1, "YILMAZ FAMILY", 1), (2, "DEMİR FAMILY", 1)]
_ROOT_MEMBERS = [(1, 1), (1, 2), (2, 14), (2, 15)]  # (rootId, personId)


def database_url():
    return os.environ.get("TEST_DATABASE_URL", DEFAULT_URL)


def _seed(conn):
    conn.cursor().executemany(
        "INSERT INTO people (id, name, surname, gender) VALUES (%s, %s, %s, %s)", _PEOPLE)
    conn.cursor().executemany(
        "INSERT INTO spouses (id, spouse1id, spouse2id) VALUES (%s, %s, %s)",
        [(i + 1, a, b) for i, (a, b) in enumerate(_SPOUSES)])
    conn.cursor().executemany(
        "INSERT INTO parents (id, childid, parent1id, parent2id) VALUES (%s, %s, %s, %s)",
        [(i + 1, *row) for i, row in enumerate(_PARENTS)])
    conn.cursor().executemany(
        "INSERT INTO roots (id, title, generation) VALUES (%s, %s, %s)", _ROOTS)
    conn.cursor().executemany(
        "INSERT INTO rootmembers (rootid, personid) VALUES (%s, %s)", _ROOT_MEMBERS)
    # roots/rootmembers ids came from explicit values / IDENTITY; realign the
    # IDENTITY sequences so server-side inserts don't collide.
    for table in ("roots", "rootmembers"):
        conn.execute(
            f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
            f"(SELECT MAX(id) FROM {table}))")


def reset_and_seed():
    """Drop every app table, re-apply schema.sql, seed the synthetic tree, and
    leave Users/Sessions empty so the server bootstraps a known admin. Returns
    the database URL to hand to the server subprocess."""
    url = database_url()
    with psycopg.connect(url, autocommit=False) as conn:
        for table in _APP_TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        conn.execute(SCHEMA_SQL.read_text())
        _seed(conn)
    return url

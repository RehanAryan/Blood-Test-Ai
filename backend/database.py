"""
Database schema and initialization for BloodReport AI.
Implements SQLite storage for Users, Reports, and TestResults as specified in project.md.
"""

import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'bloodreport.db')

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Users Table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS Users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER,
        sex TEXT,
        date_of_birth TEXT,
        height TEXT,
        weight TEXT,
        pregnancy_status TEXT DEFAULT 'Not pregnant',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ''')

    # 2. Reports Table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS Reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        report_date TEXT NOT NULL,
        uploaded_file TEXT,
        laboratory_name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES Users(id) ON DELETE CASCADE
    );
    ''')

    # 3. TestResults Table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS TestResults (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL,
        test_name TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        reference_low REAL,
        reference_high REAL,
        status TEXT NOT NULL,
        FOREIGN KEY (report_id) REFERENCES Reports(id) ON DELETE CASCADE
    );
    ''')

    conn.commit()
    conn.close()

def ensure_default_user(conn):
    """Return a user id for new reports, creating a placeholder row only
    when the Users table is empty (profile UI removed; Firebase owns
    identity later). No demo reports or values are ever seeded."""
    cursor = conn.cursor()
    row = cursor.execute('SELECT id FROM Users ORDER BY id ASC LIMIT 1').fetchone()
    if row:
        return row[0]
    cursor.execute('''
    INSERT INTO Users (name, age, sex, date_of_birth, height, weight, pregnancy_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', ('Local User', None, None, None, None, None, None))
    conn.commit()
    return cursor.lastrowid

if __name__ == '__main__':
    init_db()
    print("BloodReport AI database initialized (empty, no seed data).")

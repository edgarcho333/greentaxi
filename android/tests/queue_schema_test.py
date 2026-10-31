#!/usr/bin/env python3
"""Execute production queue SQL against SQLite; Android lifecycle is tested on-device."""
import json
import pathlib
import re
import sqlite3
import unittest

SOURCE = (pathlib.Path(__file__).resolve().parents[1] / 'app/src/main/java/ge/greentaxi/calls/CallQueue.java').read_text()
V1_SCHEMA = "CREATE TABLE call_events (event_id TEXT PRIMARY KEY, phone TEXT, occurred_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, error_code TEXT)"

def body(name):
    match = re.search(r'(?:private static void|public void|synchronized void)\s+' + name + r'\([^)]*\)\s*\{', SOURCE)
    start = match.end()
    depth = 1
    for index in range(start, len(SOURCE)):
        depth += (SOURCE[index] == '{') - (SOURCE[index] == '}')
        if depth == 0:
            return SOURCE[start:index]
    raise AssertionError('method not found')

def run_method(db, name):
    for match in re.finditer(r'db\.execSQL\("((?:[^"\\]|\\.)*)"\)|\b(createEvents|createLiveSessions)\(db\)', body(name)):
        if match.group(2):
            run_method(db, match.group(2))
        else:
            db.execute(json.loads('"' + match.group(1) + '"'))

def query(prefix):
    for match in re.finditer(r'rawQuery\("((?:[^"\\]|\\.)*)"', SOURCE):
        sql = json.loads('"' + match.group(1) + '"')
        if sql.startswith(prefix):
            return sql
    raise AssertionError('query not found')

def raw_queries():
    return [json.loads('"' + match.group(1) + '"')
            for match in re.finditer(r'rawQuery\("((?:[^"\\]|\\.)*)"', SOURCE)]

def fresh_db():
    db = sqlite3.connect(':memory:')
    run_method(db, 'onCreate')
    return db

def stage(db, event_id, phase, phone='599123456', date=100, duration=0):
    db.execute('INSERT OR IGNORE INTO call_events(event_id,phase,phone,occurred_at,duration_seconds) VALUES (?,?,?,?,?)',
               (event_id, phase, phone, date, duration))

class QueueSqlTests(unittest.TestCase):
    def test_fast_path_prioritizes_only_new_answers_and_recovers_backlog_fairly(self):
        db = fresh_db()
        stage(db, 'old-log', 'completed', date=1, duration=10)
        stage(db, 'retry-answer', 'answered', date=2)
        db.execute("UPDATE call_events SET attempts=3 WHERE event_id='retry-answer'")
        stage(db, 'already-acked', 'answered', date=999)
        db.execute("UPDATE call_events SET delivered=1 WHERE event_id='already-acked'")
        for index in range(8):
            stage(db, f'new-{index}', 'answered', date=100 + index)
            stage(db, f'new-{index}', 'completed', date=100 + index, duration=5)
        oldest = query('SELECT e.event_id')
        urgent = next(sql for sql in raw_queries() if "e.attempts=0" in sql)
        self.assertEqual(db.execute(urgent, (1000,)).fetchone()[0], 'new-7')
        # Exercise production SQL with the four-priority / one-oldest budget.
        chosen = []
        for index in range(5):
            sql = urgent if index < 4 else oldest
            event = db.execute(sql, (1000,)).fetchone()
            chosen.append((event[0], event[5]))
            db.execute('UPDATE call_events SET delivered=1 WHERE event_id=? AND phase=?', (event[0], event[5]))
        self.assertEqual(chosen, [('new-7', 'answered'), ('new-6', 'answered'),
                                  ('new-5', 'answered'), ('new-4', 'answered'), ('old-log', 'completed')])
        # A scheduled retry is not an urgent fresh call, but remains eligible.
        self.assertEqual(db.execute(oldest, (1000,)).fetchone()[0], 'retry-answer')

    def test_retry_deadline_ignores_blocked_completions_and_recovery_keeps_acknowledgments(self):
        db = fresh_db()
        stage(db, 'pending', 'answered', date=111)
        stage(db, 'pending', 'completed', date=111, duration=20)
        stage(db, 'acked', 'completed', date=10, duration=30)
        db.execute("UPDATE call_events SET attempts=4,next_try=900000,error_code='connection_failed' WHERE event_id='pending' AND phase='answered'")
        db.execute("UPDATE call_events SET delivered=1,next_try=999999,error_code='retained' WHERE event_id='acked'")
        next_retry = query('SELECT MIN(e.next_try)')
        self.assertEqual(db.execute(next_retry).fetchone()[0], 900000)
        self.assertEqual(db.execute(query('SELECT MIN(occurred_at)')).fetchone()[0], 111)
        before = db.execute('SELECT event_id,phase,phone,occurred_at,duration_seconds,attempts,delivered FROM call_events ORDER BY event_id,phase').fetchall()
        # Execute the actual production recovery UPDATE, not a copied statement.
        run_method(db, 'retryAllNow')
        self.assertEqual(db.execute(next_retry).fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT next_try,error_code FROM call_events WHERE event_id='acked'").fetchone(), (999999, 'retained'))
        after = db.execute('SELECT event_id,phase,phone,occurred_at,duration_seconds,attempts,delivered FROM call_events ORDER BY event_id,phase').fetchall()
        self.assertEqual(after, before)
        self.assertEqual([(row[0], row[5]) for row in db.execute(query('SELECT e.event_id'), (1000,))], [('pending', 'answered')])
        db.execute("UPDATE call_events SET delivered=1 WHERE event_id='pending'")
        self.assertIsNone(db.execute(next_retry).fetchone()[0])

    def test_v1_migration_preserves_pending_delivered_and_retries(self):
        db = sqlite3.connect(':memory:')
        db.execute(V1_SCHEMA)
        db.execute('CREATE INDEX pending_calls ON call_events(delivered,next_try)')
        old = [('old-pending', '+995599123456', 123, 15, 0, 4, 555, 'connection_failed'),
               ('old-delivered', None, 234, 0, 1, 0, 0, None)]
        db.executemany('INSERT INTO call_events VALUES (?,?,?,?,?,?,?,?)', old)
        run_method(db, 'onUpgrade')
        rows = db.execute('SELECT event_id,phone,occurred_at,duration_seconds,delivered,attempts,next_try,error_code FROM call_events ORDER BY event_id').fetchall()
        self.assertEqual(rows, sorted(old))
        self.assertEqual(db.execute('SELECT phase,legacy_payload FROM call_events').fetchall(), [('completed', 1), ('completed', 1)])
        stage(db, 'new', 'answered')
        self.assertEqual(db.execute("SELECT legacy_payload FROM call_events WHERE event_id='new'").fetchone()[0], 0)

    def test_migration_ddl_can_rollback_without_losing_v1_data(self):
        db = sqlite3.connect(':memory:')
        db.execute(V1_SCHEMA)
        db.execute('CREATE INDEX pending_calls ON call_events(delivered,next_try)')
        db.execute("INSERT INTO call_events(event_id,occurred_at,duration_seconds) VALUES ('retained',123,0)")
        db.commit()
        db.execute('BEGIN')
        run_method(db, 'onUpgrade')
        db.rollback()
        self.assertEqual(db.execute('SELECT event_id FROM call_events').fetchall(), [('retained',)])
        self.assertNotIn('phase', [row[1] for row in db.execute('PRAGMA table_info(call_events)')])
        self.assertEqual(db.execute("SELECT count(*) FROM sqlite_master WHERE name='live_sessions'").fetchone()[0], 0)

    def test_completion_waits_for_answer_ack_even_during_backoff(self):
        db = fresh_db()
        stage(db, 'live', 'answered', date=111)
        stage(db, 'live', 'completed', date=111, duration=45)
        due = query('SELECT e.event_id')
        self.assertEqual([(row[0], row[5]) for row in db.execute(due, (1000,))], [('live', 'answered')])
        db.execute("UPDATE call_events SET next_try=99999 WHERE phase='answered'")
        self.assertEqual(db.execute(due, (1000,)).fetchall(), [])
        db.execute("UPDATE call_events SET delivered=1 WHERE phase='answered'")
        self.assertEqual([(row[0], row[5]) for row in db.execute(due, (1000,))], [('live', 'completed')])

    def test_duplicate_stage_cannot_replace_immutable_payload(self):
        db = fresh_db()
        stage(db, 'live', 'answered', phone=None, date=222)
        stage(db, 'live', 'answered', phone='599654321', date=999, duration=99)
        self.assertEqual(db.execute('SELECT phone,occurred_at,duration_seconds FROM call_events').fetchall(), [(None, 222, 0)])
        stage(db, 'live', 'completed', phone='599123456', date=222, duration=8)
        self.assertEqual(db.execute('SELECT count(*) FROM call_events').fetchone()[0], 2)

    def test_stage_acknowledgment_and_counter_do_not_count_one_call_twice(self):
        db = fresh_db()
        stage(db, 'live', 'answered')
        stage(db, 'live', 'completed', duration=5)
        db.execute("UPDATE call_events SET delivered=1 WHERE event_id='live' AND phase='answered'")
        self.assertEqual(db.execute(query('SELECT COUNT(DISTINCT event_id) FROM call_events WHERE delivered=0')).fetchone()[0], 1)
        self.assertEqual(db.execute(query('SELECT COUNT(DISTINCT event_id) FROM call_events WHERE delivered=1')).fetchone()[0], 1)
        db.execute("UPDATE call_events SET delivered=1 WHERE phase='completed'")
        self.assertEqual(db.execute(query('SELECT COUNT(DISTINCT event_id) FROM call_events WHERE delivered=1')).fetchone()[0], 1)

    def test_links_are_one_to_one_and_log_id_reuse_keeps_date(self):
        db = fresh_db()
        db.execute("INSERT INTO call_log_links VALUES (10,100,'first')")
        db.execute("INSERT INTO call_log_links VALUES (10,200,'second')")
        db.execute("INSERT OR IGNORE INTO call_log_links VALUES (11,300,'first')")
        db.execute("INSERT OR IGNORE INTO call_log_links VALUES (10,100,'third')")
        self.assertEqual(db.execute('SELECT * FROM call_log_links ORDER BY log_date').fetchall(), [(10, 100, 'first'), (10, 200, 'second')])

    def test_telecom_handoff_guard_only_defers_plausible_unlinked_legacy_calls(self):
        db = fresh_db()
        sql = query("SELECT 1 FROM live_sessions s WHERE session_id NOT LIKE")
        params = ('1', '70000', '130000', '599123456', '599123456')
        db.execute("INSERT INTO live_sessions(session_id,event_id,sub_id,phone,ring_at,ring_elapsed,status) VALUES ('legacy','old-event',1,'599123456',100000,50,'answered')")
        self.assertIsNotNone(db.execute(sql, params).fetchone())
        self.assertIsNone(db.execute(sql, ('2', *params[1:])).fetchone())
        self.assertIsNone(db.execute(sql, (*params[:3], '599654321', '599654321')).fetchone())
        db.execute("INSERT INTO call_log_links VALUES (100,100000,'old-event')")
        self.assertIsNone(db.execute(sql, params).fetchone())
        # A Telecom-owned reservation is never mistaken for a legacy handoff.
        db.execute("UPDATE live_sessions SET session_id=?", ('telecom:' + 'a' * 64,))
        db.execute('DELETE FROM call_log_links')
        self.assertIsNone(db.execute(sql, params).fetchone())

    def test_late_telecom_rebind_does_not_replay_an_already_queued_journal_call(self):
        db = fresh_db()
        sql = query("SELECT 1 FROM call_events WHERE phase='completed' AND event_id NOT LIKE")
        params = ('98000', '102000', '599123456', '599123456')
        stage(db, 'android:installation:321:100000', 'completed', phone='599123456', date=100000, duration=15)
        self.assertIsNotNone(db.execute(sql, params).fetchone())
        self.assertIsNone(db.execute(sql, (*params[:2], '599654321', '599654321')).fetchone())
        db.execute('UPDATE call_events SET delivered=1,phone=NULL')
        self.assertIsNotNone(db.execute(sql, params).fetchone())
        # An acknowledgment scrubs the number but must still suppress a late duplicate.
        db.execute("UPDATE call_events SET event_id='android:installation:telecom:abc'")
        self.assertIsNone(db.execute(sql, params).fetchone())

    def test_monitor_restart_preserves_telecom_reservations_and_pending_answers(self):
        db = fresh_db()
        key = 'telecom:' + 'a' * 64
        db.execute("INSERT INTO live_sessions(session_id,event_id,sub_id,ring_at,ring_elapsed,status) VALUES (?,?,1,100,50,'ringing')", (key, 'telecom-event'))
        db.execute("INSERT INTO live_sessions(session_id,event_id,sub_id,ring_at,ring_elapsed,answer_at,status) VALUES ('legacy','legacy-event',1,100,50,120,'answered')")
        sql = re.search(r'getWritableDatabase\(\)\.execSQL\(\"([^\"\n]+)\"\)', body('markOpenSessionsGap'))
        db.execute(sql.group(1))
        rows = db.execute('SELECT session_id,status,gap FROM live_sessions ORDER BY session_id').fetchall()
        self.assertEqual(rows, [('legacy', 'answered', 1), (key, 'ringing', 0)])
        sessions = db.execute(query('SELECT session_id,event_id,sub_id')).fetchall()
        self.assertEqual(len(sessions), 2)
        self.assertEqual(next(row for row in sessions if row[0] == key)[6], -1)

    def test_ring_reservation_defers_log_until_answer_state_is_known(self):
        db = fresh_db()
        db.execute("INSERT INTO live_sessions(session_id,event_id,sub_id,ring_at,ring_elapsed,status) VALUES ('reserved','live',1,100,50,'ringing')")
        sessions = query('SELECT session_id,event_id,sub_id')
        self.assertEqual(db.execute(sessions).fetchone()[6], -1)
        # After an observation gap, an unanswered reservation must not block log recovery.
        sql = re.search(r'getWritableDatabase\(\)\.execSQL\("([^"\n]+)"\)', body('markOpenSessionsGap'))
        db.execute(sql.group(1))
        self.assertEqual(db.execute(sessions).fetchall(), [])

if __name__ == '__main__':
    unittest.main(verbosity=2)

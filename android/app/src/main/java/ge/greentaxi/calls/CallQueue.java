package ge.greentaxi.calls;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

final class CallQueue extends SQLiteOpenHelper {
    static final class Event {
        final String id;
        final String phone;
        final long occurredAt;
        final long duration;
        final int attempts;
        Event(String id, String phone, long occurredAt, long duration, int attempts) {
            this.id = id;
            this.phone = phone;
            this.occurredAt = occurredAt;
            this.duration = duration;
            this.attempts = attempts;
        }
    }

    CallQueue(Context context) { super(context, "call_queue.db", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE call_events (event_id TEXT PRIMARY KEY, phone TEXT, occurred_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, error_code TEXT)");
        db.execSQL("CREATE INDEX pending_calls ON call_events(delivered, next_try)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("No database migration for this version");
    }

    synchronized void enqueue(String id, String phone, long date, long duration) {
        ContentValues values = new ContentValues();
        values.put("event_id", id);
        if (phone == null) values.putNull("phone"); else values.put("phone", phone);
        values.put("occurred_at", date);
        values.put("duration_seconds", Math.max(0, duration));
        getWritableDatabase().insertWithOnConflict("call_events", null, values, SQLiteDatabase.CONFLICT_IGNORE);
    }

    synchronized int pendingCount() {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM call_events WHERE delivered = 0", null)) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    synchronized int deliveredCount() {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM call_events WHERE delivered = 1", null)) {
            return cursor.moveToFirst() ? cursor.getInt(0) : 0;
        }
    }

    synchronized List<Event> due(long now) {
        List<Event> events = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT event_id, phone, occurred_at, duration_seconds, attempts FROM call_events WHERE delivered = 0 AND next_try <= ? ORDER BY occurred_at LIMIT 20",
                new String[]{Long.toString(now)})) {
            while (cursor.moveToNext()) {
                events.add(new Event(cursor.getString(0), cursor.isNull(1) ? null : cursor.getString(1),
                        cursor.getLong(2), cursor.getLong(3), cursor.getInt(4)));
            }
        }
        return events;
    }

    synchronized void delivered(String id) {
        ContentValues values = new ContentValues();
        values.put("delivered", 1);
        values.putNull("phone");
        values.putNull("error_code");
        getWritableDatabase().update("call_events", values, "event_id = ?", new String[]{id});
    }

    synchronized void retry(Event event, String errorCode) {
        int attempt = Math.min(event.attempts + 1, 30);
        long delay = Math.min(15 * 60_000L, 30_000L * (1L << Math.min(attempt - 1, 5)));
        ContentValues values = new ContentValues();
        values.put("attempts", attempt);
        values.put("next_try", System.currentTimeMillis() + delay);
        values.put("error_code", errorCode);
        getWritableDatabase().update("call_events", values, "event_id = ?", new String[]{event.id});
    }
}

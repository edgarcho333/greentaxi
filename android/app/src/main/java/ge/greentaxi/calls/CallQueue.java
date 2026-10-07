package ge.greentaxi.calls;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.List;

final class CallQueue extends SQLiteOpenHelper {
    static final String ANSWERED = "answered";
    static final String COMPLETED = "completed";
    static final class Event {
        final String id, phone, phase;
        final long occurredAt, duration;
        final int attempts;
        final boolean legacyPayload;
        Event(String id, String phone, long date, long duration, int attempts, String phase, boolean legacyPayload) {
            this.id=id; this.phone=phone; this.occurredAt=date; this.duration=duration;
            this.attempts=attempts; this.phase=phase; this.legacyPayload=legacyPayload;
        }
    }
    CallQueue(Context context) { super(context, "call_queue.db", null, 2); }

    private static void createEvents(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE call_events (event_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('answered','completed')), phone TEXT, occurred_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, error_code TEXT, legacy_payload INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(event_id,phase))");
        db.execSQL("CREATE INDEX pending_calls ON call_events(delivered,next_try)");
    }
    private static void createLiveSessions(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE live_sessions (session_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, sub_id INTEGER NOT NULL, phone TEXT, ring_at INTEGER NOT NULL, ring_elapsed INTEGER NOT NULL, answer_at INTEGER NOT NULL DEFAULT -1, answer_elapsed INTEGER NOT NULL DEFAULT -1, end_at INTEGER NOT NULL DEFAULT -1, end_elapsed INTEGER NOT NULL DEFAULT -1, status TEXT NOT NULL, gap INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE call_log_links (log_id INTEGER NOT NULL, log_date INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, PRIMARY KEY(log_id,log_date))");
    }
    @Override public void onCreate(SQLiteDatabase db) { createEvents(db); createLiveSessions(db); }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion!=1 || newVersion!=2) throw new IllegalStateException("unsupported_queue_migration");
        db.execSQL("DROP INDEX pending_calls");
        db.execSQL("ALTER TABLE call_events RENAME TO call_events_v1");
        createEvents(db);
        // Preserve v1 event identities, immutable payloads, acknowledgments and retries.
        db.execSQL("INSERT INTO call_events(event_id,phase,phone,occurred_at,duration_seconds,delivered,attempts,next_try,error_code,legacy_payload) SELECT event_id,'completed',phone,occurred_at,duration_seconds,delivered,attempts,next_try,error_code,1 FROM call_events_v1");
        db.execSQL("DROP TABLE call_events_v1");
        createLiveSessions(db);
    }
    private static void enqueuePhase(SQLiteDatabase db,String id,String phase,String phone,long date,long duration) {
        ContentValues values=new ContentValues();
        values.put("event_id",id); values.put("phase",phase);
        if(phone==null) values.putNull("phone"); else values.put("phone",phone);
        values.put("occurred_at",date); values.put("duration_seconds",Math.max(0,duration));
        // A stage never changes while offline or awaiting retry.
        db.insertWithOnConflict("call_events",null,values,SQLiteDatabase.CONFLICT_IGNORE);
    }
    synchronized void enqueue(String id,String phone,long date,long duration) {
        enqueuePhase(getWritableDatabase(),id,COMPLETED,phone,date,duration);
    }
    synchronized void markOpenSessionsGap() {
        getWritableDatabase().execSQL("UPDATE live_sessions SET gap=1,status=CASE WHEN answer_at>=0 THEN 'answered' ELSE 'abandoned' END WHERE status IN ('ringing','answered')");
    }
    synchronized void liveAction(LiveCallState.Action action,String installationId) {
        SQLiteDatabase db=getWritableDatabase(); db.beginTransaction();
        try {
            String eventId="android:"+installationId+":live:"+action.sessionKey;
            ContentValues initial=new ContentValues();
            initial.put("session_id",action.sessionKey); initial.put("event_id",eventId); initial.put("sub_id",action.subId);
            if(action.phone==null) initial.putNull("phone"); else initial.put("phone",action.phone);
            initial.put("ring_at",action.ringAt); initial.put("ring_elapsed",action.ringElapsed); initial.put("status","ringing");
            db.insertWithOnConflict("live_sessions",null,initial,SQLiteDatabase.CONFLICT_IGNORE);
            if(action.phone!=null) db.execSQL("UPDATE live_sessions SET phone=COALESCE(phone,?) WHERE session_id=?",new Object[]{action.phone,action.sessionKey});
            if(action.answered) {
                // A later action also recovers an answer whose earlier local transaction failed.
                db.execSQL("UPDATE live_sessions SET answer_at=?,answer_elapsed=? WHERE session_id=? AND answer_at<0",new Object[]{action.answerAt,action.answerElapsed,action.sessionKey});
                enqueuePhase(db,eventId,ANSWERED,action.phone,action.ringAt,0);
            }
            if(action.kind==LiveCallState.Kind.ANSWER) {
                db.execSQL("UPDATE live_sessions SET status='answered' WHERE session_id=?",new Object[]{action.sessionKey});
            } else if(action.kind==LiveCallState.Kind.END) {
                db.execSQL("UPDATE live_sessions SET status=?,end_at=?,end_elapsed=? WHERE session_id=?",new Object[]{action.answered?"ended":"abandoned",action.endAt,action.endElapsed,action.sessionKey});
            } else if(action.kind==LiveCallState.Kind.ABANDON) {
                db.execSQL("UPDATE live_sessions SET status=?,gap=1 WHERE session_id=?",new Object[]{action.answered?"answered":"abandoned",action.sessionKey});
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    synchronized boolean linked(long logId,long date) {
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT 1 FROM call_log_links WHERE log_id=? AND log_date=?",new String[]{Long.toString(logId),Long.toString(date)})) {
            return cursor.moveToFirst();
        }
    }
    synchronized boolean containsEvent(String eventId) {
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT 1 FROM call_events WHERE event_id=? LIMIT 1",new String[]{eventId})) {
            return cursor.moveToFirst();
        }
    }
    synchronized List<CallReconciler.Session> unlinkedSessions() {
        List<CallReconciler.Session> sessions=new ArrayList<>();
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT session_id,event_id,sub_id,phone,ring_at,ring_elapsed,answer_at,answer_elapsed,end_at,end_elapsed,gap FROM live_sessions s WHERE status IN ('ringing','answered','ended') AND NOT EXISTS(SELECT 1 FROM call_log_links l WHERE l.event_id=s.event_id)",null)) {
            while(cursor.moveToNext()) sessions.add(new CallReconciler.Session(cursor.getString(0),cursor.getString(1),cursor.getInt(2),cursor.isNull(3)?null:cursor.getString(3),cursor.getLong(4),cursor.getLong(5),cursor.getLong(6),cursor.getLong(7),cursor.getLong(8),cursor.getLong(9),cursor.getInt(10)!=0));
        }
        return sessions;
    }
    synchronized boolean linkAndComplete(CallReconciler.Log log,CallReconciler.Session session) {
        SQLiteDatabase db=getWritableDatabase(); db.beginTransaction();
        try {
            ContentValues link=new ContentValues(); link.put("log_id",log.rowId); link.put("log_date",log.dateWall); link.put("event_id",session.eventId);
            if(db.insertWithOnConflict("call_log_links",null,link,SQLiteDatabase.CONFLICT_IGNORE)==-1) return false;
            String phone=session.phoneGE9!=null?session.phoneGE9:log.phoneGE9;
            enqueuePhase(db,session.eventId,COMPLETED,phone,session.ringWall,log.durationSeconds);
            db.setTransactionSuccessful(); return true;
        } finally { db.endTransaction(); }
    }
    synchronized int pendingCount() {
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT COUNT(DISTINCT event_id) FROM call_events WHERE delivered=0",null)) { return cursor.moveToFirst()?cursor.getInt(0):0; }
    }
    synchronized int deliveredCount() {
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT COUNT(DISTINCT event_id) FROM call_events WHERE delivered=1",null)) { return cursor.moveToFirst()?cursor.getInt(0):0; }
    }
    synchronized List<Event> due(long now) {
        List<Event> events=new ArrayList<>();
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT e.event_id,e.phone,e.occurred_at,e.duration_seconds,e.attempts,e.phase,e.legacy_payload FROM call_events e WHERE e.delivered=0 AND e.next_try<=? AND (e.phase='answered' OR NOT EXISTS(SELECT 1 FROM call_events a WHERE a.event_id=e.event_id AND a.phase='answered' AND a.delivered=0)) ORDER BY e.occurred_at,CASE e.phase WHEN 'answered' THEN 0 ELSE 1 END LIMIT 20",new String[]{Long.toString(now)})) {
            while(cursor.moveToNext()) events.add(new Event(cursor.getString(0),cursor.isNull(1)?null:cursor.getString(1),cursor.getLong(2),cursor.getLong(3),cursor.getInt(4),cursor.getString(5),cursor.getInt(6)!=0));
        }
        return events;
    }
    synchronized void delivered(Event event) {
        ContentValues values=new ContentValues(); values.put("delivered",1); values.putNull("phone"); values.putNull("error_code");
        SQLiteDatabase db=getWritableDatabase(); db.update("call_events",values,"event_id=? AND phase=?",new String[]{event.id,event.phase});
        if(COMPLETED.equals(event.phase)) db.execSQL("UPDATE live_sessions SET phone=NULL WHERE event_id=? AND EXISTS(SELECT 1 FROM call_log_links l WHERE l.event_id=live_sessions.event_id)",new Object[]{event.id});
    }
    synchronized void retry(Event event,String errorCode) {
        int attempt=Math.min(event.attempts+1,30); long delay=Math.min(15*60_000L,30_000L*(1L<<Math.min(attempt-1,5)));
        ContentValues values=new ContentValues(); values.put("attempts",attempt); values.put("next_try",System.currentTimeMillis()+delay); values.put("error_code",errorCode);
        getWritableDatabase().update("call_events",values,"event_id=? AND phase=? AND delivered=0",new String[]{event.id,event.phase});
    }
}

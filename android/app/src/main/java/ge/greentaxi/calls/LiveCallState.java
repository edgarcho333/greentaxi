package ge.greentaxi.calls;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Conservative interpretation of aggregate, per-subscription telephony states.
 * A new instance intentionally has no history: registration snapshots cannot
 * establish that an incoming call was answered during an observation gap.
 * Callbacks must carry timestamps captured when received, before asynchronous work.
 */
public final class LiveCallState {
    public static final int IDLE = 0;
    public static final int RINGING = 1;
    public static final int OFFHOOK = 2;
    private static final int UNKNOWN = -1;
    private static final long CLOCK_TOLERANCE_MS = 5_000;

    public enum Kind { RING, ANSWER, UPDATE, END, ABANDON }

    public static final class Action {
        public final Kind kind;
        public final int subId;
        public final String sessionKey;
        public final String phone;
        public final boolean answered;
        public final boolean allIncoming;
        public final boolean gap;
        public final long ringAt;
        public final long ringElapsed;
        public final long answerAt;
        public final long answerElapsed;
        public final long endAt;
        public final long endElapsed;
        public final long observedAt;
        public final long observedElapsed;

        private Action(Kind kind, Session session, long wall, long elapsed) {
            this.kind = kind;
            subId = session.subId;
            sessionKey = session.key;
            phone = session.phone;
            answered = session.answerElapsed >= 0;
            allIncoming = session.allIncoming;
            gap = session.ambiguous || kind == Kind.ABANDON;
            ringAt = session.ringAt;
            ringElapsed = session.ringElapsed;
            answerAt = session.answerAt;
            answerElapsed = session.answerElapsed;
            endAt = kind == Kind.END ? wall : -1;
            endElapsed = kind == Kind.END ? elapsed : -1;
            observedAt = wall;
            observedElapsed = elapsed;
        }
    }

    private static final class Session {
        final int subId;
        final String key;
        final long ringAt;
        final long ringElapsed;
        String phone;
        long answerAt = -1;
        long answerElapsed = -1;
        final boolean allIncoming;
        boolean ambiguous;

        Session(int subId, String key, String phone, long wall, long elapsed) {
            this(subId, key, phone, wall, elapsed, false, false);
        }

        Session(int subId, String key, String phone, long wall, long elapsed,
                boolean allIncoming, boolean ambiguous) {
            this.subId = subId;
            this.key = key;
            this.phone = phone;
            ringAt = wall;
            ringElapsed = elapsed;
            this.allIncoming = allIncoming;
            this.ambiguous = ambiguous;
        }

        boolean answered() { return answerElapsed >= 0; }
    }

    private static final class Line {
        int state = UNKNOWN;
        Session session;
        String conversationPhone;
    }

    private final Map<Integer, Line> lines = new TreeMap<>();
    private final Supplier<String> sessionKeys;
    private final boolean allIncoming;
    private long lastElapsed = -1;

    public LiveCallState(Collection<Integer> activeSubIds) {
        this(activeSubIds, () -> UUID.randomUUID().toString(), false);
    }

    public LiveCallState(Collection<Integer> activeSubIds, boolean allIncoming) {
        this(activeSubIds, () -> UUID.randomUUID().toString(), allIncoming);
    }

    /** The supplier permits deterministic tests; production uses random UUIDs. */
    public LiveCallState(Collection<Integer> activeSubIds, Supplier<String> sessionKeys) {
        this(activeSubIds, sessionKeys, false);
    }

    public LiveCallState(Collection<Integer> activeSubIds, Supplier<String> sessionKeys, boolean allIncoming) {
        this.sessionKeys = Objects.requireNonNull(sessionKeys, "sessionKeys");
        this.allIncoming = allIncoming;
        for (int subId : subscriptions(activeSubIds)) lines.put(subId, new Line());
    }

    /** A subscription change is an observation gap, even for the surviving SIM. */
    public synchronized List<Action> setSubscriptions(Collection<Integer> activeSubIds,
            long wall, long elapsed) {
        checkTime(wall, elapsed);
        Collection<Integer> next = subscriptions(activeSubIds);
        if (lines.keySet().equals(new TreeSet<>(next))) return Collections.emptyList();
        List<Action> actions = abandonAll(wall, elapsed);
        lines.clear();
        for (int subId : next) lines.put(subId, new Line());
        lastElapsed = Math.max(lastElapsed, elapsed);
        return immutable(actions);
    }

    public synchronized List<Action> onState(int subId, int state, String phone,
            long wall, long elapsed) {
        if (state < IDLE || state > OFFHOOK) throw new IllegalArgumentException("Unknown call state");
        checkTime(wall, elapsed);
        Line line = lines.get(subId);
        // A callback from a removed subscription cannot affect the new topology.
        if (line == null) return Collections.emptyList();
        if (elapsed < lastElapsed) {
            List<Action> actions = abandonAll(wall, elapsed);
            for (Line observed : lines.values()) observed.state = UNKNOWN;
            return immutable(actions);
        }
        lastElapsed = elapsed;
        List<Action> actions = new ArrayList<>();
        for (Line observed : lines.values()) {
            Session session = observed.session;
            if (session != null && clockChanged(session, wall, elapsed)) {
                abandon(observed, actions, wall, elapsed);
            }
        }

        boolean cleanBefore = allIdle();
        int previous = line.state;
        if (allIncoming) {
            if (state != IDLE) {
                for (Map.Entry<Integer, Line> other : lines.entrySet()) {
                    if (other.getKey() != subId && other.getValue().session != null
                            && !other.getValue().session.answered()) other.getValue().session.ambiguous = true;
                }
            }
            observeIncoming(line, subId, state, previous, knownPhone(phone), cleanBefore, wall, elapsed, actions);
            line.state = state;
            return immutable(actions);
        }
        if (state != IDLE) {
            for (Map.Entry<Integer, Line> entry : lines.entrySet()) {
                if (entry.getKey() != subId && entry.getValue().session != null
                        && !entry.getValue().session.answered()) {
                    abandon(entry.getValue(), actions, wall, elapsed);
                }
            }
        }

        String knownPhone = knownPhone(phone);
        Session session = line.session;
        if (session != null) {
            // Another ringing state during a conversation may be call waiting.
            if (session.answered() && state == RINGING) {
                abandon(line, actions, wall, elapsed);
            } else if (state != IDLE && session.phone != null && knownPhone != null
                    && !session.phone.equals(knownPhone)) {
                abandon(line, actions, wall, elapsed);
            } else {
                boolean enriched = state != IDLE && session.phone == null && knownPhone != null;
                if (enriched) session.phone = knownPhone;
                if (state == IDLE) {
                    actions.add(new Action(Kind.END, session, wall, elapsed));
                    line.session = null;
                } else if (!session.answered() && previous == RINGING && state == OFFHOOK) {
                    if (othersIdle(subId)) {
                        session.answerAt = wall;
                        session.answerElapsed = elapsed;
                        actions.add(new Action(Kind.ANSWER, session, wall, elapsed));
                    } else {
                        abandon(line, actions, wall, elapsed);
                    }
                } else if (enriched) {
                    actions.add(new Action(Kind.UPDATE, session, wall, elapsed));
                }
            }
        } else if (previous == IDLE && state == RINGING && cleanBefore) {
            String key = Objects.requireNonNull(sessionKeys.get(), "session key");
            if (key.isEmpty()) throw new IllegalStateException("Empty session key");
            line.session = new Session(subId, key, knownPhone, wall, elapsed);
            actions.add(new Action(Kind.RING, line.session, wall, elapsed));
        }
        line.state = state;
        return immutable(actions);
    }

    /** Ringing is useful evidence even when acceptance on the same SIM is ambiguous. */
    private void observeIncoming(Line line, int subId, int state, int previous, String phone,
            boolean cleanBefore, long wall, long elapsed, List<Action> actions) {
        Session session = line.session;
        if (session != null && state == RINGING && previous == OFFHOOK) {
            if (session.answered() && session.phone != null) line.conversationPhone = session.phone;
            abandon(line, actions, wall, elapsed);
            session = null;
        }
        // Samsung can repeat the active caller's number for a waiting-call callback.
        // Do not assign that stale number to a separate incoming card.
        if (state == RINGING && !cleanBefore && phone != null && phone.equals(line.conversationPhone)) phone = null;
        if (session == null) {
            // Remember a supplied active/outgoing number only as a stale-number filter.
            // OFFHOOK by itself never creates an incoming event or proves an answer.
            if (state == OFFHOOK && phone != null) line.conversationPhone = phone;
            // UNKNOWN is a registration snapshot, not proof of a new incoming call.
            // The journal can recover eligible post-baseline calls after they finish.
            if (state == RINGING && previous != UNKNOWN && previous != RINGING) {
                String key = Objects.requireNonNull(sessionKeys.get(), "session key");
                if (key.isEmpty()) throw new IllegalStateException("Empty session key");
                line.session = new Session(subId, key, phone, wall, elapsed, true, !cleanBefore);
                actions.add(new Action(Kind.RING, line.session, wall, elapsed));
            }
        } else if (state == IDLE) {
            actions.add(new Action(Kind.END, session, wall, elapsed));
            line.session = null;
        } else {
            boolean eligiblePhone = state == RINGING || !session.ambiguous;
            if (eligiblePhone && session.phone != null && phone != null && !session.phone.equals(phone)) {
                abandon(line, actions, wall, elapsed);
            } else {
                boolean enriched = eligiblePhone && session.phone == null && phone != null;
                if (enriched) session.phone = phone;
                if (!session.answered() && previous == RINGING && state == OFFHOOK
                        && !session.ambiguous && othersIdle(subId)) {
                    session.answerAt = wall;
                    session.answerElapsed = elapsed;
                    line.conversationPhone = session.phone;
                    actions.add(new Action(Kind.ANSWER, session, wall, elapsed));
                } else if (enriched) actions.add(new Action(Kind.UPDATE, session, wall, elapsed));
            }
        }
        if (state == IDLE) line.conversationPhone = null;
    }

    private boolean allIdle() {
        if (lines.isEmpty()) return false;
        for (Line line : lines.values()) if (line.state != IDLE) return false;
        return true;
    }

    private boolean othersIdle(int subId) {
        for (Map.Entry<Integer, Line> entry : lines.entrySet()) {
            if (entry.getKey() != subId && entry.getValue().state != IDLE) return false;
        }
        return true;
    }

    private List<Action> abandonAll(long wall, long elapsed) {
        List<Action> actions = new ArrayList<>();
        for (Line line : lines.values()) abandon(line, actions, wall, elapsed);
        return actions;
    }

    private static void abandon(Line line, List<Action> actions, long wall, long elapsed) {
        if (line.session == null) return;
        actions.add(new Action(Kind.ABANDON, line.session, wall, elapsed));
        line.session = null;
    }

    private static boolean clockChanged(Session session, long wall, long elapsed) {
        long difference = (wall - session.ringAt) - (elapsed - session.ringElapsed);
        return difference > CLOCK_TOLERANCE_MS || difference < -CLOCK_TOLERANCE_MS;
    }

    private static String knownPhone(String phone) {
        if (phone == null) return null;
        String trimmed = phone.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static Collection<Integer> subscriptions(Collection<Integer> activeSubIds) {
        Objects.requireNonNull(activeSubIds, "activeSubIds");
        TreeSet<Integer> result = new TreeSet<>();
        for (Integer subId : activeSubIds) {
            if (subId == null || subId < 0) throw new IllegalArgumentException("Invalid subscription");
            result.add(subId);
        }
        return result;
    }

    private static void checkTime(long wall, long elapsed) {
        if (wall < 0 || elapsed < 0) throw new IllegalArgumentException("Negative callback time");
    }

    private static List<Action> immutable(List<Action> actions) {
        return actions.isEmpty() ? Collections.emptyList() : Collections.unmodifiableList(actions);
    }
}

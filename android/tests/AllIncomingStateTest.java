package ge.greentaxi.calls;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/** Expanded policy still distinguishes observing ringing from proving acceptance. */
public final class AllIncomingStateTest {
    private static final long EPOCH=1_700_000_000_000L;
    private static int assertions;
    public static void main(String[] args) {
        ordinaryAndUnanswered(); waitingAndStaleNumber(); outgoingIsNotIncoming();
        initialSnapshots(); dualSim(); hiddenNumberEnrichment(); restartAndClockGap();
        System.out.println("AllIncomingStateTest passed ("+assertions+" assertions)");
    }
    private static LiveCallState helper(Integer... ids) {
        AtomicInteger keys=new AtomicInteger();
        return new LiveCallState(Arrays.asList(ids),()->"all-"+keys.incrementAndGet(),true);
    }
    private static List<LiveCallState.Action> at(LiveCallState h,int sub,int state,String phone,long t) {
        return h.onState(sub,state,phone,EPOCH+t,t);
    }
    private static void ordinaryAndUnanswered() {
        LiveCallState h=helper(1); empty(at(h,1,0,null,0));
        LiveCallState.Action ring=one(at(h,1,1,"599111111",10),LiveCallState.Kind.RING);
        check(ring.allIncoming&&!ring.answered&&!ring.gap);
        LiveCallState.Action end=one(at(h,1,0,null,30),LiveCallState.Kind.END);
        check(end.allIncoming&&!end.answered); equal(end.sessionKey,ring.sessionKey);
        // IDLE only ends observation. It never classifies missed/rejected.
        equal(end.answerAt,-1L);
        LiveCallState.Action second=one(at(h,1,1,"599111111",40),LiveCallState.Kind.RING);
        LiveCallState.Action answer=one(at(h,1,2,null,50),LiveCallState.Kind.ANSWER);
        check(answer.answered&&!answer.gap); equal(answer.sessionKey,second.sessionKey);
        check(!second.sessionKey.equals(ring.sessionKey));
    }
    private static void waitingAndStaleNumber() {
        LiveCallState h=helper(1); empty(at(h,1,0,null,0));
        one(at(h,1,1,"599111111",10),LiveCallState.Kind.RING);
        LiveCallState.Action first=one(at(h,1,2,null,20),LiveCallState.Kind.ANSWER);
        List<LiveCallState.Action> waiting=at(h,1,1,"599222222",30);
        equal(waiting.size(),2); equal(waiting.get(0).kind,LiveCallState.Kind.ABANDON);
        equal(waiting.get(0).sessionKey,first.sessionKey); check(waiting.get(0).answered);
        LiveCallState.Action second=waiting.get(1); equal(second.kind,LiveCallState.Kind.RING);
        equal(second.phone,"599222222"); check(second.gap&&!second.answered);
        // Answering or rejecting the waiting call produce the same aggregate OFFHOOK.
        empty(at(h,1,2,"599111111",40));
        LiveCallState.Action end=one(at(h,1,0,null,50),LiveCallState.Kind.END);
        equal(end.sessionKey,second.sessionKey); equal(end.phone,"599222222"); check(!end.answered);
        LiveCallState stale=helper(1); empty(at(stale,1,0,null,0));
        one(at(stale,1,1,"599111111",10),LiveCallState.Kind.RING);
        one(at(stale,1,2,null,20),LiveCallState.Kind.ANSWER);
        List<LiveCallState.Action> unknown=at(stale,1,1,"599111111",30);
        equal(unknown.size(),2); equal(unknown.get(1).phone,null);
        empty(at(stale,1,2,"599111111",40));
        LiveCallState.Action finalObservation=one(at(stale,1,0,null,50),LiveCallState.Kind.END);
        equal(finalObservation.phone,null); check(!finalObservation.answered);
    }
    private static void outgoingIsNotIncoming() {
        LiveCallState h=helper(1); empty(at(h,1,0,null,0));
        empty(at(h,1,2,"599111111",10));
        LiveCallState.Action waiting=one(at(h,1,1,"599111111",20),LiveCallState.Kind.RING);
        equal(waiting.phone,null); check(waiting.gap);
        empty(at(h,1,2,"599111111",30));
        LiveCallState.Action end=one(at(h,1,0,null,40),LiveCallState.Kind.END);
        check(!end.answered);
        empty(at(h,1,2,"599333333",50)); empty(at(h,1,0,null,60));
    }
    private static void initialSnapshots() {
        LiveCallState h=helper(1);
        empty(at(h,1,1,"599111111",0)); empty(at(h,1,2,null,10));
        empty(at(h,1,0,null,20));
        one(at(h,1,1,"599111111",30),LiveCallState.Kind.RING);
        one(at(h,1,2,null,40),LiveCallState.Kind.ANSWER);
    }
    private static void dualSim() {
        LiveCallState h=helper(1,2); empty(at(h,1,0,null,0)); empty(at(h,2,0,null,1));
        LiveCallState.Action first=one(at(h,1,1,"599111111",10),LiveCallState.Kind.RING);
        LiveCallState.Action second=one(at(h,2,1,"599222222",11),LiveCallState.Kind.RING);
        check(second.gap); check(!first.sessionKey.equals(second.sessionKey));
        empty(at(h,1,2,null,20)); empty(at(h,2,2,null,21));
        check(!one(at(h,1,0,null,30),LiveCallState.Kind.END).answered);
        check(!one(at(h,2,0,null,31),LiveCallState.Kind.END).answered);
    }
    private static void hiddenNumberEnrichment() {
        LiveCallState h=helper(1); empty(at(h,1,0,null,0));
        LiveCallState.Action ring=one(at(h,1,1,null,10),LiveCallState.Kind.RING);
        LiveCallState.Action enriched=one(at(h,1,1,"599111111",11),LiveCallState.Kind.UPDATE);
        equal(enriched.sessionKey,ring.sessionKey); equal(ring.phone,null);
        LiveCallState.Action answer=one(at(h,1,2,null,20),LiveCallState.Kind.ANSWER);
        equal(answer.phone,"599111111"); equal(answer.sessionKey,ring.sessionKey);
    }
    private static void restartAndClockGap() {
        LiveCallState h=helper(1); empty(at(h,1,0,null,0));
        LiveCallState.Action ring=one(at(h,1,1,"599111111",10),LiveCallState.Kind.RING);
        LiveCallState.Action gap=one(h.setSubscriptions(Arrays.asList(1,2),EPOCH+11,11),LiveCallState.Kind.ABANDON);
        equal(gap.sessionKey,ring.sessionKey); check(gap.allIncoming&&gap.gap&&!gap.answered);
        LiveCallState fresh=helper(1); empty(at(fresh,1,2,"599111111",20));
        empty(at(fresh,1,0,null,30));
    }
    private static LiveCallState.Action one(List<LiveCallState.Action> list,LiveCallState.Kind kind) {
        equal(list.size(),1); equal(list.get(0).kind,kind); return list.get(0);
    }
    private static void empty(List<?> value) { equal(value.size(),0); }
    private static void equal(Object actual,Object expected) { assertions++; if(!java.util.Objects.equals(actual,expected)) throw new AssertionError("Expected "+expected+", got "+actual); }
    private static void check(boolean value) { assertions++; if(!value) throw new AssertionError("Condition failed"); }
}

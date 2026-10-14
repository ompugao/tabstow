package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func newTestStore(t *testing.T) (*Store, *fakeClock, int64) {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	clock := &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	s.SetClock(clock.now)
	u, err := s.UpsertUser(context.Background(), "github", "1", "github:alice", "alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	return s, clock, u.ID
}

func tab(id string, updatedAt int64, title string) Record {
	data, _ := json.Marshal(map[string]string{"title": title})
	return Record{ID: id, Kind: "tab", UpdatedAt: updatedAt, Data: data}
}

func titleOf(t *testing.T, r Record) string {
	t.Helper()
	var d struct{ Title string }
	if err := json.Unmarshal(r.Data, &d); err != nil {
		t.Fatal(err)
	}
	return d.Title
}

func mustSync(t *testing.T, s *Store, user, since int64, changes ...Record) SyncResult {
	t.Helper()
	res, err := s.Sync(context.Background(), user, since, changes)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestSyncReturnsAcceptedChangesWithNewSeq(t *testing.T) {
	s, _, u := newTestStore(t)
	res := mustSync(t, s, u, 0, tab("a", 10, "A"), tab("b", 10, "B"))
	if res.Seq != 2 || len(res.Changes) != 2 || res.Changes[1].Seq != 2 {
		t.Fatalf("got %+v", res)
	}
}

func TestSyncReturnsOnlyChangesAfterSince(t *testing.T) {
	s, _, u := newTestStore(t)
	first := mustSync(t, s, u, 0, tab("a", 10, "A"))
	mustSync(t, s, u, first.Seq, tab("b", 10, "B"))
	res := mustSync(t, s, u, first.Seq)
	if len(res.Changes) != 1 || res.Changes[0].ID != "b" {
		t.Fatalf("got %+v", res.Changes)
	}
}

func TestNewerWriteWins(t *testing.T) {
	s, _, u := newTestStore(t)
	mustSync(t, s, u, 0, tab("a", 10, "old"))
	res := mustSync(t, s, u, 0, tab("a", 20, "new"))
	if got := titleOf(t, res.Changes[0]); got != "new" {
		t.Fatalf("title = %q", got)
	}
}

func TestOlderWriteIsRejectedAndServerVersionReturned(t *testing.T) {
	s, _, u := newTestStore(t)
	seen := mustSync(t, s, u, 0, tab("a", 20, "server"))
	res := mustSync(t, s, u, seen.Seq, tab("a", 10, "stale"))
	if res.Seq != seen.Seq {
		t.Fatalf("seq advanced on rejected write: %d", res.Seq)
	}
	if len(res.Changes) != 1 || titleOf(t, res.Changes[0]) != "server" {
		t.Fatalf("got %+v", res.Changes)
	}
}

func TestEqualTimestampIsRejected(t *testing.T) {
	s, _, u := newTestStore(t)
	mustSync(t, s, u, 0, tab("a", 10, "first"))
	res := mustSync(t, s, u, 1, tab("a", 10, "second"))
	if titleOf(t, res.Changes[0]) != "first" {
		t.Fatalf("got %+v", res.Changes)
	}
}

func TestTombstoneIsSyncedLikeAnyRecord(t *testing.T) {
	s, _, u := newTestStore(t)
	mustSync(t, s, u, 0, tab("a", 10, "A"))
	del := tab("a", 20, "A")
	del.Deleted = true
	res := mustSync(t, s, u, 1, del)
	if !res.Changes[0].Deleted {
		t.Fatalf("got %+v", res.Changes)
	}
}

func TestUsersDoNotSeeEachOthersRecords(t *testing.T) {
	s, _, alice := newTestStore(t)
	bob, _ := s.UpsertUser(context.Background(), "github", "2", "github:bob", "")
	mustSync(t, s, alice, 0, tab("a", 10, "A"))
	if res := mustSync(t, s, bob.ID, 0); len(res.Changes) != 0 {
		t.Fatalf("bob sees %+v", res.Changes)
	}
}

func TestInvalidKindIsRejected(t *testing.T) {
	s, _, u := newTestStore(t)
	r := tab("a", 1, "A")
	r.Kind = "bogus"
	if _, err := s.Sync(context.Background(), u, 0, []Record{r}); err == nil {
		t.Fatal("expected error")
	}
}

func TestSinceAheadOfServerForcesResync(t *testing.T) {
	s, _, u := newTestStore(t)
	mustSync(t, s, u, 0, tab("a", 10, "A"))
	res := mustSync(t, s, u, 99)
	if !res.Resync || len(res.Changes) != 1 {
		t.Fatalf("got %+v", res)
	}
}

func TestPurgeRemovesOldTombstonesAndForcesResyncForStaleClients(t *testing.T) {
	s, clock, u := newTestStore(t)
	mustSync(t, s, u, 0, tab("live", 10, "L"))
	del := tab("gone", 10, "G")
	del.Deleted = true
	mustSync(t, s, u, 1, del)

	clock.t = clock.t.Add(31 * 24 * time.Hour)
	if err := s.Purge(context.Background(), 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}

	stale := mustSync(t, s, u, 1)
	if !stale.Resync || len(stale.Changes) != 1 || stale.Changes[0].ID != "live" {
		t.Fatalf("stale client got %+v", stale)
	}
	current := mustSync(t, s, u, 2)
	if current.Resync {
		t.Fatal("up-to-date client must not resync")
	}
}

func TestPurgeKeepsRecentTombstones(t *testing.T) {
	s, clock, u := newTestStore(t)
	del := tab("gone", 10, "G")
	del.Deleted = true
	mustSync(t, s, u, 0, del)
	clock.t = clock.t.Add(24 * time.Hour)
	s.Purge(context.Background(), 30*24*time.Hour)
	if res := mustSync(t, s, u, 0); len(res.Changes) != 1 {
		t.Fatalf("got %+v", res.Changes)
	}
}

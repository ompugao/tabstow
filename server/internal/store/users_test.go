package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTokenAuthenticatesUntilExpiry(t *testing.T) {
	s, clock, u := newTestStore(t)
	ctx := context.Background()
	tok, err := s.CreateToken(ctx, u, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := s.UserByToken(ctx, tok); err != nil || got.ID != u {
		t.Fatalf("got %+v, %v", got, err)
	}
	clock.t = clock.t.Add(2 * time.Hour)
	if _, err := s.UserByToken(ctx, tok); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired token accepted: %v", err)
	}
}

func TestDeleteUserTokensRevokesAllSessions(t *testing.T) {
	s, _, u := newTestStore(t)
	ctx := context.Background()
	a, _ := s.CreateToken(ctx, u, time.Hour)
	b, _ := s.CreateToken(ctx, u, time.Hour)
	s.DeleteUserTokens(ctx, u)
	for _, tok := range []string{a, b} {
		if _, err := s.UserByToken(ctx, tok); !errors.Is(err, ErrNotFound) {
			t.Fatal("token still valid")
		}
	}
}

func TestStateCanBeTakenOnlyOnce(t *testing.T) {
	s, _, _ := newTestStore(t)
	ctx := context.Background()
	st, _ := s.CreateState(ctx, "github", "https://x/", time.Minute)
	if p, r, err := s.TakeState(ctx, st); err != nil || p != "github" || r != "https://x/" {
		t.Fatalf("got %q %q %v", p, r, err)
	}
	if _, _, err := s.TakeState(ctx, st); !errors.Is(err, ErrNotFound) {
		t.Fatal("state replayed")
	}
}

func TestUpsertUserKeepsIDForSameSubject(t *testing.T) {
	s, _, u := newTestStore(t)
	again, err := s.UpsertUser(context.Background(), "github", "1", "github:alice-renamed", "")
	if err != nil || again.ID != u {
		t.Fatalf("got %+v %v", again, err)
	}
}

func TestPendingStatesAreCapped(t *testing.T) {
	s, clock, _ := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < MaxPendingStates; i++ {
		if _, err := s.CreateState(ctx, "github", "https://x/", time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.CreateState(ctx, "github", "https://x/", time.Minute); !errors.Is(err, ErrTooManyStates) {
		t.Fatalf("got %v", err)
	}
	// Expired states no longer count.
	clock.t = clock.t.Add(2 * time.Minute)
	if _, err := s.CreateState(ctx, "github", "https://x/", time.Minute); err != nil {
		t.Fatal(err)
	}
}

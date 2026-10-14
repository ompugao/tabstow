package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"
)

type User struct {
	ID       int64  `json:"-"`
	Provider string `json:"provider"`
	Identity string `json:"identity"`
	Email    string `json:"email"`
}

func (s *Store) UpsertUser(ctx context.Context, provider, subject, identity, email string) (User, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO users (provider, subject, identity, email, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(provider, subject) DO UPDATE SET identity = excluded.identity, email = excluded.email
		RETURNING id`,
		provider, subject, identity, email, s.now().UnixMilli()).Scan(&id)
	if err != nil {
		return User{}, err
	}
	return User{ID: id, Provider: provider, Identity: identity, Email: email}, nil
}

// IdentityTakenByOtherSubject reports whether identity already belongs to a
// different account of the same provider. GitHub logins can be renamed and
// re-registered, so an allowlisted login must stay bound to its first owner.
func (s *Store) IdentityTakenByOtherSubject(ctx context.Context, provider, subject, identity string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM users WHERE provider = ? AND identity = ? AND subject != ?`,
		provider, identity, subject).Scan(&n)
	return n > 0, err
}

func randomToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateToken(ctx context.Context, userID int64, ttl time.Duration) (string, error) {
	token := randomToken()
	now := s.now()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO tokens (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		hashToken(token), userID, now.UnixMilli(), now.Add(ttl).UnixMilli())
	return token, err
}

func (s *Store) UserByToken(ctx context.Context, token string) (User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, `
		SELECT u.id, u.provider, u.identity, u.email FROM tokens t JOIN users u ON u.id = t.user_id
		WHERE t.hash = ? AND t.expires_at > ?`,
		hashToken(token), s.now().UnixMilli()).Scan(&u.ID, &u.Provider, &u.Identity, &u.Email)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	return u, err
}

func (s *Store) DeleteToken(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM tokens WHERE hash = ?`, hashToken(token))
	return err
}

func (s *Store) DeleteUserTokens(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM tokens WHERE user_id = ?`, userID)
	return err
}

// MaxPendingStates bounds the sign-in attempts in flight, so unauthenticated
// requests to /auth/{provider}/start cannot grow the database without limit.
const MaxPendingStates = 1000

var ErrTooManyStates = errors.New("too many pending sign-in attempts")

func (s *Store) CreateState(ctx context.Context, provider, redirect string, ttl time.Duration) (string, error) {
	now := s.now().UnixMilli()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM oauth_states WHERE expires_at <= ?`, now); err != nil {
		return "", err
	}
	var pending int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM oauth_states`).Scan(&pending); err != nil {
		return "", err
	}
	if pending >= MaxPendingStates {
		return "", ErrTooManyStates
	}
	state := randomToken()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO oauth_states (state, provider, redirect, expires_at) VALUES (?, ?, ?, ?)`,
		state, provider, redirect, s.now().Add(ttl).UnixMilli())
	return state, err
}

// TakeState consumes a state so a callback URL cannot be replayed.
func (s *Store) TakeState(ctx context.Context, state string) (provider, redirect string, err error) {
	err = s.db.QueryRowContext(ctx,
		`DELETE FROM oauth_states WHERE state = ? AND expires_at > ? RETURNING provider, redirect`,
		state, s.now().UnixMilli()).Scan(&provider, &redirect)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return provider, redirect, err
}

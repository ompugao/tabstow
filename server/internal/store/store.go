package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite serializes writers anyway; one connection avoids SQLITE_BUSY and
	// keeps ":memory:" databases shared across calls.
	db.SetMaxOpenConns(1)
	s := &Store{db: db, now: time.Now}
	if err := s.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) SetClock(now func() time.Time) { s.now = now }

var migrations = []string{
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		provider TEXT NOT NULL,
		subject TEXT NOT NULL,
		identity TEXT NOT NULL,
		email TEXT NOT NULL DEFAULT '',
		last_seq INTEGER NOT NULL DEFAULT 0,
		purged_seq INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		UNIQUE(provider, subject)
	);
	CREATE TABLE tokens (
		hash TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE TABLE oauth_states (
		state TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		redirect TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE TABLE records (
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		kind TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		deleted INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		stored_at INTEGER NOT NULL,
		data TEXT NOT NULL,
		PRIMARY KEY(user_id, id)
	);
	CREATE INDEX records_user_seq ON records(user_id, seq);`,
}

func (s *Store) migrate(ctx context.Context) error {
	var version int
	if err := s.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

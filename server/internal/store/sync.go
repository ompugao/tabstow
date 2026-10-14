package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	MaxIDLength   = 64
	MaxDataLength = 64 * 1024
)

var validKinds = map[string]bool{"device": true, "group": true, "tab": true}

type Record struct {
	ID        string          `json:"id"`
	Kind      string          `json:"kind"`
	UpdatedAt int64           `json:"updatedAt"`
	Deleted   bool            `json:"deleted"`
	Seq       int64           `json:"seq,omitempty"`
	Data      json.RawMessage `json:"data"`
}

type SyncResult struct {
	Seq     int64    `json:"seq"`
	Changes []Record `json:"changes"`
	Resync  bool     `json:"resync,omitempty"`
}

type ValidationError struct{ Msg string }

func (e ValidationError) Error() string { return e.Msg }

func validate(r Record) error {
	if r.ID == "" || len(r.ID) > MaxIDLength {
		return ValidationError{fmt.Sprintf("record id must be 1..%d characters", MaxIDLength)}
	}
	if !validKinds[r.Kind] {
		return ValidationError{fmt.Sprintf("record %s: unknown kind %q", r.ID, r.Kind)}
	}
	if len(r.Data) > MaxDataLength {
		return ValidationError{fmt.Sprintf("record %s: data too large", r.ID)}
	}
	if len(r.Data) == 0 {
		return ValidationError{fmt.Sprintf("record %s: missing data", r.ID)}
	}
	return nil
}

// Sync stores the incoming changes with last-write-wins on UpdatedAt and returns
// every record changed after `since`. Rejected changes are answered with the
// server's current version so the client converges even if it already saw that
// version's seq.
func (s *Store) Sync(ctx context.Context, userID, since int64, changes []Record) (SyncResult, error) {
	for _, r := range changes {
		if err := validate(r); err != nil {
			return SyncResult{}, err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SyncResult{}, err
	}
	defer tx.Rollback()

	var lastSeq, purgedSeq int64
	if err := tx.QueryRowContext(ctx, `SELECT last_seq, purged_seq FROM users WHERE id = ?`, userID).
		Scan(&lastSeq, &purgedSeq); err != nil {
		return SyncResult{}, err
	}
	resync := since < 0 || since > lastSeq || (since > 0 && since < purgedSeq)
	if resync {
		since = 0
	}

	storedAt := s.now().UnixMilli()
	var rejected []string
	for _, r := range changes {
		var existing int64
		err := tx.QueryRowContext(ctx, `SELECT updated_at FROM records WHERE user_id = ? AND id = ?`, userID, r.ID).Scan(&existing)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return SyncResult{}, err
		case r.UpdatedAt <= existing:
			rejected = append(rejected, r.ID)
			continue
		}
		lastSeq++
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO records (user_id, id, kind, updated_at, deleted, seq, stored_at, data)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at,
				deleted = excluded.deleted, seq = excluded.seq, stored_at = excluded.stored_at, data = excluded.data`,
			userID, r.ID, r.Kind, r.UpdatedAt, r.Deleted, lastSeq, storedAt, string(r.Data)); err != nil {
			return SyncResult{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET last_seq = ? WHERE id = ?`, lastSeq, userID); err != nil {
		return SyncResult{}, err
	}

	out, err := queryRecords(ctx, tx, `SELECT id, kind, updated_at, deleted, seq, data FROM records
		WHERE user_id = ? AND seq > ? ORDER BY seq`, userID, since)
	if err != nil {
		return SyncResult{}, err
	}
	for _, id := range rejected {
		r, err := queryRecords(ctx, tx, `SELECT id, kind, updated_at, deleted, seq, data FROM records
			WHERE user_id = ? AND id = ? AND seq <= ?`, userID, id, since)
		if err != nil {
			return SyncResult{}, err
		}
		out = append(out, r...)
	}
	if err := tx.Commit(); err != nil {
		return SyncResult{}, err
	}
	return SyncResult{Seq: lastSeq, Changes: out, Resync: resync}, nil
}

func queryRecords(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]Record, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Record{}
	for rows.Next() {
		var r Record
		var data string
		if err := rows.Scan(&r.ID, &r.Kind, &r.UpdatedAt, &r.Deleted, &r.Seq, &data); err != nil {
			return nil, err
		}
		r.Data = json.RawMessage(data)
		out = append(out, r)
	}
	return out, rows.Err()
}

// Purge drops tombstones stored before now-tombstoneTTL and raises each user's
// purge watermark, so clients that synced before it are told to resync instead
// of silently missing deletions. Expired tokens and OAuth states go too.
func (s *Store) Purge(ctx context.Context, tombstoneTTL time.Duration) error {
	now := s.now()
	cutoff := now.Add(-tombstoneTTL).UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmts := []struct {
		q    string
		args []any
	}{
		{`UPDATE users SET purged_seq = MAX(purged_seq, COALESCE(
			(SELECT MAX(seq) FROM records r WHERE r.user_id = users.id AND r.deleted = 1 AND r.stored_at < ?), 0))`, []any{cutoff}},
		{`DELETE FROM records WHERE deleted = 1 AND stored_at < ?`, []any{cutoff}},
		{`DELETE FROM tokens WHERE expires_at <= ?`, []any{now.UnixMilli()}},
		{`DELETE FROM oauth_states WHERE expires_at <= ?`, []any{now.UnixMilli()}},
	}
	for _, st := range stmts {
		if _, err := tx.ExecContext(ctx, st.q, st.args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

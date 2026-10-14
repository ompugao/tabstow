package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ompugao/tabstow/server/internal/auth"
	"github.com/ompugao/tabstow/server/internal/store"
)

const (
	maxBodyBytes      = 8 << 20
	maxChangesPerSync = 5000
	stateTTL          = 10 * time.Minute
)

type Server struct {
	Store     *store.Store
	Providers []auth.Provider
	Allow     auth.Allowlist
	// ExtensionIDs are the extensions allowed to receive sign-in tokens. Without
	// this, any installed extension could run the sign-in flow for itself.
	ExtensionIDs map[string]bool
	TokenTTL     time.Duration
	DevToken     string
	Log          *slog.Logger
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", handleLanding)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /auth/providers", s.handleProviders)
	mux.HandleFunc("GET /auth/{provider}/start", s.handleStart)
	mux.HandleFunc("GET /auth/{provider}/callback", s.handleCallback)
	mux.Handle("GET /api/me", s.authed(s.handleMe))
	mux.Handle("POST /api/sync", s.authed(s.handleSync))
	mux.Handle("POST /api/logout", s.authed(s.handleLogout))
	mux.Handle("POST /api/logout_all", s.authed(s.handleLogoutAll))
	return mux
}

func (s *Server) provider(name string) auth.Provider {
	for _, p := range s.Providers {
		if p.Name() == name {
			return p
		}
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	for _, p := range s.Providers {
		names = append(names, p.Name())
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": names})
}

func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	p := s.provider(r.PathValue("provider"))
	if p == nil {
		http.Error(w, "unknown provider", http.StatusNotFound)
		return
	}
	redirect := r.URL.Query().Get("redirect")
	extID, ok := auth.ExtensionIDFromRedirect(redirect)
	if !ok {
		http.Error(w, "invalid redirect", http.StatusBadRequest)
		return
	}
	if !s.ExtensionIDs[extID] {
		s.Log.Warn("sign-in from an extension not in EXTENSION_IDS", "extension_id", extID)
		http.Error(w, "this extension is not allowed to sign in; add its ID to EXTENSION_IDS on the server", http.StatusForbidden)
		return
	}
	state, err := s.Store.CreateState(r.Context(), p.Name(), redirect, stateTTL)
	if errors.Is(err, store.ErrTooManyStates) {
		http.Error(w, "too many sign-in attempts, try again later", http.StatusTooManyRequests)
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	target, err := p.AuthURL(r.Context(), state)
	if err != nil {
		s.Log.Error("auth url", "provider", p.Name(), "err", err)
		http.Error(w, "identity provider unavailable", http.StatusBadGateway)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func redirectWithFragment(w http.ResponseWriter, r *http.Request, redirect string, values url.Values) {
	http.Redirect(w, r, redirect+"#"+values.Encode(), http.StatusFound)
}

func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name := r.PathValue("provider")
	providerName, redirect, err := s.Store.TakeState(r.Context(), q.Get("state"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && providerName != name) {
		http.Error(w, "invalid or expired sign-in attempt, please try again", http.StatusBadRequest)
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	p := s.provider(name)
	if p == nil {
		http.Error(w, "unknown provider", http.StatusNotFound)
		return
	}
	if e := q.Get("error"); e != "" {
		redirectWithFragment(w, r, redirect, url.Values{"error": {e}})
		return
	}
	id, err := p.Exchange(r.Context(), q.Get("code"))
	if err != nil {
		s.Log.Warn("oauth exchange failed", "provider", name, "err", err)
		redirectWithFragment(w, r, redirect, url.Values{"error": {"exchange_failed"}})
		return
	}
	if !s.Allow.Allows(id) {
		s.Log.Warn("sign-in rejected by allowlist", "identity", id.AllowlistKey())
		redirectWithFragment(w, r, redirect, url.Values{"error": {"not_allowed"}, "identity": {id.AllowlistKey()}})
		return
	}
	taken, err := s.Store.IdentityTakenByOtherSubject(r.Context(), id.Provider, id.Subject, id.AllowlistKey())
	if err != nil {
		s.internalError(w, err)
		return
	}
	if taken {
		s.Log.Warn("sign-in rejected: identity belongs to another account", "identity", id.AllowlistKey(), "subject", id.Subject)
		redirectWithFragment(w, r, redirect, url.Values{"error": {"not_allowed"}, "identity": {id.AllowlistKey()}})
		return
	}
	user, err := s.Store.UpsertUser(r.Context(), id.Provider, id.Subject, id.AllowlistKey(), id.Email)
	if err != nil {
		s.internalError(w, err)
		return
	}
	token, err := s.Store.CreateToken(r.Context(), user.ID, s.TokenTTL)
	if err != nil {
		s.internalError(w, err)
		return
	}
	s.Log.Info("signed in", "identity", user.Identity)
	redirectWithFragment(w, r, redirect, url.Values{"token": {token}})
}

type ctxKey struct{}

type session struct {
	user  store.User
	token string
}

func (s *Server) authed(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || token == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		user, err := s.lookup(r.Context(), token)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		if err != nil {
			s.internalError(w, err)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKey{}, session{user: user, token: token})
		next(w, r.WithContext(ctx))
	})
}

func (s *Server) lookup(ctx context.Context, token string) (store.User, error) {
	if s.DevToken != "" && token == s.DevToken {
		return s.Store.UpsertUser(ctx, "dev", "local", "dev:local", "")
	}
	user, err := s.Store.UserByToken(ctx, token)
	// Removing someone from ALLOWLIST must also end their existing sessions.
	if err == nil && !s.Allow[user.Identity] {
		return store.User{}, store.ErrNotFound
	}
	return user, err
}

func sessionFrom(r *http.Request) session { return r.Context().Value(ctxKey{}).(session) }

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, sessionFrom(r).user)
}

type syncRequest struct {
	Since   int64          `json:"since"`
	Changes []store.Record `json:"changes"`
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if len(req.Changes) > maxChangesPerSync {
		writeError(w, http.StatusRequestEntityTooLarge, "too many changes in one request")
		return
	}
	res, err := s.Store.Sync(r.Context(), sessionFrom(r).user.ID, req.Since, req.Changes)
	var verr store.ValidationError
	if errors.As(err, &verr) {
		writeError(w, http.StatusBadRequest, verr.Msg)
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DeleteToken(r.Context(), sessionFrom(r).token); err != nil {
		s.internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request) {
	if err := s.Store.DeleteUserTokens(r.Context(), sessionFrom(r).user.ID); err != nil {
		s.internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) internalError(w http.ResponseWriter, err error) {
	s.Log.Error("internal error", "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

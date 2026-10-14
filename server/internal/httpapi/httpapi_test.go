package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ompugao/tabstow/server/internal/auth"
	"github.com/ompugao/tabstow/server/internal/store"
)

const extRedirect = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/"

type fakeProvider struct{ id auth.Identity }

func (f fakeProvider) Name() string { return f.id.Provider }
func (f fakeProvider) AuthURL(_ context.Context, state string) (string, error) {
	return "https://idp.example/authorize?state=" + url.QueryEscape(state), nil
}
func (f fakeProvider) Exchange(context.Context, string) (auth.Identity, error) { return f.id, nil }

func newTestServer(t *testing.T, allow string, id auth.Identity) *httptest.Server {
	t.Helper()
	_, srv := newTestAPI(t, allow, id)
	return srv
}

func newTestAPI(t *testing.T, allow string, id auth.Identity) (*Server, *httptest.Server) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	s := &Server{
		Store:        st,
		Providers:    []auth.Provider{fakeProvider{id}},
		Allow:        auth.ParseAllowlist(allow),
		ExtensionIDs: map[string]bool{"abcdefghijklmnopabcdefghijklmnop": true},
		TokenTTL:     time.Hour,
		Log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return s, srv
}

var noFollow = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// signIn walks start -> provider -> callback and returns the fragment values
// the extension would receive.
func signIn(t *testing.T, srv *httptest.Server, provider string) url.Values {
	t.Helper()
	resp, err := noFollow.Get(srv.URL + "/auth/" + provider + "/start?redirect=" + url.QueryEscape(extRedirect))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("start: %s", resp.Status)
	}
	idp, _ := url.Parse(resp.Header.Get("Location"))
	state := idp.Query().Get("state")

	resp, err = noFollow.Get(srv.URL + "/auth/" + provider + "/callback?code=c&state=" + url.QueryEscape(state))
	if err != nil {
		t.Fatal(err)
	}
	loc := resp.Header.Get("Location")
	if !strings.HasPrefix(loc, extRedirect+"#") {
		t.Fatalf("callback redirected to %q (%s)", loc, resp.Status)
	}
	frag, _ := url.ParseQuery(strings.TrimPrefix(loc, extRedirect+"#"))
	return frag
}

func call(t *testing.T, srv *httptest.Server, method, path, token string, body any) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, srv.URL+path, r)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

var alice = auth.Identity{Provider: "github", Subject: "1", Login: "alice", Email: "alice@example.com"}

func TestAllowlistedUserSignsInAndSyncs(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	token := signIn(t, srv, "github").Get("token")
	if token == "" {
		t.Fatal("no token")
	}

	resp := call(t, srv, "GET", "/api/me", token, nil)
	var me store.User
	json.NewDecoder(resp.Body).Decode(&me)
	if me.Identity != "github:alice" {
		t.Fatalf("me = %+v", me)
	}

	body := map[string]any{"since": 0, "changes": []map[string]any{
		{"id": "t1", "kind": "tab", "updatedAt": 1, "deleted": false, "data": map[string]string{"url": "https://example.com"}},
	}}
	resp = call(t, srv, "POST", "/api/sync", token, body)
	var res store.SyncResult
	json.NewDecoder(resp.Body).Decode(&res)
	if resp.StatusCode != 200 || res.Seq != 1 || len(res.Changes) != 1 {
		t.Fatalf("sync: %s %+v", resp.Status, res)
	}
}

func TestUserNotInAllowlistGetsErrorInsteadOfToken(t *testing.T) {
	srv := newTestServer(t, "github:bob", alice)
	frag := signIn(t, srv, "github")
	if frag.Get("token") != "" || frag.Get("error") != "not_allowed" || frag.Get("identity") != "github:alice" {
		t.Fatalf("fragment = %v", frag)
	}
}

func TestStartRejectsNonExtensionRedirect(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	resp, _ := noFollow.Get(srv.URL + "/auth/github/start?redirect=" + url.QueryEscape("https://evil.example/"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestCallbackRejectsUnknownState(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	resp, _ := noFollow.Get(srv.URL + "/auth/github/callback?code=c&state=forged")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestAPIRequiresToken(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	if resp := call(t, srv, "GET", "/api/me", "", nil); resp.StatusCode != 401 {
		t.Fatalf("no token: %s", resp.Status)
	}
	if resp := call(t, srv, "GET", "/api/me", "bogus", nil); resp.StatusCode != 401 {
		t.Fatalf("bad token: %s", resp.Status)
	}
}

func TestLogoutRevokesToken(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	token := signIn(t, srv, "github").Get("token")
	call(t, srv, "POST", "/api/logout", token, nil)
	if resp := call(t, srv, "GET", "/api/me", token, nil); resp.StatusCode != 401 {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestLogoutAllRevokesEverySession(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	a := signIn(t, srv, "github").Get("token")
	b := signIn(t, srv, "github").Get("token")
	call(t, srv, "POST", "/api/logout_all", a, nil)
	if resp := call(t, srv, "GET", "/api/me", b, nil); resp.StatusCode != 401 {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestProvidersListsEnabledProviders(t *testing.T) {
	srv := newTestServer(t, "", alice)
	resp := call(t, srv, "GET", "/auth/providers", "", nil)
	var got struct{ Providers []string }
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got.Providers) != 1 || got.Providers[0] != "github" {
		t.Fatalf("got %+v", got)
	}
}

func TestSyncRejectsInvalidRecord(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	token := signIn(t, srv, "github").Get("token")
	body := map[string]any{"since": 0, "changes": []map[string]any{{"id": "x", "kind": "bogus", "updatedAt": 1, "data": map[string]any{}}}}
	if resp := call(t, srv, "POST", "/api/sync", token, body); resp.StatusCode != 400 {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestLandingPage(t *testing.T) {
	srv := newTestServer(t, "", auth.Identity{Provider: "github", Subject: "1"})
	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "Tabstow") {
		t.Fatalf("GET /: %s %q", resp.Status, body)
	}
	resp, err = http.Get(srv.URL + "/nope")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /nope: %s", resp.Status)
	}
}

func TestStartRejectsExtensionNotInExtensionIDs(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	other := "https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/"
	resp, _ := noFollow.Get(srv.URL + "/auth/github/start?redirect=" + url.QueryEscape(other))
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestStartRejectsOverlongRedirect(t *testing.T) {
	srv := newTestServer(t, "github:alice", alice)
	long := extRedirect + strings.Repeat("a", 1000)
	resp, _ := noFollow.Get(srv.URL + "/auth/github/start?redirect=" + url.QueryEscape(long))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %s", resp.Status)
	}
}

func TestRemovingUserFromAllowlistEndsTheirSessions(t *testing.T) {
	api, srv := newTestAPI(t, "github:alice", alice)
	token := signIn(t, srv, "github").Get("token")
	api.Allow = auth.ParseAllowlist("")
	if resp := call(t, srv, "GET", "/api/me", token, nil); resp.StatusCode != 401 {
		t.Fatalf("got %s", resp.Status)
	}
}

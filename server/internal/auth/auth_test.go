package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/oauth2"
)

func TestAllowlistMatchesGitHubByLoginCaseInsensitively(t *testing.T) {
	a := ParseAllowlist(" GitHub:Alice , google:bob@example.com")
	if !a.Allows(Identity{Provider: "github", Login: "alice", Email: "x@y"}) {
		t.Fatal("alice should be allowed")
	}
}

func TestAllowlistMatchesOtherProvidersByEmail(t *testing.T) {
	a := ParseAllowlist("google:bob@example.com")
	if !a.Allows(Identity{Provider: "google", Email: "Bob@Example.com"}) {
		t.Fatal("bob should be allowed")
	}
}

func TestAllowlistEntryIsBoundToItsProvider(t *testing.T) {
	a := ParseAllowlist("google:bob@example.com")
	if a.Allows(Identity{Provider: "oidc", Email: "bob@example.com"}) {
		t.Fatal("oidc identity must not match a google entry")
	}
}

func TestEmptyAllowlistAllowsNobody(t *testing.T) {
	if ParseAllowlist("").Allows(Identity{Provider: "github", Login: "alice"}) {
		t.Fatal("empty allowlist must reject")
	}
}

func TestValidRedirectAcceptsOnlyChromiumAppURLs(t *testing.T) {
	cases := map[string]bool{
		"https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/":      true,
		"https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb":    true,
		"https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil/": false,
		"https://evil.example.com/":                                      false,
		"http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/":       false,
		"https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#x":    false,
	}
	for url, want := range cases {
		if got := ValidRedirect(url); got != want {
			t.Errorf("ValidRedirect(%q) = %v, want %v", url, got, want)
		}
	}
}

func TestGitHubExchangeUsesVerifiedPrimaryEmail(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"t","token_type":"bearer"}`))
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "alice"})
	})
	mux.HandleFunc("GET /user/emails", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"email": "old@example.com", "primary": false, "verified": true},
			{"email": "alice@example.com", "primary": true, "verified": true},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	g := NewGitHub("id", "secret", "http://localhost/cb")
	g.Config.Endpoint = oauth2.Endpoint{AuthURL: srv.URL + "/authorize", TokenURL: srv.URL + "/token"}
	g.APIBase = srv.URL

	id, err := g.Exchange(context.Background(), "code")
	if err != nil {
		t.Fatal(err)
	}
	want := Identity{Provider: "github", Subject: "42", Login: "alice", Email: "alice@example.com"}
	if id != want {
		t.Fatalf("got %+v", id)
	}
}

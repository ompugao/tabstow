package auth

import (
	"context"
	"regexp"
	"strings"
)

type Identity struct {
	Provider string
	Subject  string
	Login    string
	Email    string
}

// AllowlistKey is the string an allowlist entry must match. GitHub uses the
// login because many GitHub users hide their email address.
func (i Identity) AllowlistKey() string {
	if i.Provider == "github" {
		return "github:" + strings.ToLower(i.Login)
	}
	return i.Provider + ":" + strings.ToLower(i.Email)
}

type Provider interface {
	Name() string
	AuthURL(ctx context.Context, state string) (string, error)
	Exchange(ctx context.Context, code string) (Identity, error)
}

type Allowlist map[string]bool

func ParseAllowlist(s string) Allowlist {
	a := Allowlist{}
	for _, e := range strings.Split(s, ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			a[e] = true
		}
	}
	return a
}

func (a Allowlist) Allows(id Identity) bool { return a[id.AllowlistKey()] }

var chromiumRedirect = regexp.MustCompile(`^https://[a-p]{32}\.chromiumapp\.org/[^#]*$`)

// ValidRedirect accepts only chrome.identity redirect URLs, so the token can be
// delivered to an extension but never to an arbitrary website.
func ValidRedirect(s string) bool { return chromiumRedirect.MatchString(s) }

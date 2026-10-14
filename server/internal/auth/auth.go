package auth

import (
	"context"
	"fmt"
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

var chromiumRedirect = regexp.MustCompile(`^https://([a-p]{32})\.chromiumapp\.org/[A-Za-z0-9._~/-]{0,64}$`)

// ExtensionIDFromRedirect accepts only short chrome.identity redirect URLs, so
// the token can be delivered to an extension but never to an arbitrary website,
// and returns the extension ID the URL belongs to.
func ExtensionIDFromRedirect(s string) (string, bool) {
	m := chromiumRedirect.FindStringSubmatch(s)
	if m == nil {
		return "", false
	}
	return m[1], true
}

var extensionID = regexp.MustCompile(`^[a-p]{32}$`)

// ParseExtensionIDs parses a comma-separated list of Chrome extension IDs.
func ParseExtensionIDs(s string) (map[string]bool, error) {
	ids := map[string]bool{}
	for _, e := range strings.Split(s, ",") {
		if e = strings.TrimSpace(e); e == "" {
			continue
		}
		if !extensionID.MatchString(e) {
			return nil, fmt.Errorf("%q is not a Chrome extension ID (32 letters a-p)", e)
		}
		ids[e] = true
	}
	return ids, nil
}

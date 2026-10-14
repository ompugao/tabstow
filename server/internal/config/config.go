package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	ListenAddr   string
	DBPath       string
	BaseURL      string
	Allowlist    string
	TokenTTL     time.Duration
	TombstoneTTL time.Duration
	DevToken     string
	ExtensionIDs string

	GitHubClientID, GitHubClientSecret   string
	GoogleClientID, GoogleClientSecret   string
	OIDCIssuer, OIDCClientID, OIDCSecret string
}

func Load(getenv func(string) string) (Config, error) {
	get := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}
	c := Config{
		ListenAddr:         get("LISTEN_ADDR", ":8080"),
		DBPath:             get("DB_PATH", "tabstow.db"),
		BaseURL:            strings.TrimRight(getenv("BASE_URL"), "/"),
		Allowlist:          getenv("ALLOWLIST"),
		DevToken:           getenv("DEV_TOKEN"),
		ExtensionIDs:       getenv("EXTENSION_IDS"),
		GitHubClientID:     getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret: getenv("GITHUB_CLIENT_SECRET"),
		GoogleClientID:     getenv("GOOGLE_CLIENT_ID"),
		GoogleClientSecret: getenv("GOOGLE_CLIENT_SECRET"),
		OIDCIssuer:         getenv("OIDC_ISSUER"),
		OIDCClientID:       getenv("OIDC_CLIENT_ID"),
		OIDCSecret:         getenv("OIDC_CLIENT_SECRET"),
	}
	var err error
	if c.TokenTTL, err = time.ParseDuration(get("TOKEN_TTL", "8760h")); err != nil {
		return c, fmt.Errorf("TOKEN_TTL: %w", err)
	}
	if c.TombstoneTTL, err = time.ParseDuration(get("TOMBSTONE_TTL", "720h")); err != nil {
		return c, fmt.Errorf("TOMBSTONE_TTL: %w", err)
	}
	base, err := url.Parse(c.BaseURL)
	if c.BaseURL == "" || err != nil || base.Host == "" {
		return c, errors.New("BASE_URL must be the public URL of this server, e.g. https://tabs.example.com")
	}
	if c.DevToken != "" && base.Hostname() != "localhost" && base.Hostname() != "127.0.0.1" {
		return c, errors.New("DEV_TOKEN is only allowed when BASE_URL points to localhost")
	}
	return c, nil
}

func FromEnv() (Config, error) { return Load(os.Getenv) }

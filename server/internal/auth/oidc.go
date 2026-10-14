package auth

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const GoogleIssuer = "https://accounts.google.com"

// OIDC serves both "google" and generic "oidc". Discovery runs on first use
// instead of at startup, so the server still starts while the issuer is down.
type OIDC struct {
	name         string
	issuer       string
	clientID     string
	clientSecret string
	redirectURL  string

	mu       sync.Mutex
	config   *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func NewOIDC(name, issuer, clientID, secret, redirectURL string) *OIDC {
	return &OIDC{name: name, issuer: issuer, clientID: clientID, clientSecret: secret, redirectURL: redirectURL}
}

func (o *OIDC) Name() string { return o.name }

func (o *OIDC) discover(ctx context.Context) (*oauth2.Config, *oidc.IDTokenVerifier, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.config != nil {
		return o.config, o.verifier, nil
	}
	p, err := oidc.NewProvider(ctx, o.issuer)
	if err != nil {
		return nil, nil, fmt.Errorf("%s discovery: %w", o.name, err)
	}
	o.config = &oauth2.Config{
		ClientID:     o.clientID,
		ClientSecret: o.clientSecret,
		Endpoint:     p.Endpoint(),
		RedirectURL:  o.redirectURL,
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}
	o.verifier = p.Verifier(&oidc.Config{ClientID: o.clientID})
	return o.config, o.verifier, nil
}

func (o *OIDC) AuthURL(ctx context.Context, state string) (string, error) {
	cfg, _, err := o.discover(ctx)
	if err != nil {
		return "", err
	}
	return cfg.AuthCodeURL(state), nil
}

func (o *OIDC) Exchange(ctx context.Context, code string) (Identity, error) {
	cfg, verifier, err := o.discover(ctx)
	if err != nil {
		return Identity{}, err
	}
	tok, err := cfg.Exchange(ctx, code)
	if err != nil {
		return Identity{}, err
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return Identity{}, errors.New("no id_token in response")
	}
	idToken, err := verifier.Verify(ctx, raw)
	if err != nil {
		return Identity{}, err
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified *bool  `json:"email_verified"`
		Username      string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return Identity{}, err
	}
	// The allowlist matches on email, so an unverified email could be anyone's.
	if claims.Email == "" || claims.EmailVerified == nil || !*claims.EmailVerified {
		return Identity{}, errors.New("verified email required")
	}
	return Identity{Provider: o.name, Subject: idToken.Subject, Login: claims.Username, Email: claims.Email}, nil
}

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ompugao/tabstow/server/internal/auth"
	"github.com/ompugao/tabstow/server/internal/config"
	"github.com/ompugao/tabstow/server/internal/httpapi"
	"github.com/ompugao/tabstow/server/internal/store"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func providers(c config.Config) []auth.Provider {
	cb := func(name string) string { return c.BaseURL + "/auth/" + name + "/callback" }
	var ps []auth.Provider
	if c.GitHubClientID != "" {
		ps = append(ps, auth.NewGitHub(c.GitHubClientID, c.GitHubClientSecret, cb("github")))
	}
	if c.GoogleClientID != "" {
		ps = append(ps, auth.NewOIDC("google", auth.GoogleIssuer, c.GoogleClientID, c.GoogleClientSecret, cb("google")))
	}
	if c.OIDCIssuer != "" {
		ps = append(ps, auth.NewOIDC("oidc", c.OIDCIssuer, c.OIDCClientID, c.OIDCSecret, cb("oidc")))
	}
	return ps
}

func run(log *slog.Logger) error {
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	ps := providers(cfg)
	if len(ps) == 0 && cfg.DevToken == "" {
		return errors.New("no sign-in provider configured; set GITHUB_CLIENT_ID, GOOGLE_CLIENT_ID or OIDC_ISSUER")
	}
	allow := auth.ParseAllowlist(cfg.Allowlist)
	if len(allow) == 0 {
		log.Warn("ALLOWLIST is empty; nobody can sign in")
	}
	extIDs, err := auth.ParseExtensionIDs(cfg.ExtensionIDs)
	if err != nil {
		return fmt.Errorf("EXTENSION_IDS: %w", err)
	}
	if len(ps) > 0 && len(extIDs) == 0 {
		return errors.New("EXTENSION_IDS is required: the ID of your Tabstow extension, shown in its Settings page and on chrome://extensions")
	}
	if cfg.DevToken != "" {
		log.Warn("DEV_TOKEN is set; any request with this bearer token is accepted")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go purgeLoop(ctx, st, cfg.TombstoneTTL, log)

	api := &httpapi.Server{Store: st, Providers: ps, Allow: allow, ExtensionIDs: extIDs, TokenTTL: cfg.TokenTTL, DevToken: cfg.DevToken, Log: log}
	srv := &http.Server{Addr: cfg.ListenAddr, Handler: api.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Info("listening", "addr", cfg.ListenAddr, "base_url", cfg.BaseURL)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func purgeLoop(ctx context.Context, st *store.Store, ttl time.Duration, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		if err := st.Purge(ctx, ttl); err != nil && ctx.Err() == nil {
			log.Error("purge", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

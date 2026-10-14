package config

import "testing"

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestBaseURLIsRequired(t *testing.T) {
	if _, err := Load(env(nil)); err == nil {
		t.Fatal("expected error")
	}
}

func TestDefaultsApply(t *testing.T) {
	c, err := Load(env(map[string]string{"BASE_URL": "https://tabs.example.com/"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.BaseURL != "https://tabs.example.com" || c.ListenAddr != ":8080" || c.TokenTTL.Hours() != 8760 {
		t.Fatalf("got %+v", c)
	}
}

func TestDevTokenIsRefusedOnPublicBaseURL(t *testing.T) {
	_, err := Load(env(map[string]string{"BASE_URL": "https://tabs.example.com", "DEV_TOKEN": "x"}))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDevTokenIsAllowedOnLocalhost(t *testing.T) {
	if _, err := Load(env(map[string]string{"BASE_URL": "http://localhost:8080", "DEV_TOKEN": "x"})); err != nil {
		t.Fatal(err)
	}
}

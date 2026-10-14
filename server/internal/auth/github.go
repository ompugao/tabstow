package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"
)

type GitHub struct {
	Config  oauth2.Config
	APIBase string
}

func NewGitHub(clientID, secret, redirectURL string) *GitHub {
	return &GitHub{
		Config: oauth2.Config{
			ClientID:     clientID,
			ClientSecret: secret,
			Endpoint:     github.Endpoint,
			RedirectURL:  redirectURL,
			Scopes:       []string{"read:user", "user:email"},
		},
		APIBase: "https://api.github.com",
	}
}

func (g *GitHub) Name() string { return "github" }

func (g *GitHub) AuthURL(_ context.Context, state string) (string, error) {
	return g.Config.AuthCodeURL(state), nil
}

func (g *GitHub) Exchange(ctx context.Context, code string) (Identity, error) {
	tok, err := g.Config.Exchange(ctx, code)
	if err != nil {
		return Identity{}, err
	}
	client := g.Config.Client(ctx, tok)

	var user struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err := getJSON(client, g.APIBase+"/user", &user); err != nil {
		return Identity{}, err
	}
	if user.ID == 0 || user.Login == "" {
		return Identity{}, errors.New("github: empty user")
	}

	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := getJSON(client, g.APIBase+"/user/emails", &emails); err != nil {
		return Identity{}, err
	}
	var email string
	for _, e := range emails {
		if e.Primary && e.Verified {
			email = e.Email
		}
	}
	return Identity{Provider: "github", Subject: strconv.FormatInt(user.ID, 10), Login: user.Login, Email: email}, nil
}

func getJSON(client *http.Client, url string, v any) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

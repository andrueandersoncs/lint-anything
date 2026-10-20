package onboarding

import (
	"context"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
)

// maxSlugLen keeps workspace URLs short enough to fit in the subdomain
// label limit with room for the numeric suffix added on collisions.
const maxSlugLen = 40

// fallbackSlug is used when a team name has no letters or digits at all.
const fallbackSlug = "team"

var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

var ErrInvalidEmail = errors.New("onboarding: invalid email address")

type Account struct {
	ID       string
	Email    string
	FullName string
	OrgID    string
}

type Org struct {
	ID     string
	Domain string
}

type Workspace struct {
	ID      string
	Slug    string
	Name    string
	OwnerID string
}

type Accounts interface {
	OrgByDomain(ctx context.Context, domain string) (Org, bool, error)
	Create(ctx context.Context, a Account) (Account, error)
}

type Workspaces interface {
	SlugTaken(ctx context.Context, slug string) (bool, error)
	Create(ctx context.Context, w Workspace) (Workspace, error)
}

type Welcomer interface {
	SendWelcome(ctx context.Context, a Account, w Workspace) error
}

type Service struct {
	accounts   Accounts
	workspaces Workspaces
	welcomer   Welcomer
}

func NewService(accounts Accounts, workspaces Workspaces, welcomer Welcomer) *Service {
	return &Service{accounts: accounts, workspaces: workspaces, welcomer: welcomer}
}

type SignUpRequest struct {
	Email    string
	FullName string
	TeamName string
}

// SignUp creates the account and its first workspace. People whose email
// domain is claimed by an organization join it automatically.
func (s *Service) SignUp(ctx context.Context, req SignUpRequest) (Account, Workspace, error) {
	addr, err := mail.ParseAddress(req.Email)
	if err != nil {
		return Account{}, Workspace{}, fmt.Errorf("%w: %w", ErrInvalidEmail, err)
	}

	at := strings.LastIndexByte(addr.Address, '@')
	domain := strings.ToLower(addr.Address[at+1:])
	org, claimed, err := s.accounts.OrgByDomain(ctx, domain)
	if err != nil {
		return Account{}, Workspace{}, fmt.Errorf("look up organization for %s: %w", domain, err)
	}

	account := Account{Email: addr.Address, FullName: strings.TrimSpace(req.FullName)}
	if claimed {
		account.OrgID = org.ID
	}
	account, err = s.accounts.Create(ctx, account)
	if err != nil {
		return Account{}, Workspace{}, fmt.Errorf("create account for %s: %w", addr.Address, err)
	}

	base := nonSlugChars.ReplaceAllString(strings.ToLower(req.TeamName), "-")
	if len(base) > maxSlugLen {
		base = base[:maxSlugLen]
	}
	base = strings.Trim(base, "-")
	if base == "" {
		base = fallbackSlug
	}
	slug := base
	for n := 2; ; n++ {
		taken, err := s.workspaces.SlugTaken(ctx, slug)
		if err != nil {
			return Account{}, Workspace{}, fmt.Errorf("check workspace slug %q: %w", slug, err)
		}
		if !taken {
			break
		}
		slug = fmt.Sprintf("%s-%d", base, n)
	}

	workspace, err := s.workspaces.Create(ctx, Workspace{Slug: slug, Name: req.TeamName, OwnerID: account.ID})
	if err != nil {
		return Account{}, Workspace{}, fmt.Errorf("create workspace %q: %w", slug, err)
	}

	if err := s.welcomer.SendWelcome(ctx, account, workspace); err != nil {
		return account, workspace, fmt.Errorf("send welcome email to %s: %w", account.Email, err)
	}
	return account, workspace, nil
}

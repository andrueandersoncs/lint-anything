package acp

import (
	"context"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"

	"reasonix/internal/contract/event"
)

const (
	elicitMessageLimit = 1024
	elicitValueLimit   = 4096
)

// elicitModes is what the client can show, read once from its capabilities.
type elicitModes struct{ form, url bool }

func (s *updateSink) bindElicitation(caps ClientCapabilities) {
	s.elicitModes = elicitModes{form: caps.FormMode(), url: caps.URLMode()}
}

// elicit puts an MCP server's form or external interaction in front of the person
// through elicitation/create, in the mode the client advertised. What comes back
// for the controller is nil, which declines, unless the person accepted. A form is
// never offered for an interaction that needs a page, and a page is never offered
// to a client that did not advertise url.
func (s *updateSink) elicit(ctx context.Context, a event.Ask) []event.AskAnswer {
	if a.Origin == nil {
		return nil
	}
	if a.Origin.URL != "" {
		if !s.elicitModes.url || len(a.Questions) != 1 {
			return nil
		}
		return s.elicitURL(ctx, a)
	}
	if !s.elicitModes.form || len(a.Questions) == 0 {
		return nil
	}
	return s.elicitForm(ctx, a)
}

type elicitReply struct {
	Action  string                     `json:"action"`
	Content map[string]json.RawMessage `json:"content"`
}

func (s *updateSink) elicitRequest(ctx context.Context, params map[string]any) (elicitReply, bool) {
	raw, err := s.conn.Request(ctx, "elicitation/create", params)
	var reply elicitReply
	if err != nil || json.Unmarshal(raw, &reply) != nil {
		return elicitReply{}, false
	}
	return reply, true
}

// elicitMessage says who is asking: the words are the server's, and a person must
// not mistake them for the agent's.
func elicitMessage(o *event.AskOrigin) string {
	return clipPlain("MCP server "+o.Source+" asks: "+o.Message, elicitMessageLimit)
}

func clipPlain(s string, limit int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
	if utf8.RuneCountInString(s) > limit {
		s = string([]rune(s)[:limit]) + "…"
	}
	return s
}

func (s *updateSink) elicitURL(ctx context.Context, a event.Ask) []event.AskAnswer {
	reply, ok := s.elicitRequest(ctx, map[string]any{
		"sessionId": s.sessionID, "mode": "url", "elicitationId": "elicit-" + a.ID,
		"url": a.Origin.URL, "message": elicitMessage(a.Origin),
	})
	if !ok {
		return nil
	}
	switch reply.Action {
	case "accept", "cancel":
		return []event.AskAnswer{{QuestionID: a.Questions[0].ID, Selected: []string{reply.Action}}}
	}
	return nil
}

func (s *updateSink) elicitForm(ctx context.Context, a event.Ask) []event.AskAnswer {
	reply, ok := s.elicitRequest(ctx, map[string]any{
		"sessionId": s.sessionID, "mode": "form", "message": elicitMessage(a.Origin),
		"requestedSchema": elicitSchema(a.Questions),
	})
	if !ok || reply.Action != "accept" {
		return nil
	}
	return answersFromContent(a.Questions, reply.Content)
}

// elicitSchema is the flat object the client draws: a string, an enum, or an array
// of an enum, per question. The form is the server's; nothing here adds to it.
func elicitSchema(questions []event.AskQuestion) map[string]any {
	props := make(map[string]any, len(questions))
	for _, q := range questions {
		field := map[string]any{"title": clipPlain(firstNonEmpty(q.Header, q.ID), 120)}
		if d := clipPlain(q.Prompt, elicitMessageLimit); d != "" {
			field["description"] = d
		}
		var labels []string
		for _, o := range q.Options {
			labels = append(labels, o.Label)
		}
		switch {
		case len(labels) > 0 && q.Multi:
			field["type"] = "array"
			field["items"] = map[string]any{"type": "string", "enum": labels}
			if len(q.Default) > 0 {
				field["default"] = q.Default
			}
		case len(labels) > 0:
			field["type"] = "string"
			field["enum"] = labels
			if len(q.Default) > 0 {
				field["default"] = q.Default[0]
			}
		default:
			field["type"] = "string"
			field["maxLength"] = elicitValueLimit
			if len(q.Default) > 0 {
				field["default"] = q.Default[0]
			}
		}
		props[q.ID] = field
	}
	return map[string]any{"type": "object", "properties": props}
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

// answersFromContent checks what the client sent against what was asked, since
// the client's validation is not the agent's: a value outside an enum, of the
// wrong shape or over the cap declines the whole form rather than reaching the
// server as something the person did not choose.
func answersFromContent(questions []event.AskQuestion, content map[string]json.RawMessage) []event.AskAnswer {
	var out []event.AskAnswer
	for _, q := range questions {
		raw, ok := content[q.ID]
		if !ok {
			continue
		}
		values, ok := contentValues(raw)
		if !ok {
			return nil
		}
		if len(q.Options) > 0 {
			for _, v := range values {
				if !hasOption(q, v) {
					return nil
				}
			}
			if !q.Multi && len(values) > 1 {
				return nil
			}
		} else if len(values) > 1 {
			return nil
		}
		for _, v := range values {
			if utf8.RuneCountInString(v) > elicitValueLimit {
				return nil
			}
		}
		if len(values) > 0 {
			out = append(out, event.AskAnswer{QuestionID: q.ID, Selected: values})
		}
	}
	return out
}

func contentValues(raw json.RawMessage) ([]string, bool) {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return []string{one}, true
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return many, true
	}
	return nil, false
}

func hasOption(q event.AskQuestion, v string) bool {
	for _, o := range q.Options {
		if o.Label == v {
			return true
		}
	}
	return false
}

// ElicitationCapabilities is clientCapabilities.elicitation.
type ElicitationCapabilities struct {
	Form json.RawMessage `json:"form,omitempty"`
	URL  json.RawMessage `json:"url,omitempty"`
}

func present(raw json.RawMessage) bool {
	t := strings.TrimSpace(string(raw))
	return t != "" && t != "null"
}

// FormMode and URLMode say which elicitation modes the client advertised.
func (c ClientCapabilities) FormMode() bool {
	return c.Elicitation != nil && present(c.Elicitation.Form)
}
func (c ClientCapabilities) URLMode() bool { return c.Elicitation != nil && present(c.Elicitation.URL) }

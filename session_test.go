package main

import "testing"

func TestDeferCloseForDirtySession(t *testing.T) {
	for _, test := range []struct {
		name  string
		dirty bool
		want  bool
	}{
		{"clean-session-closes", false, false},
		{"dirty-session-defers", true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			requested := 0
			cancelled := deferCloseForDirtySession(test.dirty, func() { requested++ })
			if cancelled != test.want {
				t.Fatalf("cancelled = %t, want %t", cancelled, test.want)
			}
			wantRequests := 0
			if test.dirty {
				wantRequests = 1
			}
			if requested != wantRequests {
				t.Fatalf("request-close emitted %d times, want %d", requested, wantRequests)
			}
		})
	}
}

func TestSessionAndDocumentState(t *testing.T) {
	app := NewApp()
	app.SetDocumentState("/tmp/document.txt", true, "en")
	app.SetSessionDirty(true)

	app.stateMu.RLock()
	if app.documentPath != "/tmp/document.txt" || !app.documentDirty || app.language != "en" || !app.sessionDirty {
		t.Fatalf("state not recorded: %#v", app)
	}
	app.stateMu.RUnlock()

	// A clean session must allow the window to close without a dialog.
	app.SetSessionDirty(false)
	if app.beforeClose(nil) {
		t.Fatal("clean session still cancelled the close")
	}

	// Invalid language values must not overwrite the current language.
	app.SetDocumentState("", false, "fr")
	app.stateMu.RLock()
	defer app.stateMu.RUnlock()
	if app.language != "en" {
		t.Fatalf("invalid language replaced the current one: %q", app.language)
	}
}

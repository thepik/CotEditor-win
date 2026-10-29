package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SetSessionDirty records whether any open document has unsaved changes. The
// frontend keeps this in sync for all tabs; the native close guard uses it to
// decide whether the frontend must run its save/discard flow first.
func (a *App) SetSessionDirty(dirty bool) {
	a.stateMu.Lock()
	a.sessionDirty = dirty
	a.stateMu.Unlock()
}

// deferCloseForDirtySession is the testable core of beforeClose. It returns
// true when the close must be cancelled so the frontend can save or discard.
func deferCloseForDirtySession(sessionDirty bool, requestClose func()) bool {
	if !sessionDirty {
		return false
	}
	requestClose()
	return true
}

// beforeClose never decides to discard content on its own. When the session is
// dirty it asks the frontend to run its save/discard flow via the
// "app:request-close" event and cancels this close; the frontend calls
// runtime.Quit after the user resolves the documents. A clean session closes
// immediately. This also avoids stacking a second native dialog on top of the
// frontend's own confirmations.
func (a *App) beforeClose(ctx context.Context) bool {
	a.stateMu.RLock()
	dirty := a.sessionDirty
	a.stateMu.RUnlock()

	return deferCloseForDirtySession(dirty, func() {
		runtime.EventsEmit(ctx, "app:request-close")
	})
}

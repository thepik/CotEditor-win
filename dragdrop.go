package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// openPathsEvent is the frontend contract for native file drops. The payload
// is always []string (never a bare string), even when a single file is
// dropped, so the frontend can handle every drop with one code path.
const openPathsEvent = "app:open-paths"

// startupWithDragDrop wraps App.startup and installs the Go-side file-drop
// listener. Wails v2.13.0 exposes drag-and-drop only through
// options.DragAndDrop (there is no options.OnFileDrop callback field); the
// runtime helper subscribes to the "wails:file-drop" event that the Wails
// frontend runtime emits after a native drop. The frontend still owns the DOM
// drop targets and the multi-tab open policy; this listener only bridges the
// dropped paths into App.handleDroppedPaths.
func (a *App) startupWithDragDrop(ctx context.Context) {
	a.startup(ctx)
	wailsruntime.OnFileDrop(ctx, func(_, _ int, paths []string) {
		a.handleDroppedPaths(paths)
	})
}

// handleDroppedPaths validates the paths supplied by a native file drop and
// forwards them to the frontend as a single "app:open-paths" event. It never
// reads file contents, replaces the current document, or writes to disk: the
// frontend's tab layer decides how (and whether) to open each path.
func (a *App) handleDroppedPaths(paths []string) {
	cleaned := normalizeDroppedPaths(paths, os.Stat)
	if len(cleaned) == 0 || a.ctx == nil {
		return
	}
	wailsruntime.EventsEmit(a.ctx, openPathsEvent, cleaned)
}

// statFile is injected so path filtering can be tested without touching the
// real filesystem or starting the GUI.
type statFile func(string) (os.FileInfo, error)

// normalizeDroppedPaths converts drop paths to absolute paths, removes blanks
// and duplicates while preserving input order, then rejects anything that is
// not an existing regular file (missing paths, directories, devices, ...).
func normalizeDroppedPaths(paths []string, stat statFile) []string {
	candidates := cleanDroppedPaths(paths)
	if len(candidates) == 0 {
		return nil
	}
	out := make([]string, 0, len(candidates))
	for _, path := range candidates {
		info, err := stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		out = append(out, path)
	}
	return out
}

// cleanDroppedPaths handles the filesystem-independent half of validation:
// blank entries are dropped, relative paths become absolute, paths are
// cleaned, and duplicates (case-insensitive on Windows) are removed.
func cleanDroppedPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, raw := range paths {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		abs, err := filepath.Abs(raw)
		if err != nil {
			continue
		}
		abs = filepath.Clean(abs)
		key := droppedPathKey(abs)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, abs)
	}
	return out
}

// droppedPathKey implements duplicate detection. Windows paths are
// case-insensitive; other platforms keep exact-case semantics.
func droppedPathKey(path string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

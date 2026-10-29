package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the main application struct bound to the frontend.
//
// It holds the Wails context (needed for native dialog calls) and exposes the
// file-IO methods that mirror the original Tauri command surface:
// OpenFile / SaveFile / SaveAs / NewFile. The frontend reaches them through
// the generated `frontend/wailsjs/go/main/App.js` bindings.
type App struct {
	ctx context.Context

	stateMu       sync.RWMutex
	documentPath  string
	documentDirty bool
	language      string
	// sessionDirty is true while any open document has unsaved changes. The
	// frontend owns the save/discard decision; beforeClose only asks it to run
	// that flow through the "app:request-close" event and keeps the window open.
	sessionDirty bool

	// startupFile is the file path passed on the command line when the app is
	// launched (e.g. double-clicking a .md file in Explorer). Empty when no
	// file was requested. The frontend queries it once via StartupFile() after
	// bootstrap to decide whether to load a document instead of showing an
	// empty buffer.
	startupFile string
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{language: "zh"}
}

// startup is called at application start; we save the context so dialog
// methods can use it later.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startupFile = parseFileArg(os.Args[1:])
}

// parseFileArg returns the first non-flag command-line argument that points to
// an existing file, or "" if none. Flag-like args (starting with "-") are
// skipped so future options won't be mistaken for a file path.
func parseFileArg(args []string) string {
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		if info, err := os.Stat(arg); err == nil && !info.IsDir() {
			if abs, err := filepath.Abs(arg); err == nil {
				return abs
			}
			return arg
		}
	}
	return ""
}

// FileContent mirrors the original Rust `FileContent` struct and the TS
// `FileContent` interface in src/lib/file-bridge.ts. Fields are exported so
// Wails serialises them as JSON keys the frontend expects.
type FileContent struct {
	// Absolute path of the file on disk, or nil for an untitled buffer.
	Path *string `json:"path"`
	// File contents, already decoded to a JS string.
	Content string `json:"content"`
	// Encoding label used to decode (e.g. "UTF-8").
	Encoding string `json:"encoding"`
	// Line ending detected in the file: "lf", "crlf" or "cr".
	LineEnding string `json:"line_ending"`
	// MixedLineEnding is true when more than one line-ending style occurs.
	// Content keeps the original bytes; this is a warning hint only.
	MixedLineEnding bool `json:"mixed_line_ending"`
}

// StartupFile returns the file path requested on the command line when the app
// was launched (e.g. double-clicking a file in Explorer), or nil if none. The
// frontend calls this once after bootstrap to load the initial document.
func (a *App) StartupFile() (*string, error) {
	if a.startupFile == "" {
		return nil, nil
	}
	path := a.startupFile
	return &path, nil
}

// OpenPath loads a file at the given absolute path without prompting. Used by
// the frontend when a second instance launches and forwards its command-line
// file to the running instance via the "app:open-path" event.
func (a *App) OpenPath(path string) (FileContent, error) {
	if path == "" {
		return FileContent{}, os.ErrInvalid
	}
	return readFileAt(path)
}

// OpenPathWithEncoding re-interprets the bytes at path using encoding instead
// of auto-detection. The file itself is never modified.
func (a *App) OpenPathWithEncoding(path, encoding string) (FileContent, error) {
	if path == "" {
		return FileContent{}, os.ErrInvalid
	}
	return readFileAtWithEncoding(path, encoding)
}

// handleSecondInstance is invoked by Wails' SingleInstanceLock when another
// process is started while this instance is already running. The second
// instance's command-line args are forwarded here; we extract the first file
// path (if any) and emit an event to the frontend so it can load the file in
// the existing window instead of launching a new one.
func (a *App) handleSecondInstance(args []string) {
	path := parseFileArg(args)
	if path == "" {
		return
	}
	// a.ctx is guaranteed to be set: OnStartup runs before any second instance
	// can reach the running window.
	runtime.EventsEmit(a.ctx, "app:open-path", path)
}

func (a *App) promptOpenFile() (string, error) {
	// We don't restrict extensions because CotEditor opens arbitrary text files.
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open File",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files (*.txt, *.md, *.json, *.ts, *.js, *.py)", Pattern: "*.txt;*.md;*.json;*.ts;*.js;*.py"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
}

// OpenFile prompts the user with a native open dialog and returns the selected
// file's contents. Returns an error if the user cancels or the read fails.
func (a *App) OpenFile() (FileContent, error) {
	selection, err := a.promptOpenFile()
	if err != nil {
		return FileContent{}, err
	}
	if selection == "" {
		// User cancelled. Return an empty FileContent; the frontend treats a
		// nil path + cancelled sentinel as "no file opened".
		return FileContent{Path: nil}, nil
	}
	return readFileAt(selection)
}

// OpenFileWithEncoding prompts for a file and decodes it with the requested
// encoding instead of auto-detection.
func (a *App) OpenFileWithEncoding(encoding string) (FileContent, error) {
	selection, err := a.promptOpenFile()
	if err != nil {
		return FileContent{}, err
	}
	if selection == "" {
		return FileContent{Path: nil}, nil
	}
	return readFileAtWithEncoding(selection, encoding)
}

// SaveFile writes content to path. If path is empty (untitled buffer), it
// falls back to SaveAs behaviour. Returns the path actually written to.
func (a *App) SaveFile(path string, content string) (string, error) {
	if path == "" {
		return a.SaveAs(content)
	}
	if err := safeWriteFile(path, []byte(content)); err != nil {
		return "", err
	}
	return path, nil
}

func (a *App) promptSaveFile() (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save File As",
		DefaultFilename: "Untitled.txt",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files (*.txt)", Pattern: "*.txt"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
}

// SaveAs prompts for a destination path via a save dialog, then writes content.
// Returns the chosen path, or "" if the user cancelled.
func (a *App) SaveAs(content string) (string, error) {
	selection, err := a.promptSaveFile()
	if err != nil {
		return "", err
	}
	if selection == "" {
		return "", nil // cancelled
	}
	if err := safeWriteFile(selection, []byte(content)); err != nil {
		return "", err
	}
	return selection, nil
}

// SaveFileWithEncoding writes content encoded as requested. BOMs are added
// according to the encoding; an empty path falls back to SaveAsWithEncoding.
func (a *App) SaveFileWithEncoding(path, content, encoding string) (string, error) {
	if path == "" {
		return a.SaveAsWithEncoding(content, encoding)
	}
	if err := saveTextFile(path, content, encoding); err != nil {
		return "", err
	}
	return path, nil
}

// SaveAsWithEncoding prompts for a destination and writes content encoded as
// requested. Returns "" when the user cancels.
func (a *App) SaveAsWithEncoding(content, encoding string) (string, error) {
	selection, err := a.promptSaveFile()
	if err != nil {
		return "", err
	}
	if selection == "" {
		return "", nil
	}
	if err := saveTextFile(selection, content, encoding); err != nil {
		return "", err
	}
	return selection, nil
}

// SaveFileChecked writes content only if the on-disk stamp still matches the
// baseline captured before editing. A mismatch returns FILE_CONFLICT and does
// not overwrite the externally changed file. Negative expected values skip the
// individual check; (0, 0) means the file was expected to be absent.
func (a *App) SaveFileChecked(path, content, encoding string, expectedSize int64, expectedModTime int64) (string, error) {
	if path == "" {
		return a.SaveAsChecked(content, encoding, expectedSize, expectedModTime)
	}
	if err := saveTextFileChecked(path, content, encoding, expectedSize, expectedModTime); err != nil {
		return "", err
	}
	return path, nil
}

// SaveAsChecked prompts for a destination and performs the same stamp-checked
// write as SaveFileChecked.
func (a *App) SaveAsChecked(content, encoding string, expectedSize, expectedModTime int64) (string, error) {
	selection, err := a.promptSaveFile()
	if err != nil {
		return "", err
	}
	if selection == "" {
		return "", nil
	}
	if err := saveTextFileChecked(selection, content, encoding, expectedSize, expectedModTime); err != nil {
		return "", err
	}
	return selection, nil
}

// FileStamp returns the current size and modification time for external-change
// detection. A missing file is not an error: Exists is false.
func (a *App) FileStamp(path string) (FileStamp, error) {
	return fileStamp(path)
}

// NewFile returns an empty FileContent so the frontend can reset its state
// symmetrically with OpenFile. No disk IO.
func (a *App) NewFile() (FileContent, error) {
	return FileContent{
		Path:       nil,
		Content:    "",
		Encoding:   "UTF-8",
		LineEnding: "lf",
	}, nil
}

// SetDocumentState mirrors the small piece of editor state needed by the
// native window-close guard. Existing documents are normally auto-saved by the
// frontend; keeping the transient dirty state here also protects the short
// interval while a write is still in flight. The language is retained for any
// future native messaging; close handling itself lives in session.go.
func (a *App) SetDocumentState(path string, dirty bool, language string) {
	a.stateMu.Lock()
	a.documentPath = path
	a.documentDirty = dirty
	if language == "en" || language == "zh" {
		a.language = language
	}
	a.stateMu.Unlock()
}

// readFileAt validates text before it can cross the JSON boundary. The
// returned Content is always BOM-free and valid UTF-8; Encoding records how
// the bytes were interpreted so a save can put the same encoding back.
//
// Read and write paths both allow links and reparse points in parent
// directories (redirected profiles, OneDrive folders, junctions): reading
// follows them and saving stages a replacement next to the resolved file.
// Write-side identity checks stay on the final target, which must be a regular
// file rather than a symlink, junction or other reparse point.
// checkReadPath applies the platform path syntax rules and os.Stat resolves
// the final target; safeWriteFile uses checkWriteTargetPath instead.
func readFileAt(path string) (FileContent, error) {
	return readFileAtWithEncoding(path, "")
}

func readFileAtWithEncoding(path, encoding string) (FileContent, error) {
	if err := checkPlatformPath(path); err != nil {
		return FileContent{}, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return FileContent{}, err
	}
	if err := checkReadPath(abs); err != nil {
		return FileContent{}, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return FileContent{}, err
	}
	var content, detected string
	if encoding == "" {
		content, detected, err = decodeAuto(data)
	} else {
		content, err = decodeExplicit(data, encoding)
		detected, _ = canonicalEncoding(encoding)
	}
	if err != nil {
		return FileContent{}, fmt.Errorf("open %q: %w", abs, err)
	}
	lineEnding, mixed := analyzeLineEndings(content)
	return FileContent{
		Path:            &abs,
		Content:         content,
		Encoding:        detected,
		LineEnding:      lineEnding,
		MixedLineEnding: mixed,
	}, nil
}

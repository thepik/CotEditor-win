package main

import (
	"context"
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
}

// NewApp creates a new App application struct.
func NewApp() *App {
	return &App{language: "zh"}
}

// startup is called at application start; we save the context so dialog
// methods can use it later.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
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
}

// OpenFile prompts the user with a native open dialog and returns the selected
// file's contents. Returns an error if the user cancels or the read fails.
func (a *App) OpenFile() (FileContent, error) {
	// We don't restrict extensions because CotEditor opens arbitrary text files.
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Open File",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files (*.txt, *.md, *.json, *.ts, *.js, *.py)", Pattern: "*.txt;*.md;*.json;*.ts;*.js;*.py"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
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

// SaveFile writes content to path. If path is empty (untitled buffer), it
// falls back to SaveAs behaviour. Returns the path actually written to.
func (a *App) SaveFile(path string, content string) (string, error) {
	if path == "" {
		return a.SaveAs(content)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", err
	}
	return path, nil
}

// SaveAs prompts for a destination path via a save dialog, then writes content.
// Returns the chosen path, or "" if the user cancelled.
func (a *App) SaveAs(content string) (string, error) {
	selection, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save File As",
		DefaultFilename: "Untitled.txt",
		Filters: []runtime.FileFilter{
			{DisplayName: "Text Files (*.txt)", Pattern: "*.txt"},
			{DisplayName: "All Files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", err
	}
	if selection == "" {
		return "", nil // cancelled
	}
	if err := os.WriteFile(selection, []byte(content), 0644); err != nil {
		return "", err
	}
	return selection, nil
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
// interval while a write is still in flight.
func (a *App) SetDocumentState(path string, dirty bool, language string) {
	a.stateMu.Lock()
	a.documentPath = path
	a.documentDirty = dirty
	if language == "en" || language == "zh" {
		a.language = language
	}
	a.stateMu.Unlock()
}

// beforeClose asks for confirmation whenever the frontend reports changes
// that have not reached disk yet. Returning true cancels the close in Wails.
func (a *App) beforeClose(ctx context.Context) bool {
	a.stateMu.RLock()
	path := a.documentPath
	dirty := a.documentDirty
	language := a.language
	a.stateMu.RUnlock()

	if !dirty {
		return false
	}

	title := "未保存的更改"
	message := "未命名文档尚未保存。关闭窗口将丢失编辑内容，确定要关闭吗？"
	closeLabel := "不保存并关闭"
	cancelLabel := "取消"
	if path != "" {
		message = "最新更改尚未完成写入。现在关闭可能会丢失部分编辑内容，确定要关闭吗？"
	}
	if language == "en" {
		title = "Unsaved Changes"
		message = "The untitled document has not been saved. Closing now will discard your changes."
		closeLabel = "Close Without Saving"
		cancelLabel = "Cancel"
		if path != "" {
			message = "The latest changes have not finished saving. Closing now may discard some edits."
		}
	}

	selection, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{closeLabel, cancelLabel},
		DefaultButton: cancelLabel,
		CancelButton:  cancelLabel,
	})
	if err != nil {
		// A failed dialog must never silently discard user content.
		return true
	}
	return selection != closeLabel
}

// readFileAt reads a file, decodes as UTF-8 and detects line endings.
//
// MVP targets UTF-8; the Encoding field is threaded through so a future
// encoding-detection pass (PLAN §阶段5 "编码处理") can populate it without
// changing the IPC shape.
func readFileAt(path string) (FileContent, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return FileContent{}, err
	}

	// Decode as UTF-8. Invalid sequences become the replacement char; we don't
	// surface had-errors here because MVP is UTF-8 only.
	content := string(bytes)

	abs, _ := filepath.Abs(path)
	lineEnding := detectLineEnding(content)
	return FileContent{
		Path:       &abs,
		Content:    content,
		Encoding:   "UTF-8",
		LineEnding: lineEnding,
	}, nil
}

// detectLineEnding returns "crlf" if any \r\n present, else "cr" if any lone
// \r present, else "lf". Matches CotEditor's pragmatic detection.
func detectLineEnding(text string) string {
	if strings.Contains(text, "\r\n") {
		return "crlf"
	}
	if strings.Contains(text, "\r") {
		return "cr"
	}
	return "lf"
}

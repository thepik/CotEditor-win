package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRecoverySaveListLoadDiscardAndClearPath(t *testing.T) {
	dir := testDirectory(t)
	now := time.Unix(1700000000, 0)
	docPath := filepath.Join(dir, "document.txt")
	putTestFile(t, docPath, []byte("on disk"))

	if err := saveRecoveryEntry(dir, now, "doc-1", docPath, "draft one", encodingUTF8BOM, "crlf"); err != nil {
		t.Fatal(err)
	}
	if err := saveRecoveryEntry(dir, now.Add(time.Minute), "doc-2", "", "untitled draft", encodingUTF16LE, "lf"); err != nil {
		t.Fatal(err)
	}

	entries, err := listRecoveryEntries(dir, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("listed %d entries, want 2: %#v", len(entries), entries)
	}
	if entries[0].ID != "doc-2" || entries[1].ID != "doc-1" {
		t.Fatalf("entries not newest-first: %#v", entries)
	}
	if entries[1].Content != "draft one" || entries[1].Encoding != encodingUTF8BOM ||
		entries[1].LineEnding != "crlf" || !entries[1].Exists {
		t.Fatalf("stored metadata changed: %#v", entries[1])
	}
	if entries[0].Exists {
		t.Fatalf("untitled draft reported an existing path: %#v", entries[0])
	}

	loaded, err := loadRecoveryEntry(dir, now.Add(time.Minute), "doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Content != "draft one" || loaded.Path != docPath || loaded.UpdatedAt != now.UnixNano() {
		t.Fatalf("unexpected loaded entry: %#v", loaded)
	}

	if err := discardRecoveryEntry(dir, "doc-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(recoveryFilePath(dir, "doc-1")); !os.IsNotExist(err) {
		t.Fatalf("discard left the file behind: %v", err)
	}
	// Discarding a missing entry is idempotent.
	if err := discardRecoveryEntry(dir, "doc-1"); err != nil {
		t.Fatal(err)
	}

	if err := saveRecoveryEntry(dir, now.Add(3*time.Minute), "doc-3", docPath, "newer draft", encodingUTF8, "lf"); err != nil {
		t.Fatal(err)
	}
	if err := saveRecoveryEntry(dir, now.Add(4*time.Minute), "doc-4", filepath.Join(dir, "other.txt"), "other", encodingUTF8, "lf"); err != nil {
		t.Fatal(err)
	}
	if err := clearRecoveryPathEntries(dir, now.Add(5*time.Minute), docPath); err != nil {
		t.Fatal(err)
	}
	entries, err = listRecoveryEntries(dir, now.Add(5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].ID != "doc-4" || entries[1].ID != "doc-2" {
		t.Fatalf("clearing one path removed the wrong entries: %#v", entries)
	}
	requireNoRecoveryTemps(t, dir)
}

func TestRecoveryRejectsUnsafeIDs(t *testing.T) {
	dir := testDirectory(t)
	now := time.Unix(1700000000, 0)
	for _, id := range []string{"", ".", "..", "../evil", `a\b`, "a/b", "a.b", strings.Repeat("a", 65)} {
		if err := saveRecoveryEntry(dir, now, id, "", "content", encodingUTF8, "lf"); err == nil ||
			!strings.Contains(err.Error(), "RECOVERY_INVALID_ID:") {
			t.Errorf("id %q was accepted for save: %v", id, err)
		}
		if _, err := loadRecoveryEntry(dir, now, id); err == nil || !strings.Contains(err.Error(), "RECOVERY_INVALID_ID:") {
			t.Errorf("id %q was accepted for load: %v", id, err)
		}
		if err := discardRecoveryEntry(dir, id); err == nil || !strings.Contains(err.Error(), "RECOVERY_INVALID_ID:") {
			t.Errorf("id %q was accepted for discard: %v", id, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "..", "evil.json")); !os.IsNotExist(err) {
		t.Fatalf("unsafe id escaped the recovery directory: %v", err)
	}
}

func TestRecoveryCleansExpiredEntries(t *testing.T) {
	dir := testDirectory(t)
	now := time.Unix(1700000000, 0)
	if err := saveRecoveryEntry(dir, now, "old", "", "old draft", encodingUTF8, "lf"); err != nil {
		t.Fatal(err)
	}
	if err := saveRecoveryEntry(dir, now.Add(6*24*time.Hour), "young", "", "young draft", encodingUTF8, "lf"); err != nil {
		t.Fatal(err)
	}

	entries, err := listRecoveryEntries(dir, now.Add(8*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].ID != "young" {
		t.Fatalf("expired entries were not removed: %#v", entries)
	}
	if _, err := os.Stat(recoveryFilePath(dir, "old")); !os.IsNotExist(err) {
		t.Fatalf("expired file remains on disk: %v", err)
	}
	if _, err := loadRecoveryEntry(dir, now.Add(8*24*time.Hour), "old"); err == nil ||
		!strings.Contains(err.Error(), "RECOVERY_NOT_FOUND:") {
		t.Fatalf("expired entry loaded: %v", err)
	}
}

func TestRecoveryKeepsAtMostFiftyEntries(t *testing.T) {
	dir := testDirectory(t)
	now := time.Unix(1700000000, 0)
	for i := 0; i < recoveryMaxEntries+5; i++ {
		id := fmt.Sprintf("entry-%02d", i)
		if err := saveRecoveryEntry(dir, now.Add(time.Duration(i)*time.Second), id, "", "draft", encodingUTF8, "lf"); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := listRecoveryEntries(dir, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != recoveryMaxEntries {
		t.Fatalf("kept %d entries, want %d", len(entries), recoveryMaxEntries)
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != recoveryMaxEntries {
		t.Fatalf("kept %d recovery files, want %d", len(files), recoveryMaxEntries)
	}
	requireNoRecoveryTemps(t, dir)
}

func TestRecoveryNormalizesMetadata(t *testing.T) {
	dir := testDirectory(t)
	now := time.Unix(1700000000, 0)
	if err := saveRecoveryEntry(dir, now, "known-encoding", "", "draft", "utf-8", "LF"); err != nil {
		t.Fatal(err)
	}
	entry, err := loadRecoveryEntry(dir, now, "known-encoding")
	if err != nil {
		t.Fatal(err)
	}
	if entry.Encoding != encodingUTF8 || entry.LineEnding != "lf" {
		t.Fatalf("known metadata not normalized: %#v", entry)
	}

	// Unknown labels are preserved as restore hints instead of losing the
	// draft; only the id is a file-system safety boundary.
	if err := saveRecoveryEntry(dir, now, "unknown-encoding", "", "draft", "UTF-7", "MIXED"); err != nil {
		t.Fatal(err)
	}
	entry, err = loadRecoveryEntry(dir, now, "unknown-encoding")
	if err != nil {
		t.Fatal(err)
	}
	if entry.Encoding != "UTF-7" || entry.LineEnding != "mixed" {
		t.Fatalf("unknown metadata was not preserved: %#v", entry)
	}

	if err := saveRecoveryEntry(dir, now, "defaults", "", "draft", "", ""); err != nil {
		t.Fatal(err)
	}
	entry, err = loadRecoveryEntry(dir, now, "defaults")
	if err != nil {
		t.Fatal(err)
	}
	if entry.Encoding != encodingUTF8 || entry.LineEnding != "lf" {
		t.Fatalf("defaults not applied: %#v", entry)
	}
	requireNoRecoveryTemps(t, dir)
}

func requireNoRecoveryTemps(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".coteditor-recovery-") {
			t.Errorf("recovery temporary file not cleaned up: %s", entry.Name())
		}
	}
}

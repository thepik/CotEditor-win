package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Recovery drafts are local-only snapshots of unsaved editor buffers. To keep
// sensitive text from accumulating forever, the store is bounded by both age
// and count and is pruned whenever it is read or written.
const (
	recoveryMaxEntries = 50
	recoveryMaxAge     = 7 * 24 * time.Hour
)

// IDs come from the frontend and become file names, so only a deliberately
// small alphabet is accepted. This also excludes "." / ".." and separators.
var recoveryIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// RecoveryEntry is one draft snapshot. Exists reports whether the original
// path (when non-empty) still exists on disk at the time of listing.
type RecoveryEntry struct {
	ID         string `json:"id"`
	Path       string `json:"path"`
	Content    string `json:"content"`
	Encoding   string `json:"encoding"`
	LineEnding string `json:"line_ending"`
	UpdatedAt  int64  `json:"updated_at"`
	Exists     bool   `json:"exists"`
}

func recoveryDirectory() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("RECOVERY_UNAVAILABLE: cannot locate the user config directory: %w", err)
	}
	return filepath.Join(base, "CotEditor", "Recovery"), nil
}

func validRecoveryID(id string) bool {
	return recoveryIDPattern.MatchString(id)
}

func recoveryFilePath(dir, id string) string {
	return filepath.Join(dir, id+".json")
}

func recoveryExpired(updatedAt int64, now time.Time) bool {
	if updatedAt <= 0 {
		return true
	}
	return now.Sub(time.Unix(0, updatedAt)) > recoveryMaxAge
}

func recoveryPathExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// saveRecoveryEntry validates and atomically writes one entry, then prunes the
// store. Writing into the destination directory first and renaming keeps a
// crash from leaving a partially written JSON file under the final name.
func saveRecoveryEntry(dir string, now time.Time, id, path, content, encoding, lineEnding string) (result error) {
	if !validRecoveryID(id) {
		return fmt.Errorf("RECOVERY_INVALID_ID: %q is not a safe recovery id", id)
	}
	// Encoding and line-ending labels are restore hints, not security
	// boundaries. Normalize known values but never refuse to save a draft just
	// because a future/unknown label arrived; losing the draft would be worse.
	if strings.TrimSpace(encoding) == "" {
		encoding = encodingUTF8
	} else if canonical, ok := canonicalEncoding(encoding); ok {
		encoding = canonical
	} else {
		encoding = strings.TrimSpace(encoding)
	}
	lineEnding = strings.ToLower(strings.TrimSpace(lineEnding))
	if lineEnding == "" {
		lineEnding = "lf"
	}

	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create recovery directory %q: %w", dir, err)
	}
	entry := RecoveryEntry{
		ID:         id,
		Path:       path,
		Content:    content,
		Encoding:   encoding,
		LineEnding: lineEnding,
		UpdatedAt:  now.UnixNano(),
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encode recovery entry %q: %w", id, err)
	}

	temp, err := os.CreateTemp(dir, ".coteditor-recovery-*.tmp")
	if err != nil {
		return fmt.Errorf("create recovery temporary file: %w", err)
	}
	tempName := temp.Name()
	closed := false
	defer func() {
		if !closed {
			if err := temp.Close(); err != nil {
				result = errors.Join(result, fmt.Errorf("close recovery temporary file %q: %w", tempName, err))
			}
		}
		if err := os.Remove(tempName); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, fmt.Errorf("clean up recovery temporary file %q: %w", tempName, err))
		}
	}()

	n, err := temp.Write(data)
	if err != nil {
		return fmt.Errorf("write recovery temporary file: %w", err)
	}
	if n != len(data) {
		return fmt.Errorf("write recovery temporary file: %w", errors.New("short write"))
	}
	if err := temp.Sync(); err != nil {
		return fmt.Errorf("sync recovery temporary file: %w", err)
	}
	closed = true
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close recovery temporary file: %w", err)
	}
	if err := os.Rename(tempName, recoveryFilePath(dir, id)); err != nil {
		return fmt.Errorf("publish recovery entry %q: %w", id, err)
	}

	// Enforce age and count limits after every write. Errors here do not undo
	// the entry that was just saved; they only mean stale files may remain.
	_, _ = listRecoveryEntries(dir, now)
	return nil
}

func readRecoveryFile(path string) (RecoveryEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return RecoveryEntry{}, err
	}
	var entry RecoveryEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return RecoveryEntry{}, fmt.Errorf("RECOVERY_CORRUPT: %q is not a valid recovery entry: %w", path, err)
	}
	return entry, nil
}

// listRecoveryEntries returns newest first after removing expired files and
// trimming the store to recoveryMaxEntries. Corrupt files are skipped rather
// than failing the whole list; a transient read error should not hide other
// recoverable drafts.
func listRecoveryEntries(dir string, now time.Time) ([]RecoveryEntry, error) {
	entries := []RecoveryEntry{}
	dirEntries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return entries, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read recovery directory %q: %w", dir, err)
	}
	for _, dirEntry := range dirEntries {
		name := dirEntry.Name()
		if dirEntry.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !validRecoveryID(id) {
			continue
		}
		path := filepath.Join(dir, name)
		entry, err := readRecoveryFile(path)
		if err != nil {
			continue
		}
		if recoveryExpired(entry.UpdatedAt, now) {
			_ = os.Remove(path)
			continue
		}
		entry.ID = id
		entry.Exists = recoveryPathExists(entry.Path)
		entries = append(entries, entry)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].UpdatedAt != entries[j].UpdatedAt {
			return entries[i].UpdatedAt > entries[j].UpdatedAt
		}
		return entries[i].ID < entries[j].ID
	})
	if len(entries) > recoveryMaxEntries {
		for _, stale := range entries[recoveryMaxEntries:] {
			_ = os.Remove(recoveryFilePath(dir, stale.ID))
		}
		entries = entries[:recoveryMaxEntries]
	}
	return entries, nil
}

func loadRecoveryEntry(dir string, now time.Time, id string) (RecoveryEntry, error) {
	if !validRecoveryID(id) {
		return RecoveryEntry{}, fmt.Errorf("RECOVERY_INVALID_ID: %q is not a safe recovery id", id)
	}
	path := recoveryFilePath(dir, id)
	entry, err := readRecoveryFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return RecoveryEntry{}, fmt.Errorf("RECOVERY_NOT_FOUND: %q does not exist", id)
	}
	if err != nil {
		return RecoveryEntry{}, err
	}
	if recoveryExpired(entry.UpdatedAt, now) {
		_ = os.Remove(path)
		return RecoveryEntry{}, fmt.Errorf("RECOVERY_NOT_FOUND: %q has expired", id)
	}
	entry.ID = id
	entry.Exists = recoveryPathExists(entry.Path)
	return entry, nil
}

func discardRecoveryEntry(dir, id string) error {
	if !validRecoveryID(id) {
		return fmt.Errorf("RECOVERY_INVALID_ID: %q is not a safe recovery id", id)
	}
	if err := os.Remove(recoveryFilePath(dir, id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("discard recovery entry %q: %w", id, err)
	}
	return nil
}

func clearRecoveryPathEntries(dir string, now time.Time, path string) error {
	entries, err := listRecoveryEntries(dir, now)
	if err != nil {
		return err
	}
	var result error
	for _, entry := range entries {
		if !sameRecoveryPath(entry.Path, path) {
			continue
		}
		if err := os.Remove(recoveryFilePath(dir, entry.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, fmt.Errorf("discard recovery entry %q: %w", entry.ID, err))
		}
	}
	return result
}

func sameRecoveryPath(a, b string) bool {
	if a == "" || b == "" {
		return a == b
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	return runtime.GOOS == "windows" && strings.EqualFold(a, b)
}

func (a *App) SaveRecovery(id, path, content, encoding, lineEnding string) error {
	dir, err := recoveryDirectory()
	if err != nil {
		return err
	}
	return saveRecoveryEntry(dir, time.Now(), id, path, content, encoding, lineEnding)
}

func (a *App) ListRecovery() ([]RecoveryEntry, error) {
	dir, err := recoveryDirectory()
	if err != nil {
		return nil, err
	}
	return listRecoveryEntries(dir, time.Now())
}

func (a *App) LoadRecovery(id string) (RecoveryEntry, error) {
	dir, err := recoveryDirectory()
	if err != nil {
		return RecoveryEntry{}, err
	}
	return loadRecoveryEntry(dir, time.Now(), id)
}

func (a *App) DiscardRecovery(id string) error {
	dir, err := recoveryDirectory()
	if err != nil {
		return err
	}
	return discardRecoveryEntry(dir, id)
}

func (a *App) ClearRecoveryPath(path string) error {
	dir, err := recoveryDirectory()
	if err != nil {
		return err
	}
	return clearRecoveryPathEntries(dir, time.Now(), path)
}

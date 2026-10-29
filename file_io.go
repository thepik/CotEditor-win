package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"unicode/utf8"
)

// Stable prefixes let the frontend localize these errors without changing the
// exported Wails API. Do not guess encodings or reject ordinary text controls.
func validateText(data []byte) error {
	if !utf8.Valid(data) {
		return errors.New("TEXT_INVALID_UTF8: this file is not valid UTF-8; convert it to UTF-8 in an encoding-aware editor before opening")
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return errors.New("TEXT_BINARY_NUL: NUL bytes indicate binary or unsupported encoded data; this file cannot be safely edited as UTF-8 text")
	}
	return nil
}

func unsupportedFile(path string) error {
	return fmt.Errorf("FILE_UNSUPPORTED_TYPE: %q is not a regular file; links and special files are not safely replaceable", path)
}

// unsupportedReadFile is the read-side counterpart. The path has already been
// resolved with os.Stat, so only the final target's type is rejected; links
// encountered on the way are followed rather than reported here.
func unsupportedReadFile(path string) error {
	return fmt.Errorf("FILE_UNSUPPORTED_TYPE: %q does not resolve to a regular file; only regular files can be opened as text", path)
}

// checkReadPath is the read-only path policy. Ancestor components may be links
// or reparse points: profiles, OneDrive folders and junctions redirect ordinary
// documents and must stay readable. The final target is resolved with os.Stat,
// following the link, and must be a regular file. Platform syntax checks
// (device namespaces, alternate data streams, reserved names) still run first.
//
// This is a usability boundary, not a sandbox against a process changing
// directory entries between the check and os.ReadFile.
func checkReadPath(path string) error {
	if err := checkPlatformPath(path); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return unsupportedReadFile(path)
	}
	return nil
}

// checkWriteTargetPath is the write-side path policy. Ancestor components may
// be links or reparse points: redirected profiles, OneDrive folders and
// junctions host ordinary documents and must stay saveable. Each existing
// ancestor only has to resolve to a directory; a missing ancestor is an error.
//
// The final target is inspected without following it. It may be absent (a new
// file) or an ordinary regular file, but a symlink, junction, cloud placeholder
// or any other reparse point is refused because replacement would change the
// identity of a different object. Directories and devices are refused too.
// Reads use checkReadPath, which follows the final link instead.
//
// This is a usability boundary, not a sandbox against a process changing
// directory entries between the check and the native operation.
func checkWriteTargetPath(path string) error {
	if err := checkPlatformPath(path); err != nil {
		return err
	}
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		info, err := os.Stat(parent)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return unsupportedFile(parent)
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || isPlatformLink(info) {
		return fmt.Errorf("FILE_UNSUPPORTED_LINK: %q is a link or reparse point; save to its real local path instead", path)
	}
	if !info.Mode().IsRegular() {
		return unsupportedFile(path)
	}
	return nil
}

// Serializing saves also covers case/path aliases without a growing lock map.
// Each publication contains a complete, synced file. Callers may supply a
// stamp verifier for external-change detection; this is still a best-effort
// compare-and-swap, not a cross-process lock.
var fileSaveMu sync.Mutex

type stagedFile interface {
	io.Writer
	Sync() error
	Close() error
	Name() string
}

type saveFileOps struct {
	createTemp func(string, string) (stagedFile, error)
	publish    func(string, string, os.FileInfo) error
}

func defaultSaveFileOps() saveFileOps {
	return saveFileOps{
		createTemp: func(dir, pattern string) (stagedFile, error) { return os.CreateTemp(dir, pattern) },
		publish:    publishFile,
	}
}

func safeWriteFile(path string, data []byte) error {
	return safeWriteFileWithOps(path, data, defaultSaveFileOps())
}

// Operations are injected per call, never via mutable global test hooks. All
// writes, syncs and closes complete before the destination is replaced.
func safeWriteFileWithOps(path string, data []byte, ops saveFileOps) (result error) {
	if err := validateText(data); err != nil {
		return fmt.Errorf("save %q: %w", path, err)
	}
	return safeWriteBytesWithOps(path, data, ops, nil)
}

// safeWriteBytesWithOps publishes already-encoded bytes through the same
// atomic replacement pipeline. Unlike safeWriteFile it cannot validate the
// bytes as UTF-8 (UTF-16 contains NUL bytes), so callers must validate the
// editor string before encoding. verify, when non-nil, is called with the
// absolute destination before staging and again immediately before
// publication; it is used for external-change (stamp) checks.
func safeWriteBytesWithOps(path string, data []byte, ops saveFileOps, verify func(string) error) (result error) {
	if path == "" {
		return os.ErrInvalid
	}
	// On Windows Abs uses GetFullPathName, which can strip trailing dots or
	// spaces. Refuse ambiguous raw input before that normalization loses it.
	if err := checkPlatformPath(path); err != nil {
		return err
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	fileSaveMu.Lock()
	defer fileSaveMu.Unlock()

	if verify != nil {
		if err := verify(path); err != nil {
			return err
		}
	}
	original, err := inspectSaveTarget(path)
	if err != nil {
		return fmt.Errorf("check save target %q: %w", path, err)
	}
	file, err := ops.createTemp(filepath.Dir(path), ".coteditor-save-*")
	if err != nil {
		return fmt.Errorf("create save temporary file for %q: %w", path, err)
	}
	temp := file.Name()
	closed := false
	defer func() {
		if !closed {
			if err := file.Close(); err != nil {
				result = errors.Join(result, fmt.Errorf("close temporary file %q: %w", temp, err))
			}
		}
		if err := os.Remove(temp); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, fmt.Errorf("clean up temporary file %q: %w", temp, err))
		}
	}()

	n, err := file.Write(data)
	if err != nil {
		return fmt.Errorf("write temporary file for %q: %w", path, err)
	}
	if n != len(data) {
		return fmt.Errorf("write temporary file for %q: %w", path, io.ErrShortWrite)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync temporary file for %q: %w", path, err)
	}
	closed = true
	if err := file.Close(); err != nil {
		return fmt.Errorf("close temporary file for %q: %w", path, err)
	}
	// Recheck links, write access and identity immediately before publication.
	// Best effort only: an in-place external write keeps the identity, a
	// delete-and-recreate may reuse the file ID, and there is no version token.
	// The caller's stamp verifier (when present) narrows this window further.
	current, err := inspectSaveTarget(path)
	if err != nil {
		return fmt.Errorf("recheck save target %q: %w", path, err)
	}
	if (original == nil) != (current == nil) || (original != nil && !os.SameFile(original, current)) {
		return fmt.Errorf("FILE_TARGET_CHANGED: %q changed identity during this save; reopen it before retrying", path)
	}
	// A compare-and-swap style guard cannot make this race-free, but checking
	// the disk baseline again immediately before publication catches external
	// edits that landed while the temporary file was being written.
	if verify != nil {
		if err := verify(path); err != nil {
			return err
		}
	}
	if err := ops.publish(temp, path, current); err != nil {
		return fmt.Errorf("publish saved file %q: %w", path, err)
	}
	return nil
}

// FileStamp is the disk baseline used for external-change detection. ModTime
// is UnixNano. A missing file is reported as Exists=false with zero values.
type FileStamp struct {
	Exists  bool  `json:"exists"`
	Size    int64 `json:"size"`
	ModTime int64 `json:"mod_time"`
}

// fileStamp reads the current stamp. Like opening a file it follows a final
// link; the result is only a hint for conflict detection, not a write target.
func fileStamp(path string) (FileStamp, error) {
	if path == "" {
		return FileStamp{}, os.ErrInvalid
	}
	if err := checkPlatformPath(path); err != nil {
		return FileStamp{}, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return FileStamp{}, err
	}
	info, err := os.Stat(abs)
	if errors.Is(err, os.ErrNotExist) {
		return FileStamp{}, nil
	}
	if err != nil {
		return FileStamp{}, err
	}
	if !info.Mode().IsRegular() {
		return FileStamp{}, unsupportedReadFile(abs)
	}
	return FileStamp{Exists: true, Size: info.Size(), ModTime: info.ModTime().UnixNano()}, nil
}

// checkFileStamp refuses to proceed when the path no longer matches the
// expected baseline. A negative expected value disables that individual
// check. The pair (0, 0) is the "expected to be absent" sentinel produced by
// FileStamp for a missing path; because a real file never has a zero
// modification time, it cannot be confused with an existing empty file.
func checkFileStamp(path string, expectedSize, expectedModTime int64) error {
	if expectedSize == -1 && expectedModTime == -1 {
		return nil
	}
	expectedAbsent := expectedSize == 0 && expectedModTime == 0
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		if expectedAbsent {
			return nil
		}
		return fmt.Errorf("FILE_CONFLICT: %q no longer exists; reload it before saving", path)
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return unsupportedReadFile(path)
	}
	if expectedAbsent {
		return fmt.Errorf("FILE_CONFLICT: %q was created externally; refusing to overwrite it", path)
	}
	if expectedSize != -1 && info.Size() != expectedSize {
		return fmt.Errorf("FILE_CONFLICT: %q changed on disk (size %d, expected %d); reload or save to another path", path, info.Size(), expectedSize)
	}
	if expectedModTime != -1 && info.ModTime().UnixNano() != expectedModTime {
		return fmt.Errorf("FILE_CONFLICT: %q changed on disk (modification time %d, expected %d); reload or save to another path", path, info.ModTime().UnixNano(), expectedModTime)
	}
	return nil
}

func saveTextFile(path, content, encoding string) error {
	return saveTextFileChecked(path, content, encoding, -1, -1)
}

func saveTextFileChecked(path, content, encoding string, expectedSize, expectedModTime int64) error {
	if path == "" {
		return os.ErrInvalid
	}
	data, err := encodeText(content, encoding)
	if err != nil {
		return fmt.Errorf("save %q: %w", path, err)
	}
	return safeWriteBytesWithOps(path, data, defaultSaveFileOps(), func(abs string) error {
		return checkFileStamp(abs, expectedSize, expectedModTime)
	})
}

func inspectSaveTarget(path string) (os.FileInfo, error) {
	if err := checkWriteTargetPath(path); err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, unsupportedFile(path)
	}
	if info.Mode().Perm()&0222 == 0 {
		return nil, fmt.Errorf("FILE_READ_ONLY: %q is read-only: %w", path, os.ErrPermission)
	}
	if err := checkWritableTarget(path, info); err != nil {
		return nil, err
	}
	return info, nil
}

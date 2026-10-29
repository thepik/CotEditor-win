package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileStampReportsDiskState(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "stamp.txt")

	missing, err := fileStamp(path)
	if err != nil {
		t.Fatal(err)
	}
	if missing != (FileStamp{}) {
		t.Fatalf("missing file stamp = %#v", missing)
	}

	putTestFile(t, path, []byte("hello"))
	stamp, err := fileStamp(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !stamp.Exists || stamp.Size != info.Size() || stamp.ModTime != info.ModTime().UnixNano() {
		t.Fatalf("stamp does not match stat: %#v vs %#v", stamp, info)
	}

	if _, err := fileStamp(""); err == nil {
		t.Fatal("empty stamp path was accepted")
	}
	if _, err := fileStamp(dir); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
		t.Fatalf("directory stamp was accepted: %v", err)
	}
}

func TestSaveFileCheckedHonorsStamp(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "checked.txt")
	putTestFile(t, path, []byte("original"))
	stamp, err := fileStamp(path)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := NewApp().SaveFileChecked(path, "first update", encodingUTF8, stamp.Size, stamp.ModTime); err != nil {
		t.Fatal(err)
	}
	requireFileBytes(t, path, []byte("first update"))

	// The baseline is now stale; an external edit must not be overwritten.
	putTestFile(t, path, []byte("external edit that is longer"))
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewApp().SaveFileChecked(path, "our update", encodingUTF8, stamp.Size, stamp.ModTime)
	if err == nil || !strings.Contains(err.Error(), "FILE_CONFLICT:") {
		t.Fatalf("stale stamp was accepted: %v", err)
	}
	requireFileBytes(t, path, before)

	// -1 disables the check.
	if _, err := NewApp().SaveFileChecked(path, "forced", encodingUTF8, -1, -1); err != nil {
		t.Fatal(err)
	}
	requireFileBytes(t, path, []byte("forced"))
	forcedStamp, err := fileStamp(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewApp().SaveFileChecked(path, "forced again", encodingUTF8, forcedStamp.Size, -1); err != nil {
		t.Fatalf("size-only check should still pass before the write: %v", err)
	}
	requireNoSaveTemps(t, dir)
}

func TestSaveFileCheckedExpectedAbsent(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "new.txt")

	if _, err := NewApp().SaveFileChecked(path, "created", encodingUTF8, 0, 0); err != nil {
		t.Fatalf("expected-absent save failed: %v", err)
	}
	requireFileBytes(t, path, []byte("created"))

	if _, err := NewApp().SaveFileChecked(path, "overwrite", encodingUTF8, 0, 0); err == nil || !strings.Contains(err.Error(), "FILE_CONFLICT:") {
		t.Fatalf("file created after an absent baseline was overwritten: %v", err)
	}
	requireFileBytes(t, path, []byte("created"))
	requireNoSaveTemps(t, dir)
}

func TestSaveFileCheckedRechecksBeforePublish(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "racing.txt")
	putTestFile(t, path, []byte("original"))
	stamp, err := fileStamp(path)
	if err != nil {
		t.Fatal(err)
	}

	ops := defaultSaveFileOps()
	ops.createTemp = func(parent, pattern string) (stagedFile, error) {
		// Simulate an external writer landing after the pre-write check.
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			return nil, err
		}
		if _, err := file.Write([]byte(" + external")); err != nil {
			file.Close()
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
		return os.CreateTemp(parent, pattern)
	}
	ops.publish = func(string, string, os.FileInfo) error {
		t.Fatal("published despite a stale stamp")
		return nil
	}

	err = safeWriteBytesWithOps(path, []byte("our data"), ops, func(abs string) error {
		return checkFileStamp(abs, stamp.Size, stamp.ModTime)
	})
	if err == nil || !strings.Contains(err.Error(), "FILE_CONFLICT:") {
		t.Fatalf("staging-time change was not detected: %v", err)
	}
	requireFileBytes(t, path, []byte("original + external"))
	requireNoSaveTemps(t, dir)
}

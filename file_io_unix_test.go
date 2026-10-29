//go:build unix

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestUnixPreservesPermissionsAndOwnership(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "private.txt")
	putTestFile(t, path, []byte("old"))
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := safeWriteFile(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	oldStat := before.Sys().(*syscall.Stat_t)
	newStat := after.Sys().(*syscall.Stat_t)
	if after.Mode() != before.Mode() || oldStat.Uid != newStat.Uid || oldStat.Gid != newStat.Gid {
		t.Fatal("permissions or ownership changed")
	}
	requireFileBytes(t, path, []byte("new"))
	requireNoSaveTemps(t, dir)
}

func TestUnixRejectsFIFOWithoutOpeningIt(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "pipe")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := safeWriteFile(path, []byte("new")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
		t.Fatalf("FIFO was not refused: %v", err)
	}
	if _, err := readFileAt(path); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
		t.Fatalf("FIFO read was not refused: %v", err)
	}
	requireNoSaveTemps(t, dir)
}

func TestUnixNewPublicationDoesNotOverwriteExistingFile(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "destination.txt")
	temp := filepath.Join(dir, "staged.txt")
	putTestFile(t, path, []byte("appeared externally"))
	putTestFile(t, temp, []byte("new data"))
	if err := publishFile(temp, path, nil); err == nil {
		t.Fatal("new-file publication overwrote an existing file")
	}
	requireFileBytes(t, path, []byte("appeared externally"))
	requireFileBytes(t, temp, []byte("new data"))
}

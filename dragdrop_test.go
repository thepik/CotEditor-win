package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeFileInfo lets the filter tests exercise file kinds (directories, pipes,
// ...) without creating special files on disk.
type fakeFileInfo struct {
	mode os.FileMode
}

func (f fakeFileInfo) Name() string       { return "fake" }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() os.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeFileInfo) Sys() interface{}   { return nil }

func TestCleanDroppedPathsFiltersBlanksAndDuplicates(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.txt")
	second := filepath.Join(dir, "nested", "second.txt")

	got := cleanDroppedPaths([]string{
		"",
		"   ",
		first,
		filepath.Join(dir, ".", "first.txt"),
		filepath.Join(dir, "nested", "..", "first.txt"),
		second,
	})

	want := []string{first, second}
	if len(got) != len(want) {
		t.Fatalf("cleanDroppedPaths() = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("cleanDroppedPaths()[%d] = %q, want %q (full result %#v)", i, got[i], want[i], got)
		}
	}
}

func TestCleanDroppedPathsMakesRelativePathsAbsolute(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	const relative = "relative-target.txt"
	want := filepath.Join(dir, relative)

	got := cleanDroppedPaths([]string{relative})
	if len(got) != 1 {
		t.Fatalf("cleanDroppedPaths(%q) = %#v, want one path", relative, got)
	}
	if !filepath.IsAbs(got[0]) {
		t.Fatalf("cleanDroppedPaths(%q)[0] = %q, want an absolute path", relative, got[0])
	}
	if got[0] != want {
		t.Fatalf("cleanDroppedPaths(%q)[0] = %q, want %q", relative, got[0], want)
	}
}

func TestCleanDroppedPathsDeduplicatesCaseInsensitivelyOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows paths are case-insensitive")
	}
	path := filepath.Join(t.TempDir(), "MixedCase.txt")

	got := cleanDroppedPaths([]string{path, strings.ToUpper(path)})
	if len(got) != 1 {
		t.Fatalf("cleanDroppedPaths() = %#v, want one case-insensitive duplicate", got)
	}
}

func TestNormalizeDroppedPathsRejectsMissingAndDirectories(t *testing.T) {
	dir := t.TempDir()
	regular := filepath.Join(dir, "regular.txt")
	if err := os.WriteFile(regular, []byte("text"), 0o600); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(dir, "subdir")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing.txt")

	got := normalizeDroppedPaths([]string{
		regular,
		subdir,
		missing,
		"",
		regular,
	}, os.Stat)

	if len(got) != 1 || got[0] != regular {
		t.Fatalf("normalizeDroppedPaths() = %#v, want [%q]", got, regular)
	}
}

func TestNormalizeDroppedPathsRejectsNonRegularFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-file")

	pipeStat := func(string) (os.FileInfo, error) {
		return fakeFileInfo{mode: os.ModeNamedPipe}, nil
	}
	if got := normalizeDroppedPaths([]string{path}, pipeStat); len(got) != 0 {
		t.Fatalf("normalizeDroppedPaths() with a pipe = %#v, want no paths", got)
	}

	errorStat := func(string) (os.FileInfo, error) {
		return nil, errors.New("stat failed")
	}
	if got := normalizeDroppedPaths([]string{path}, errorStat); len(got) != 0 {
		t.Fatalf("normalizeDroppedPaths() with a stat error = %#v, want no paths", got)
	}
}

func TestNormalizeDroppedPathsAcceptsRegularFileOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accepted.txt")
	stat := func(string) (os.FileInfo, error) {
		return fakeFileInfo{mode: 0o644}, nil
	}

	got := normalizeDroppedPaths([]string{path, path}, stat)
	if len(got) != 1 || got[0] != path {
		t.Fatalf("normalizeDroppedPaths() = %#v, want [%q]", got, path)
	}
}

func TestHandleDroppedPathsIsNoOpWithoutContext(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dropped.txt")
	if err := os.WriteFile(path, []byte("text"), 0o600); err != nil {
		t.Fatal(err)
	}

	// NewApp has no Wails context yet; a drop arriving then must not emit (or
	// panic), and must not read the file.
	app := NewApp()
	app.handleDroppedPaths([]string{path})
}

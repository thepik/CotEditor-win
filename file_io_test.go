package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func testDirectory(t *testing.T) string {
	t.Helper()
	// Resolve system temporary-directory aliases, e.g. /var on macOS. Individual
	// link tests below deliberately pass unresolved linked paths.
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func putTestFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
}

func requireFileBytes(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("file bytes changed: got %q, want %q", got, want)
	}
}

func requireNoSaveTemps(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".coteditor-") {
			t.Errorf("save artifact not cleaned up: %s", entry.Name())
		}
	}
}

func TestReadFileAtPreservesText(t *testing.T) {
	for _, test := range []struct {
		name, text, content, encoding, eol string
		mixed                              bool
	}{
		{"empty", "", "", "UTF-8", "lf", false},
		{"utf8", "你好, café 日本語\n", "你好, café 日本語\n", "UTF-8", "lf", false},
		{"utf8-bom", "\ufeffHello\n", "Hello\n", "UTF-8 BOM", "lf", false},
		{"bom-only", "\ufeff", "", "UTF-8 BOM", "lf", false},
		{"crlf", "one\r\ntwo\r\n", "one\r\ntwo\r\n", "UTF-8", "crlf", false},
		{"cr", "one\rtwo\r", "one\rtwo\r", "UTF-8", "cr", false},
		{"mixed", "one\r\ntwo\nthree\rfour\r\n", "one\r\ntwo\nthree\rfour\r\n", "UTF-8", "crlf", true},
		{"mixed-cr-lf", "one\rtwo\n", "one\rtwo\n", "UTF-8", "cr", true},
		{"text-controls", "\t\n\v\f\r\x1b[31m\b\x7f\x1a", "\t\n\v\f\r\x1b[31m\b\x7f\x1a", "UTF-8", "cr", true},
		{"literal-replacement-character", "valid \ufffd text", "valid \ufffd text", "UTF-8", "lf", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(testDirectory(t), "text.txt")
			putTestFile(t, path, []byte(test.text))
			got, err := readFileAt(path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Path == nil || *got.Path != path || got.Content != test.content ||
				got.Encoding != test.encoding || got.LineEnding != test.eol || got.MixedLineEnding != test.mixed {
				t.Fatalf("unexpected file result: %#v", got)
			}
			wire, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var decoded FileContent
			if err := json.Unmarshal(wire, &decoded); err != nil {
				t.Fatal(err)
			}
			if decoded.Content != test.content || decoded.MixedLineEnding != test.mixed {
				t.Fatalf("JSON changed text or mixed flag: %q %#v", decoded.Content, decoded)
			}
			requireFileBytes(t, path, []byte(test.text))
		})
	}
}

func TestReadFileAtFollowsLinksToRegularFiles(t *testing.T) {
	dir := testDirectory(t)
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(realDir, "document.txt")
	content := []byte("readable through a link\n")
	putTestFile(t, path, content)

	for _, test := range []struct {
		name string
		make func(string) error
	}{
		{"file-symlink", func(link string) error { return os.Symlink(path, link) }},
		{"directory-symlink", func(link string) error { return os.Symlink(realDir, link) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			link := filepath.Join(dir, test.name)
			if err := test.make(link); err != nil {
				t.Skipf("link creation unavailable: %v", err)
			}
			if test.name == "directory-symlink" {
				if _, err := readFileAt(link); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
					t.Fatalf("directory link was opened as text: %v", err)
				}
			}
			target := link
			if test.name == "directory-symlink" {
				target = filepath.Join(link, "document.txt")
			}
			got, err := readFileAt(target)
			if err != nil {
				t.Fatalf("read through a link failed: %v", err)
			}
			if got.Path == nil || *got.Path != target || got.Content != string(content) {
				t.Fatalf("unexpected link read: %#v", got)
			}
			if test.name == "directory-symlink" {
				// Writing may follow a linked parent directory: the document
				// itself is the ordinary file at the resolved path.
				if err := safeWriteFile(target, []byte("replacement")); err != nil {
					t.Fatalf("write through a linked parent directory failed: %v", err)
				}
				requireFileBytes(t, path, []byte("replacement"))
			} else {
				// A linked final target is still refused so replacement cannot
				// change the identity of the object behind the link.
				if err := safeWriteFile(target, []byte("replacement")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_LINK:") {
					t.Fatalf("write through a link was not refused: %v", err)
				}
				requireFileBytes(t, path, content)
			}
			requireNoSaveTemps(t, dir)
		})
	}
}

func TestReadAndSaveRejectUnsupportedText(t *testing.T) {
	for _, test := range []struct {
		name, openCode, saveCode string
		data                     []byte
	}{
		{"invalid-byte", "DECODING_FAILED", "TEXT_INVALID_UTF8", []byte{'a', 0xff, 'b'}},
		{"invalid-gb-sequence", "DECODING_FAILED", "TEXT_INVALID_UTF8", []byte{0x81}},
		{"nul", "TEXT_BINARY_NUL", "TEXT_BINARY_NUL", []byte("hello\x00world")},
		{"nul-only", "TEXT_BINARY_NUL", "TEXT_BINARY_NUL", []byte{0}},
		{"utf16-nul", "TEXT_BINARY_NUL", "TEXT_INVALID_UTF8", []byte{0xff, 0xfe, 0x00, 0x00}},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, "unsupported.txt")
			putTestFile(t, path, test.data)
			got, err := NewApp().OpenPath(path)
			if err == nil || !strings.Contains(err.Error(), test.openCode+":") {
				t.Fatalf("expected %s, got %v", test.openCode, err)
			}
			if got != (FileContent{}) {
				t.Fatalf("rejected bytes leaked to the frontend: %#v", got)
			}
			requireFileBytes(t, path, test.data)
			if _, err := NewApp().SaveFile(path, string(test.data)); err == nil || !strings.Contains(err.Error(), test.saveCode+":") {
				t.Fatalf("save should also reject invalid text: %v", err)
			}
			requireFileBytes(t, path, test.data)
			requireNoSaveTemps(t, dir)
		})
	}
}

func TestSafeWriteExistingAndNewFile(t *testing.T) {
	for _, existing := range []bool{false, true} {
		for _, content := range []string{"", "你好\n", "\ufeffBOM\r\n", "one\r\ntwo\nthree\r"} {
			t.Run(fmt.Sprintf("existing=%t/content=%q", existing, content), func(t *testing.T) {
				dir := testDirectory(t)
				path := filepath.Join(dir, "document.txt")
				if existing {
					putTestFile(t, path, []byte("old bytes that must not survive truncation"))
				}
				got, err := NewApp().SaveFile(path, content)
				if err != nil {
					t.Fatal(err)
				}
				if got != path {
					t.Fatalf("save path = %q", got)
				}
				requireFileBytes(t, path, []byte(content))
				requireNoSaveTemps(t, dir)
			})
		}
	}
}

var errInjectedSave = errors.New("injected disk failure")

type failingStagedFile struct {
	*os.File
	failAt string
	calls  *[]string
}

func (f *failingStagedFile) Write(data []byte) (int, error) {
	*f.calls = append(*f.calls, "write")
	if f.failAt == "write" || f.failAt == "short-write" {
		n, err := f.File.Write(data[:len(data)/2])
		if err != nil {
			return n, err
		}
		if f.failAt == "short-write" {
			return n, nil
		}
		return n, errInjectedSave
	}
	return f.File.Write(data)
}

func (f *failingStagedFile) Sync() error {
	*f.calls = append(*f.calls, "sync")
	if f.failAt == "sync" {
		return errInjectedSave
	}
	return f.File.Sync()
}

func (f *failingStagedFile) Close() error {
	*f.calls = append(*f.calls, "close")
	err := f.File.Close()
	if f.failAt == "close" {
		return errors.Join(err, errInjectedSave)
	}
	return err
}

func TestSafeWriteFailureLeavesOriginalAndCleansTemps(t *testing.T) {
	for _, existing := range []bool{false, true} {
		for _, stage := range []string{"create", "write", "short-write", "sync", "close", "publish"} {
			t.Run(fmt.Sprintf("existing=%t/%s", existing, stage), func(t *testing.T) {
				dir := testDirectory(t)
				path := filepath.Join(dir, "document.txt")
				old := []byte("original bytes\r\n")
				if existing {
					putTestFile(t, path, old)
				}
				var calls []string
				ops := defaultSaveFileOps()
				ops.createTemp = func(parent, pattern string) (stagedFile, error) {
					if parent != dir {
						t.Fatalf("temporary file not in destination directory: %q", parent)
					}
					if stage == "create" {
						return nil, errInjectedSave
					}
					f, err := os.CreateTemp(parent, pattern)
					if err != nil {
						return nil, err
					}
					return &failingStagedFile{File: f, failAt: stage, calls: &calls}, nil
				}
				ops.publish = func(temp, target string, info os.FileInfo) error {
					calls = append(calls, "publish")
					if stage != "publish" {
						t.Fatal("published after an earlier failure")
					}
					requireFileBytes(t, temp, []byte("replacement content"))
					if strings.Join(calls, ",") != "write,sync,close,publish" {
						t.Fatalf("unsafe operation ordering: %v", calls)
					}
					return errInjectedSave
				}
				err := safeWriteFileWithOps(path, []byte("replacement content"), ops)
				want := errInjectedSave
				if stage == "short-write" {
					want = io.ErrShortWrite
				}
				if !errors.Is(err, want) {
					t.Fatalf("expected actionable %s failure, got %v", stage, err)
				}
				if existing {
					requireFileBytes(t, path, old)
				} else if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("failed save created a destination: %v", err)
				}
				requireNoSaveTemps(t, dir)
			})
		}
	}
}

func TestSafeWriteReadOnly(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "readonly.txt")
	old := []byte("keep original")
	putTestFile(t, path, old)
	if err := os.Chmod(path, 0400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0600) })
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := safeWriteFile(path, []byte("new")); err == nil || !errors.Is(err, os.ErrPermission) {
		t.Fatalf("expected read-only refusal, got %v", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if before.Mode() != after.Mode() {
		t.Fatal("read-only permissions were changed")
	}
	requireFileBytes(t, path, old)
	requireNoSaveTemps(t, dir)
}

func TestSafeWriteRejectsLinkTargets(t *testing.T) {
	for _, kind := range []string{"hardlink", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, "original.txt")
			old := []byte("keep identity and content")
			putTestFile(t, path, old)
			link := filepath.Join(dir, "link.txt")
			var err error
			switch kind {
			case "hardlink":
				err = os.Link(path, link)
			case "symlink":
				err = os.Symlink(path, link)
			}
			if err != nil {
				t.Skipf("link creation unavailable: %v", err)
			}
			if err := safeWriteFile(link, []byte("replacement")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_LINK:") {
				t.Fatalf("expected link refusal, got %v", err)
			}
			requireFileBytes(t, path, old)
			requireFileBytes(t, link, old)
			requireNoSaveTemps(t, dir)
		})
	}
}

// A linked parent directory redirects an ordinary document location (profiles,
// OneDrive, junctions). Saving must reach the regular file behind it and leave
// a newly created sibling there as well.
func TestSafeWriteFollowsLinkedParentDirectory(t *testing.T) {
	dir := testDirectory(t)
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(realDir, "original.txt")
	old := []byte("keep this until overwritten")
	putTestFile(t, path, old)
	linkDir := filepath.Join(dir, "linked")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Skipf("link creation unavailable: %v", err)
	}

	if err := safeWriteFile(filepath.Join(linkDir, "original.txt"), []byte("replacement")); err != nil {
		t.Fatalf("overwrite through a linked parent failed: %v", err)
	}
	requireFileBytes(t, path, []byte("replacement"))
	if err := safeWriteFile(filepath.Join(linkDir, "created.txt"), []byte("new file")); err != nil {
		t.Fatalf("create through a linked parent failed: %v", err)
	}
	requireFileBytes(t, filepath.Join(realDir, "created.txt"), []byte("new file"))
	requireNoSaveTemps(t, dir)
	requireNoSaveTemps(t, realDir)
}

func TestSafeWriteRejectsDirectoryAndMissingParent(t *testing.T) {
	dir := testDirectory(t)
	if err := safeWriteFile(dir, []byte("new")); err == nil {
		t.Fatal("accepted directory as a file")
	}
	if _, err := readFileAt(dir); err == nil {
		t.Fatal("opened directory as text")
	}
	if err := safeWriteFile(filepath.Join(dir, "missing", "file.txt"), []byte("new")); err == nil {
		t.Fatal("silently created missing parent")
	}
	requireNoSaveTemps(t, dir)
}

// A file that appears at a previously absent destination while staging must not
// be overwritten. Replacing an existing target externally is only best-effort
// guarded: delete-and-recreate may reuse the file ID, and detecting external
// content changes belongs to phase B.
func TestSafeWriteDoesNotOverwriteFileCreatedDuringStaging(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "document.txt")
	ops := defaultSaveFileOps()
	ops.createTemp = func(parent, pattern string) (stagedFile, error) {
		putTestFile(t, path, []byte("external data"))
		return os.CreateTemp(parent, pattern)
	}
	err := safeWriteFileWithOps(path, []byte("new content"), ops)
	if err == nil || !strings.Contains(err.Error(), "FILE_TARGET_CHANGED:") {
		t.Fatalf("expected target-change refusal, got %v", err)
	}
	requireFileBytes(t, path, []byte("external data"))
	requireNoSaveTemps(t, dir)
}

func TestConcurrentSavesPublishWholeFiles(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "shared.txt")
	const count = 16
	contents := make([]string, count)
	var wg sync.WaitGroup
	for i := range contents {
		contents[i] = strings.Repeat(fmt.Sprintf("writer-%02d\r\n", i), 16000)
		wg.Add(1)
		go func(content string) {
			defer wg.Done()
			if _, err := NewApp().SaveFile(path, content); err != nil {
				t.Errorf("concurrent save: %v", err)
			}
		}(contents[i])
	}
	wg.Wait()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	whole := false
	for _, content := range contents {
		whole = whole || string(got) == content
	}
	if !whole {
		t.Fatal("destination contains partial or interleaved writes")
	}
	requireNoSaveTemps(t, dir)
}

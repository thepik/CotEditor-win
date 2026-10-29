package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A real 1x1 transparent PNG, so extension and sniffing tests use valid image
// bytes rather than a placeholder that happens to start with a signature.
const testPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

func testPNG(t *testing.T) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(testPNGBase64)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testSVG() []byte {
	return []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>`)
}

func TestReadAssetBase64ReturnsOneEncodedFile(t *testing.T) {
	png := testPNG(t)
	svg := testSVG()
	cases := []struct {
		name string
		file string
		mime string
		want []byte
	}{
		{"png-extension", "image.png", "image/png", png},
		{"uppercase-extension", "diagram.SVG", "image/svg+xml", svg},
		{"unknown-extension-sniffs", "payload.asset", "image/png", png},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, test.file)
			putTestFile(t, path, test.want)

			got, err := NewApp().ReadAssetBase64(path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Path != path {
				t.Fatalf("path = %q, want %q", got.Path, path)
			}
			if got.Mime != test.mime {
				t.Fatalf("mime = %q, want %q", got.Mime, test.mime)
			}
			if got.Size != int64(len(test.want)) {
				t.Fatalf("size = %d, want %d", got.Size, len(test.want))
			}
			if got.Data != base64.StdEncoding.EncodeToString(test.want) {
				t.Fatalf("data is not standard base64 of the file bytes")
			}
			decoded, err := base64.StdEncoding.DecodeString(got.Data)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(decoded, test.want) {
				t.Fatalf("decoded asset differs from the source file")
			}
			// Reading for preview must not modify or create anything.
			requireFileBytes(t, path, test.want)
			requireNoSaveTemps(t, dir)

			wire, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{`"path"`, `"mime"`, `"data"`, `"size"`} {
				if !bytes.Contains(wire, []byte(key)) {
					t.Fatalf("JSON missing %s: %s", key, wire)
				}
			}
			var roundTrip AssetData
			if err := json.Unmarshal(wire, &roundTrip); err != nil {
				t.Fatal(err)
			}
			if roundTrip != got {
				t.Fatalf("JSON round trip changed the asset: %#v", roundTrip)
			}
		})
	}
}

func TestReadAssetBase64RejectsEmptyMissingAndDirectory(t *testing.T) {
	dir := testDirectory(t)
	empty := filepath.Join(dir, "empty.png")
	putTestFile(t, empty, nil)

	got, err := NewApp().ReadAssetBase64(empty)
	if err == nil || !strings.Contains(err.Error(), "ASSET_EMPTY:") {
		t.Fatalf("empty file: expected ASSET_EMPTY, got %v", err)
	}
	if got != (AssetData{}) {
		t.Fatalf("empty file leaked asset data: %#v", got)
	}

	missing := filepath.Join(dir, "missing.png")
	if _, err := NewApp().ReadAssetBase64(missing); err == nil ||
		!strings.Contains(err.Error(), "ASSET_READ_FAILED:") || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file: expected stable ASSET_READ_FAILED, got %v", err)
	}

	if _, err := NewApp().ReadAssetBase64(dir); err == nil ||
		!strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
		t.Fatalf("directory: expected FILE_UNSUPPORTED_TYPE, got %v", err)
	}

	if _, err := NewApp().ReadAssetBase64(""); err == nil ||
		!strings.Contains(err.Error(), "ASSET_INVALID_PATH:") {
		t.Fatalf("empty path: expected ASSET_INVALID_PATH, got %v", err)
	}
}

func TestReadAssetBase64RejectsOversizedFile(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "huge.png")
	putTestFile(t, path, make([]byte, maxAssetBytes+1))

	got, err := NewApp().ReadAssetBase64(path)
	if err == nil || !strings.Contains(err.Error(), "ASSET_TOO_LARGE:") {
		t.Fatalf("expected ASSET_TOO_LARGE, got %v", err)
	}
	if got != (AssetData{}) {
		t.Fatalf("oversized file leaked asset data: %#v", got)
	}
	// The guard must run before encoding, not after building a huge string.
	if strings.Contains(err.Error(), "base64") {
		t.Fatalf("unexpected encoding failure: %v", err)
	}
}

func TestReadAssetBase64FollowsLinksToRegularFiles(t *testing.T) {
	dir := testDirectory(t)
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	png := testPNG(t)
	target := filepath.Join(realDir, "image.png")
	putTestFile(t, target, png)

	t.Run("file-symlink", func(t *testing.T) {
		link := filepath.Join(dir, "image-link.png")
		if err := os.Symlink(target, link); err != nil {
			t.Skipf("link creation unavailable: %v", err)
		}
		got, err := NewApp().ReadAssetBase64(link)
		if err != nil {
			t.Fatalf("read through a file link failed: %v", err)
		}
		if got.Path != link || got.Mime != "image/png" ||
			got.Data != base64.StdEncoding.EncodeToString(png) {
			t.Fatalf("unexpected file-link read: %#v", got)
		}
		requireFileBytes(t, target, png)
	})

	t.Run("directory-symlink", func(t *testing.T) {
		link := filepath.Join(dir, "linked")
		if err := os.Symlink(realDir, link); err != nil {
			t.Skipf("link creation unavailable: %v", err)
		}
		viaLink := filepath.Join(link, "image.png")
		got, err := NewApp().ReadAssetBase64(viaLink)
		if err != nil {
			t.Fatalf("read through a linked parent failed: %v", err)
		}
		if got.Path != viaLink || got.Mime != "image/png" {
			t.Fatalf("unexpected linked-parent read: %#v", got)
		}
		if _, err := NewApp().ReadAssetBase64(link); err == nil ||
			!strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
			t.Fatalf("directory link as final target was not refused: %v", err)
		}
		requireFileBytes(t, target, png)
	})
}

func TestReadAssetBase64FollowsJunctionParent(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junctions are Windows-specific")
	}
	dir := testDirectory(t)
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	png := testPNG(t)
	target := filepath.Join(realDir, "image.png")
	putTestFile(t, target, png)

	linkDir := filepath.Join(dir, "junction")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", linkDir, realDir).CombinedOutput(); err != nil {
		t.Skipf("junction creation unavailable: %v (%s)", err, strings.TrimSpace(string(out)))
	}
	viaLink := filepath.Join(linkDir, "image.png")
	got, err := NewApp().ReadAssetBase64(viaLink)
	if err != nil {
		t.Fatalf("read through a junction parent failed: %v", err)
	}
	if got.Path != viaLink || got.Mime != "image/png" ||
		got.Data != base64.StdEncoding.EncodeToString(png) {
		t.Fatalf("unexpected junction read: %#v", got)
	}
	if _, err := NewApp().ReadAssetBase64(linkDir); err == nil ||
		!strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
		t.Fatalf("junction to a directory was not refused: %v", err)
	}
	requireFileBytes(t, target, png)
}

func TestReadAssetBase64RejectsWindowsUnsafePaths(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows path syntax rules are platform-specific")
	}
	dir := testDirectory(t)
	png := testPNG(t)
	image := filepath.Join(dir, "image.png")
	putTestFile(t, image, png)

	cases := []struct{ name, path string }{
		{"alternate-data-stream", image + ":preview"},
		{"reserved-name", filepath.Join(dir, "NUL.png")},
		{"device-path", `\\?\` + image},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got, err := NewApp().ReadAssetBase64(test.path)
			if err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_PATH:") {
				t.Fatalf("expected FILE_UNSUPPORTED_PATH, got %v", err)
			}
			if got != (AssetData{}) {
				t.Fatalf("unsafe path leaked asset data: %#v", got)
			}
		})
	}
	requireFileBytes(t, image, png)
}

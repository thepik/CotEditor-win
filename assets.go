package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// maxAssetBytes caps one preview asset. The limit is checked from the file
// metadata before reading and again while reading, so a file that grows after
// the first check cannot make the bridge allocate without bound.
const maxAssetBytes int64 = 10 << 20 // 10 MiB

// AssetData is one local file encoded for the Markdown preview. Data is the
// standard base64 encoding of the raw bytes (with padding); Mime describes the
// bytes for the caller's data: URL or blob construction.
type AssetData struct {
	Path string `json:"path"`
	Mime string `json:"mime"`
	Data string `json:"data"`
	Size int64  `json:"size"`
}

// assetMimeTypes is deliberately an explicit, platform-independent map. The
// Windows registry and mime.TypeByExtension vary between machines, which would
// make preview results depend on installed software.
var assetMimeTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
}

// assetMime prefers the filename extension because a Markdown author names the
// asset deliberately. Unknown extensions fall back to content sniffing, which
// returns an explicit charset for textual payloads.
func assetMime(path string, data []byte) string {
	if mime, ok := assetMimeTypes[strings.ToLower(filepath.Ext(path))]; ok {
		return mime
	}
	return http.DetectContentType(data)
}

func assetReadError(path string, err error) error {
	return fmt.Errorf("ASSET_READ_FAILED: read %q: %w", path, err)
}

func assetTooLarge(path string, size int64) error {
	return fmt.Errorf("ASSET_TOO_LARGE: %q is %d bytes; preview assets are limited to %d bytes (10 MiB)", path, size, maxAssetBytes)
}

// ReadAssetBase64 reads exactly one local file for Markdown preview. It is
// read-only and never writes or caches content.
//
// The path policy matches checkReadPath: a junction or symlink in a parent
// directory is followed, and a final link is followed as well, but the object
// reached must be a regular file. Directories, devices, alternate data streams
// and reserved Windows names are refused. Empty files and unreadable files get
// stable ASSET_* errors so the frontend can display a precise message.
//
// This is a single-file bridge, not a local web server: it returns no directory
// listing and accepts no URL, glob or range. It is also not an allowlist. The
// caller must resolve Markdown references relative to the document and decide
// whether that document is trusted; a frontend that forwards arbitrary user or
// page input here would expose every file the editor process can read.
//
// SVG is returned as image/svg+xml without sanitising its XML. If the caller
// renders it as a document (object/iframe rather than img), scripts or external
// references inside the SVG can become active, so that rendering context must
// be avoided or sanitised by the caller.
func (a *App) ReadAssetBase64(path string) (AssetData, error) {
	return readAssetBase64(path)
}

func readAssetBase64(path string) (AssetData, error) {
	if path == "" {
		return AssetData{}, errors.New("ASSET_INVALID_PATH: a file path is required")
	}
	// Run the raw spelling through the platform policy before filepath.Abs:
	// Windows path normalization can silently strip trailing dots or spaces,
	// which would turn an ambiguous name into a different file.
	if err := checkPlatformPath(path); err != nil {
		return AssetData{}, err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return AssetData{}, assetReadError(path, err)
	}
	if err := checkReadPath(abs); err != nil {
		// Keep path-policy and type errors as their own FILE_* codes. Any
		// underlying filesystem error (missing, permission, sharing) becomes the
		// same stable read code as a failure later in this function.
		var pathErr *os.PathError
		if errors.As(err, &pathErr) {
			return AssetData{}, assetReadError(abs, err)
		}
		return AssetData{}, err
	}

	file, err := os.Open(abs)
	if err != nil {
		return AssetData{}, assetReadError(abs, err)
	}
	defer file.Close()

	// Re-check on the opened handle so the bytes read come from the same
	// regular file whose size was inspected, narrowing the stat/open window.
	info, err := file.Stat()
	if err != nil {
		return AssetData{}, assetReadError(abs, err)
	}
	if !info.Mode().IsRegular() {
		return AssetData{}, unsupportedReadFile(abs)
	}
	if info.Size() > maxAssetBytes {
		return AssetData{}, assetTooLarge(abs, info.Size())
	}

	data, err := io.ReadAll(io.LimitReader(file, maxAssetBytes+1))
	if err != nil {
		return AssetData{}, assetReadError(abs, err)
	}
	if int64(len(data)) > maxAssetBytes {
		return AssetData{}, assetTooLarge(abs, int64(len(data)))
	}
	if len(data) == 0 {
		return AssetData{}, fmt.Errorf("ASSET_EMPTY: %q is empty; there is nothing to preview", abs)
	}

	return AssetData{
		Path: abs,
		Mime: assetMime(abs, data),
		Data: base64.StdEncoding.EncodeToString(data),
		Size: int64(len(data)),
	}, nil
}

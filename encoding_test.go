package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

func encodeFixture(t *testing.T, encoding, content string) []byte {
	t.Helper()
	switch encoding {
	case encodingUTF8:
		return []byte(content)
	case encodingUTF8BOM:
		return append(append([]byte{}, utf8BOM...), content...)
	case encodingUTF16LE, encodingUTF16BE:
		order := unicode.LittleEndian
		bom := utf16LEBOM
		if encoding == encodingUTF16BE {
			order = unicode.BigEndian
			bom = utf16BEBOM
		}
		encoded, _, err := transform.Bytes(unicode.UTF16(order, unicode.IgnoreBOM).NewEncoder(), []byte(content))
		if err != nil {
			t.Fatal(err)
		}
		return append(append([]byte{}, bom...), encoded...)
	case encodingGB18030:
		data, err := encodeText(content, encoding)
		if err != nil {
			t.Fatal(err)
		}
		return data
	default:
		t.Fatalf("unsupported fixture encoding %q", encoding)
		return nil
	}
}

func TestReadFileAtDetectsEncodings(t *testing.T) {
	for _, test := range []struct {
		name, encoding, content, eol string
		mixed                        bool
	}{
		{name: "utf8", encoding: encodingUTF8, content: "plain 中文\n", eol: "lf"},
		{name: "utf8-bom", encoding: encodingUTF8BOM, content: "bom 中文\r\n", eol: "crlf"},
		{name: "utf16le", encoding: encodingUTF16LE, content: "你好\r\n世界\n", eol: "crlf", mixed: true},
		{name: "utf16be", encoding: encodingUTF16BE, content: "你好\r\n世界\n", eol: "crlf", mixed: true},
		{name: "gb18030", encoding: encodingGB18030, content: "中文 GB18030\r\n", eol: "crlf"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, "detect.txt")
			data := encodeFixture(t, test.encoding, test.content)
			putTestFile(t, path, data)

			got, err := readFileAt(path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Content != test.content || got.Encoding != test.encoding || got.LineEnding != test.eol || got.MixedLineEnding != test.mixed {
				t.Fatalf("unexpected detection: %#v", got)
			}
			if strings.HasPrefix(got.Content, "\ufeff") || strings.ContainsRune(got.Content, 0) {
				t.Fatalf("content leaked a BOM or NUL: %q", got.Content)
			}
			requireFileBytes(t, path, data)

			// Re-interpreting with the same encoding must produce the same text.
			again, err := readFileAtWithEncoding(path, test.encoding)
			if err != nil {
				t.Fatal(err)
			}
			if again.Content != test.content || again.Encoding != test.encoding {
				t.Fatalf("explicit decode differs: %#v", again)
			}
		})
	}
}

func TestSaveWithEncodingRoundTripAndBOMRules(t *testing.T) {
	content := "中文 café 😀\r\nsecond line\n"
	for _, test := range []struct {
		encoding string
		bom      []byte
	}{
		{encodingUTF8, nil},
		{encodingUTF8BOM, utf8BOM},
		{encodingUTF16LE, utf16LEBOM},
		{encodingUTF16BE, utf16BEBOM},
		{encodingGB18030, nil},
	} {
		t.Run(test.encoding, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, "roundtrip.txt")
			if _, err := NewApp().SaveFileWithEncoding(path, content, test.encoding); err != nil {
				t.Fatal(err)
			}
			written, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if test.bom == nil {
				if bytes.HasPrefix(written, utf8BOM) || bytes.HasPrefix(written, utf16LEBOM) || bytes.HasPrefix(written, utf16BEBOM) {
					t.Fatalf("%s unexpectedly wrote a BOM: % x", test.encoding, written[:3])
				}
			} else if !bytes.HasPrefix(written, test.bom) {
				t.Fatalf("%s missing BOM: % x", test.encoding, written)
			}

			got, err := readFileAt(path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Content != content || got.Encoding != test.encoding {
				t.Fatalf("round trip changed content: %#v", got)
			}
			if got.LineEnding != "crlf" || !got.MixedLineEnding {
				t.Fatalf("line ending hint lost: %#v", got)
			}
			requireNoSaveTemps(t, dir)
		})
	}
}

func TestReadFileAtFallsBackToGB18030(t *testing.T) {
	for _, test := range []struct {
		name, content string
		data          []byte
	}{
		{"truncated-utf8-looks-like-gb", "涓", []byte{0xe4, 0xb8}},
		{"overlong-utf8-looks-like-gb", "纮", []byte{0xc0, 0x80}},
		{"gb-chinese", "中文", []byte{0xd6, 0xd0, 0xce, 0xc4}},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(testDirectory(t), "gb.txt")
			putTestFile(t, path, test.data)
			got, err := readFileAt(path)
			if err != nil {
				t.Fatal(err)
			}
			if got.Content != test.content || got.Encoding != encodingGB18030 {
				t.Fatalf("unexpected fallback decode: %#v", got)
			}
		})
	}
}

func TestOpenPathWithEncodingReinterpretsBytes(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "bytes.txt")
	putTestFile(t, path, []byte("中文"))

	auto, err := readFileAt(path)
	if err != nil {
		t.Fatal(err)
	}
	if auto.Encoding != encodingUTF8 || auto.Content != "中文" {
		t.Fatalf("unexpected auto decode: %#v", auto)
	}
	// The UTF-8 bytes contain sequences that are not valid GB18030; an
	// explicit reinterpretation must fail instead of smuggling U+FFFD through.
	if _, err := readFileAtWithEncoding(path, encodingGB18030); err == nil || !strings.Contains(err.Error(), "DECODING_FAILED:") {
		t.Fatalf("invalid GB18030 bytes were accepted: %v", err)
	}
	if _, err := NewApp().OpenPathWithEncoding(path, "UTF-7"); err == nil || !strings.Contains(err.Error(), "DECODING_UNSUPPORTED:") {
		t.Fatalf("unknown encoding was accepted: %v", err)
	}

	gbPath := filepath.Join(dir, "gb.txt")
	putTestFile(t, gbPath, []byte{0xd6, 0xd0, 0xce, 0xc4})
	if _, err := readFileAtWithEncoding(gbPath, encodingUTF8); err == nil || !strings.Contains(err.Error(), "DECODING_FAILED:") {
		t.Fatalf("invalid UTF-8 was accepted explicitly: %v", err)
	}

	// UTF-16 without a BOM is NUL-laden for auto-detection, but an explicit
	// choice reinterprets it as editable text.
	utf16Path := filepath.Join(dir, "utf16.txt")
	putTestFile(t, utf16Path, []byte{'h', 0, 'i', 0})
	if _, err := readFileAt(utf16Path); err == nil || !strings.Contains(err.Error(), "TEXT_BINARY_NUL:") {
		t.Fatalf("BOM-less UTF-16 was not rejected by auto-detection: %v", err)
	}
	got, err := readFileAtWithEncoding(utf16Path, encodingUTF16LE)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "hi" || got.Encoding != encodingUTF16LE {
		t.Fatalf("explicit UTF-16 reinterpretation failed: %#v", got)
	}
}

func TestDecodingRejectsMalformedAndBinaryInput(t *testing.T) {
	dir := testDirectory(t)
	for _, test := range []struct {
		name, code, encoding string
		data                 []byte
	}{
		{"odd-utf16", "DECODING_FAILED", encodingUTF16LE, []byte{0xff, 0xfe, 'a'}},
		{"invalid-utf8", "DECODING_FAILED", encodingUTF8, []byte{'a', 0xff}},
		{"invalid-gb", "DECODING_FAILED", encodingGB18030, []byte{0x81}},
		{"nul-gb", "TEXT_BINARY_NUL", encodingGB18030, []byte{'a', 0, 'b'}},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(dir, "bad.txt")
			putTestFile(t, path, test.data)
			got, err := readFileAtWithEncoding(path, test.encoding)
			if err == nil || !strings.Contains(err.Error(), test.code+":") {
				t.Fatalf("expected %s, got %v", test.code, err)
			}
			if got != (FileContent{}) {
				t.Fatalf("rejected bytes leaked: %#v", got)
			}
		})
	}
}

func TestSaveRejectsUnsupportedEncodingAndLossyContent(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "save.txt")
	if _, err := NewApp().SaveFileWithEncoding(path, "text", "UTF-7"); err == nil || !strings.Contains(err.Error(), "ENCODING_UNSUPPORTED:") {
		t.Fatalf("unknown save encoding was accepted: %v", err)
	}
	if _, err := NewApp().SaveFileWithEncoding(path, "a\x00b", encodingUTF8); err == nil || !strings.Contains(err.Error(), "TEXT_BINARY_NUL:") {
		t.Fatalf("NUL content was accepted: %v", err)
	}
	// x/text maps this private-use rune to a different code point on the way
	// back; refusing is safer than silently changing the character.
	if _, err := NewApp().SaveFileWithEncoding(path, "\ue000", encodingGB18030); err == nil || !strings.Contains(err.Error(), "ENCODING_FAILED:") {
		t.Fatalf("lossy GB18030 content was accepted: %v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("failed encoding created a file: %v", err)
	}
	requireNoSaveTemps(t, dir)
}

func TestAnalyzeLineEndings(t *testing.T) {
	for _, test := range []struct {
		text, ending string
		mixed        bool
	}{
		{"", "lf", false},
		{"one\n", "lf", false},
		{"one\r\n", "crlf", false},
		{"one\r", "cr", false},
		{"one\r\ntwo\n", "crlf", true},
		{"one\rtwo\n", "cr", true},
		{"one\r\ntwo\r", "crlf", true},
	} {
		ending, mixed := analyzeLineEndings(test.text)
		if ending != test.ending || mixed != test.mixed {
			t.Errorf("analyzeLineEndings(%q) = %q,%t; want %q,%t", test.text, ending, mixed, test.ending, test.mixed)
		}
	}
}

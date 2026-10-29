package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Encoding labels exposed through FileContent.Encoding and accepted by the
// *WithEncoding APIs. Keep these strings stable: the frontend stores them.
const (
	encodingUTF8    = "UTF-8"
	encodingUTF8BOM = "UTF-8 BOM"
	encodingUTF16LE = "UTF-16LE"
	encodingUTF16BE = "UTF-16BE"
	encodingGB18030 = "GB18030"
)

var (
	utf8BOM    = []byte{0xEF, 0xBB, 0xBF}
	utf16LEBOM = []byte{0xFF, 0xFE}
	utf16BEBOM = []byte{0xFE, 0xFF}
)

// canonicalEncoding maps the labels the frontend may send (including a few
// plausible spellings) to the stable on-wire labels. Unknown labels are
// rejected rather than silently treated as UTF-8.
func canonicalEncoding(label string) (string, bool) {
	switch strings.ToUpper(strings.TrimSpace(label)) {
	case "UTF-8", "UTF8":
		return encodingUTF8, true
	case "UTF-8 BOM", "UTF-8BOM":
		return encodingUTF8BOM, true
	case "UTF-16LE", "UTF16LE":
		return encodingUTF16LE, true
	case "UTF-16BE", "UTF16BE":
		return encodingUTF16BE, true
	case "GB18030":
		return encodingGB18030, true
	default:
		return "", false
	}
}

// decodeAuto detects an encoding from the byte prefix and content:
// UTF-16 LE/BE BOM, UTF-8 BOM, valid UTF-8, then GB18030. The returned
// content never contains a leading BOM. Bytes that are neither UTF-8 nor
// decodable GB18030, and decoded text containing NUL, are rejected.
func decodeAuto(data []byte) (content, label string, err error) {
	switch {
	case bytes.HasPrefix(data, utf16LEBOM):
		content, err = decodeUTF16(data[len(utf16LEBOM):], unicode.LittleEndian)
		label = encodingUTF16LE
	case bytes.HasPrefix(data, utf16BEBOM):
		content, err = decodeUTF16(data[len(utf16BEBOM):], unicode.BigEndian)
		label = encodingUTF16BE
	case bytes.HasPrefix(data, utf8BOM):
		content, err = decodeUTF8(data[len(utf8BOM):])
		label = encodingUTF8BOM
	case utf8.Valid(data):
		content = string(data)
		label = encodingUTF8
	default:
		content, err = decodeStrict(simplifiedchinese.GB18030, data)
		label = encodingGB18030
	}
	if err != nil {
		return "", "", fmt.Errorf("DECODING_FAILED: content is not valid %s: %w", label, err)
	}
	if err := checkDecodedText(content); err != nil {
		return "", "", err
	}
	return content, label, nil
}

// decodeExplicit re-interprets the same bytes using the caller's encoding.
// It never guesses. UTF-8 and UTF-16 tolerate (and strip) a matching BOM so
// the resulting content is BOM-free like auto-detected content.
func decodeExplicit(data []byte, label string) (string, error) {
	canonical, ok := canonicalEncoding(label)
	if !ok {
		return "", fmt.Errorf("DECODING_UNSUPPORTED: %q is not a supported encoding", label)
	}
	var (
		content string
		err     error
	)
	switch canonical {
	case encodingUTF8:
		content, err = decodeUTF8(bytes.TrimPrefix(data, utf8BOM))
	case encodingUTF8BOM:
		content, err = decodeUTF8(bytes.TrimPrefix(data, utf8BOM))
	case encodingUTF16LE:
		content, err = decodeUTF16(bytes.TrimPrefix(data, utf16LEBOM), unicode.LittleEndian)
	case encodingUTF16BE:
		content, err = decodeUTF16(bytes.TrimPrefix(data, utf16BEBOM), unicode.BigEndian)
	case encodingGB18030:
		content, err = decodeStrict(simplifiedchinese.GB18030, data)
	}
	if err != nil {
		return "", fmt.Errorf("DECODING_FAILED: content is not valid %s: %w", canonical, err)
	}
	if err := checkDecodedText(content); err != nil {
		return "", err
	}
	return content, nil
}

func decodeUTF8(data []byte) (string, error) {
	if !utf8.Valid(data) {
		return "", errors.New("invalid UTF-8 byte sequence")
	}
	return string(data), nil
}

func decodeUTF16(data []byte, order unicode.Endianness) (string, error) {
	if len(data)%2 != 0 {
		return "", errors.New("odd number of bytes")
	}
	return decodeStrict(unicode.UTF16(order, unicode.IgnoreBOM), data)
}

// decodeStrict decodes with the x/text decoder but treats its replacement
// character as an error unless the bytes really are the encoding of U+FFFD.
// x/text's GB18030 and UTF-16 decoders replace invalid sequences instead of
// reporting them, so a plain error check is not enough to reject binary data.
func decodeStrict(enc encoding.Encoding, data []byte) (string, error) {
	out, n, err := transform.Bytes(enc.NewDecoder(), data)
	if err != nil {
		return "", err
	}
	if n != len(data) {
		return "", io.ErrUnexpectedEOF
	}
	if bytes.ContainsRune(out, utf8.RuneError) {
		back, _, encodeErr := transform.Bytes(enc.NewEncoder(), out)
		if encodeErr != nil || !bytes.Equal(back, data) {
			return "", errors.New("invalid byte sequence")
		}
	}
	return string(out), nil
}

func checkDecodedText(content string) error {
	if strings.IndexByte(content, 0) >= 0 {
		return errors.New("TEXT_BINARY_NUL: decoded content contains NUL bytes; this file cannot be safely edited as text")
	}
	return nil
}

// encodeText converts editor content to bytes for the given encoding. BOM
// rules: UTF-8 BOM and both UTF-16 variants get a BOM, plain UTF-8 and
// GB18030 do not. Encoding is lossless or it fails: silent replacement of
// characters the target encoding cannot represent is not acceptable.
func encodeText(content, label string) ([]byte, error) {
	canonical, ok := canonicalEncoding(label)
	if !ok {
		return nil, fmt.Errorf("ENCODING_UNSUPPORTED: %q is not a supported encoding", label)
	}
	if !utf8.ValidString(content) {
		return nil, errors.New("ENCODING_FAILED: content is not valid UTF-8 text")
	}
	if err := checkDecodedText(content); err != nil {
		return nil, err
	}
	switch canonical {
	case encodingUTF8:
		return []byte(content), nil
	case encodingUTF8BOM:
		data := make([]byte, 0, len(utf8BOM)+len(content))
		data = append(data, utf8BOM...)
		return append(data, content...), nil
	case encodingUTF16LE:
		data, err := encodeLossless(unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM), canonical, content)
		if err != nil {
			return nil, err
		}
		return append(append([]byte{}, utf16LEBOM...), data...), nil
	case encodingUTF16BE:
		data, err := encodeLossless(unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM), canonical, content)
		if err != nil {
			return nil, err
		}
		return append(append([]byte{}, utf16BEBOM...), data...), nil
	case encodingGB18030:
		return encodeLossless(simplifiedchinese.GB18030, canonical, content)
	default:
		return nil, fmt.Errorf("ENCODING_UNSUPPORTED: %q is not a supported encoding", label)
	}
}

func encodeLossless(enc encoding.Encoding, label, content string) ([]byte, error) {
	data, _, err := transform.Bytes(enc.NewEncoder(), []byte(content))
	if err != nil {
		return nil, fmt.Errorf("ENCODING_FAILED: content cannot be represented as %s: %w", label, err)
	}
	back, _, err := transform.Bytes(enc.NewDecoder(), data)
	if err != nil || string(back) != content {
		return nil, fmt.Errorf("ENCODING_FAILED: content cannot be represented losslessly as %s", label)
	}
	return data, nil
}

// analyzeLineEndings returns the dominant line ending as a hint plus whether
// more than one style occurs. The bytes themselves are never normalized.
func analyzeLineEndings(text string) (lineEnding string, mixed bool) {
	var lf, crlf, cr bool
	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '\r':
			if i+1 < len(text) && text[i+1] == '\n' {
				crlf = true
				i++
			} else {
				cr = true
			}
		case '\n':
			lf = true
		}
	}
	switch {
	case crlf:
		lineEnding = "crlf"
	case cr:
		lineEnding = "cr"
	default:
		lineEnding = "lf"
	}
	kinds := 0
	for _, present := range []bool{lf, crlf, cr} {
		if present {
			kinds++
		}
	}
	return lineEnding, kinds > 1
}

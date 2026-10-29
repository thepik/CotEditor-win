//go:build !windows && !unix

package main

import (
	"errors"
	"os"
)

func checkPlatformPath(string) error  { return nil }
func isPlatformLink(os.FileInfo) bool { return false }
func checkWritableTarget(string, os.FileInfo) error {
	return errors.New("FILE_UNSUPPORTED_PLATFORM: safe replacement is not implemented on this platform")
}
func publishFile(string, string, os.FileInfo) error {
	return errors.New("FILE_UNSUPPORTED_PLATFORM: safe replacement is not implemented on this platform")
}

//go:build unix

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func checkPlatformPath(string) error  { return nil }
func isPlatformLink(os.FileInfo) bool { return false }

func checkWritableTarget(path string, expected os.FileInfo) error {
	stat, ok := expected.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("FILE_UNSUPPORTED_ATTRIBUTES: cannot inspect the original file metadata")
	}
	if stat.Nlink != 1 {
		return fmt.Errorf("FILE_UNSUPPORTED_LINK: %q has multiple hard links; saving would change its identity", path)
	}
	// Rename permissions alone must not bypass a read-only file's permissions.
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	actual, statErr := file.Stat()
	closeErr := file.Close()
	if err := errors.Join(statErr, closeErr); err != nil {
		return err
	}
	if !os.SameFile(expected, actual) {
		return fmt.Errorf("FILE_TARGET_CHANGED: %q changed identity during the permission check", path)
	}
	return nil
}

func publishFile(temp, path string, original os.FileInfo) error {
	if original == nil {
		// Link publishes a complete file exclusively (unlike Rename, it cannot
		// overwrite a file created in the meantime). The caller removes temp.
		// New documents keep CreateTemp's private 0600 permissions.
		return os.Link(temp, path)
	}
	stat, ok := original.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("FILE_UNSUPPORTED_ATTRIBUTES: cannot preserve file ownership")
	}
	if err := os.Chown(temp, int(stat.Uid), int(stat.Gid)); err != nil {
		return fmt.Errorf("preserve file ownership: %w", err)
	}
	mode := original.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky)
	if err := os.Chmod(temp, mode); err != nil {
		return fmt.Errorf("preserve file permissions: %w", err)
	}
	// Same-directory rename is atomic on Unix. This branch preserves basic
	// ownership/mode, not platform-specific ACLs/xattrs. No claim of directory
	// entry durability on sudden power loss is made by this helper.
	return os.Rename(temp, path)
}

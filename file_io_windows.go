//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var replaceFileW = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReplaceFileW")

func checkPlatformPath(path string) error {
	// Device namespaces and alternate data streams cannot be safely treated as
	// ordinary files. Also reject Win32 names whose normalization changes them.
	path = strings.ReplaceAll(path, "/", `\`)
	volume := filepath.VolumeName(path)
	if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) ||
		strings.Contains(path[len(volume):], ":") {
		return fmt.Errorf("FILE_UNSUPPORTED_PATH: %q is a device path or alternate data stream", path)
	}
	// "C:name" is relative to that drive's current directory, not the process
	// directory, so GetFullPathName would silently move it somewhere unexpected.
	if len(volume) == 2 && volume[1] == ':' && !strings.HasPrefix(path[len(volume):], `\`) {
		return fmt.Errorf("FILE_UNSUPPORTED_PATH: %q is relative to a drive's current directory; use an absolute path", path)
	}
	for _, part := range strings.Split(path[len(volume):], `\`) {
		if part == "" || part == "." || part == ".." {
			continue
		}
		name := strings.ToUpper(strings.TrimRight(strings.SplitN(part, ".", 2)[0], " "))
		reserved := name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" || name == "CONIN$" || name == "CONOUT$"
		if strings.HasPrefix(name, "COM") || strings.HasPrefix(name, "LPT") {
			suffix := name[3:]
			if (len(suffix) == 1 && suffix[0] >= '1' && suffix[0] <= '9') || suffix == "¹" || suffix == "²" || suffix == "³" {
				reserved = true
			}
		}
		if reserved || strings.TrimRight(part, " .") != part {
			return fmt.Errorf("FILE_UNSUPPORTED_PATH: %q contains a reserved or ambiguous Windows filename", path)
		}
	}
	return nil
}

func isPlatformLink(info os.FileInfo) bool {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && data.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

func checkWritableTarget(path string, expected os.FileInfo) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	// Request write/delete access without truncation, and inspect the link itself
	// rather than following reparse points. Never clear read-only or relax ACLs.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.DELETE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return fmt.Errorf("open save target for replacement: %w", err)
	}
	var info windows.ByHandleFileInformation
	statErr := windows.GetFileInformationByHandle(handle, &info)
	closeErr := windows.CloseHandle(handle)
	if err := errors.Join(statErr, closeErr); err != nil {
		return err
	}
	if info.NumberOfLinks != 1 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("FILE_UNSUPPORTED_LINK: %q has multiple hard links or is a reparse point; saving would change its identity", path)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_READONLY != 0 {
		return fmt.Errorf("FILE_READ_ONLY: %q is read-only: %w", path, os.ErrPermission)
	}
	// ReplaceFile preserves compression and encryption, but not every special
	// storage attribute (for example sparse/cloud/integrity-managed files).
	const supported = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN |
		windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_NORMAL |
		windows.FILE_ATTRIBUTE_TEMPORARY | windows.FILE_ATTRIBUTE_COMPRESSED |
		windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED | windows.FILE_ATTRIBUTE_ENCRYPTED
	if info.FileAttributes & ^uint32(supported) != 0 {
		return fmt.Errorf("FILE_UNSUPPORTED_ATTRIBUTES: %q uses special storage attributes that cannot be safely preserved", path)
	}
	return nil
}

func publishFile(temp, path string, original os.FileInfo) error {
	if original == nil {
		// No REPLACE_EXISTING: a new file appearing here must not be overwritten.
		return moveWindowsFile(temp, path)
	}
	attrs, ok := original.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return errors.New("FILE_UNSUPPORTED_ATTRIBUTES: cannot inspect the original file attributes")
	}
	name, err := windows.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	// ReplaceFileW preserves DACLs, creation time, compression, encryption and
	// named streams. Preserve the ordinary DOS flags on the replacement too.
	const dosFlags = windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM |
		windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_TEMPORARY | windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
	flags := attrs.FileAttributes & dosFlags
	if flags == 0 {
		flags = windows.FILE_ATTRIBUTE_NORMAL
	}
	if err := windows.SetFileAttributes(name, flags); err != nil {
		return fmt.Errorf("preserve file attributes: %w", err)
	}
	return replaceWindowsFile(temp, path, nativeReplaceWindowsFile, moveWindowsFile)
}

// Native replacement with strict metadata merging (flags=0), never a
// delete+rename fallback. A backup is essential: without one, documented
// ERROR_UNABLE_TO_MOVE_REPLACEMENT can DELETE the original on failure.
// https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew
func nativeReplaceWindowsFile(temp, path, backup string) error {
	target, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	replacement, err := windows.UTF16PtrFromString(temp)
	if err != nil {
		return err
	}
	previous, err := windows.UTF16PtrFromString(backup)
	if err != nil {
		return err
	}
	r, _, callErr := replaceFileW.Call(uintptr(unsafe.Pointer(target)), uintptr(unsafe.Pointer(replacement)),
		uintptr(unsafe.Pointer(previous)), 0, 0, 0)
	if r == 0 {
		if callErr == windows.ERROR_SUCCESS {
			return syscall.EINVAL
		}
		return callErr
	}
	return nil
}

func moveWindowsFile(from, to string) error {
	source, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_WRITE_THROUGH)
}

func replaceWindowsFile(temp, path string, replace func(string, string, string) error, restore func(string, string) error) error {
	backupFile, err := os.CreateTemp(filepath.Dir(path), ".coteditor-backup-*")
	if err != nil {
		return fmt.Errorf("reserve replacement backup: %w", err)
	}
	backup := backupFile.Name()
	if err := backupFile.Close(); err != nil {
		return errors.Join(err, os.Remove(backup))
	}
	if err := os.Remove(backup); err != nil {
		return fmt.Errorf("prepare replacement backup %q: %w", backup, err)
	}
	if err := replace(temp, path, backup); err != nil {
		// For 1177 the old file was moved to backup. Restore only to an absent
		// destination; never overwrite another process's file during recovery.
		if _, backupErr := os.Lstat(backup); backupErr == nil {
			if _, targetErr := os.Lstat(path); errors.Is(targetErr, os.ErrNotExist) {
				if restoreErr := restore(backup, path); restoreErr == nil {
					return fmt.Errorf("native replacement failed; original restored: %w", err)
				} else {
					return fmt.Errorf("FILE_RECOVERY_REQUIRED: original retained at %q; restore failed: %v; replacement failed: %w", backup, restoreErr, err)
				}
			}
			return fmt.Errorf("FILE_RECOVERY_REQUIRED: original retained at %q; destination was not overwritten during recovery: %w", backup, err)
		} else if !errors.Is(backupErr, os.ErrNotExist) {
			return fmt.Errorf("FILE_RECOVERY_REQUIRED: inspect backup %q (%v); replacement failed: %w", backup, backupErr, err)
		}
		return fmt.Errorf("native replacement failed; original was not replaced: %w", err)
	}
	if err := os.Remove(backup); err != nil {
		// Publication already succeeded: don't pretend the original is unchanged
		// or roll back committed content just because backup cleanup failed.
		return fmt.Errorf("FILE_SAVED_CLEANUP_FAILED: content was saved, but the old-file backup remains at %q: %w", backup, err)
	}
	return nil
}

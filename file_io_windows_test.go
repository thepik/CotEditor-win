//go:build windows

package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func windowsTestName(t *testing.T, path string) *uint16 {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	return name
}

func TestWindowsLockedFileRetainsOriginal(t *testing.T) {
	for _, lateLock := range []bool{false, true} {
		name := "preflight"
		if lateLock {
			name = "native-replacement"
		}
		t.Run(name, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, "locked.txt")
			old := []byte("original locked content")
			putTestFile(t, path, old)
			lock := func() windows.Handle {
				h, err := windows.CreateFile(windowsTestName(t, path), windows.GENERIC_READ,
					windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
				if err != nil {
					t.Fatal(err)
				}
				return h
			}
			ops := defaultSaveFileOps()
			var handle windows.Handle
			if lateLock {
				ops.publish = func(temp, target string, info os.FileInfo) error {
					handle = lock()
					return publishFile(temp, target, info)
				}
			} else {
				handle = lock()
			}
			err := safeWriteFileWithOps(path, []byte("new content"), ops)
			if handle != 0 {
				if closeErr := windows.CloseHandle(handle); closeErr != nil {
					t.Fatal(closeErr)
				}
			}
			if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
				t.Fatalf("expected sharing violation, got %v", err)
			}
			requireFileBytes(t, path, old)
			requireNoSaveTemps(t, dir)
		})
	}
}

func setTestDACL(t *testing.T, path, rights string) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;" + rights + ";;;" + user.User.Sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsPreservesDACLAttributesCreationTimeAndStreams(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "protected.txt")
	putTestFile(t, path, []byte("old"))
	putTestFile(t, path+":metadata", []byte("named-stream-data"))
	setTestDACL(t, path, "FA")
	const attrs = windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM |
		windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
	if err := windows.SetFileAttributes(windowsTestName(t, path), attrs); err != nil {
		t.Fatal(err)
	}
	beforeACL, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	var before windows.Win32FileAttributeData
	if err := windows.GetFileAttributesEx(windowsTestName(t, path), windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&before))); err != nil {
		t.Fatal(err)
	}
	if err := safeWriteFile(path, []byte("new content")); err != nil {
		t.Fatal(err)
	}
	afterACL, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if beforeACL.String() != afterACL.String() {
		t.Fatalf("DACL changed: before=%s after=%s", beforeACL.String(), afterACL.String())
	}
	var after windows.Win32FileAttributeData
	if err := windows.GetFileAttributesEx(windowsTestName(t, path), windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&after))); err != nil {
		t.Fatal(err)
	}
	if after.FileAttributes != attrs || before.CreationTime != after.CreationTime {
		t.Fatalf("attributes or creation time changed: before=%+v after=%+v", before, after)
	}
	requireFileBytes(t, path, []byte("new content"))
	requireFileBytes(t, path+":metadata", []byte("named-stream-data"))
	requireNoSaveTemps(t, dir)
}

const fsctlSetCompression = 0x0009C040

func TestWindowsPreservesNTFSCompression(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "compressed.txt")
	old := bytes.Repeat([]byte("compressible text "), 256)
	putTestFile(t, path, old)

	handle, err := windows.CreateFile(windowsTestName(t, path), windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	format := uint16(1) // COMPRESSION_FORMAT_DEFAULT
	var returned uint32
	compressErr := windows.DeviceIoControl(handle, fsctlSetCompression,
		(*byte)(unsafe.Pointer(&format)), 2, nil, 0, &returned, nil)
	if closeErr := windows.CloseHandle(handle); closeErr != nil {
		t.Fatal(closeErr)
	}
	if compressErr != nil {
		t.Skipf("NTFS compression unavailable: %v", compressErr)
	}
	attributes := func() uint32 {
		var info windows.Win32FileAttributeData
		if err := windows.GetFileAttributesEx(windowsTestName(t, path), windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&info))); err != nil {
			t.Fatal(err)
		}
		return info.FileAttributes
	}
	if attributes()&windows.FILE_ATTRIBUTE_COMPRESSED == 0 {
		t.Skip("volume did not mark the file compressed")
	}

	newContent := []byte("replacement that should stay compressed")
	if err := safeWriteFile(path, newContent); err != nil {
		t.Fatal(err)
	}
	if attributes()&windows.FILE_ATTRIBUTE_COMPRESSED == 0 {
		t.Fatal("compression attribute was lost by replacement")
	}
	requireFileBytes(t, path, newContent)
	requireNoSaveTemps(t, dir)
}

func TestWindowsWriteACLIsNotBypassed(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "no-write.txt")
	old := []byte("do not bypass write access with directory delete access")
	putTestFile(t, path, old)
	// Permit reads, deletion and ACL repair, but not data writes.
	setTestDACL(t, path, "FRSDWDWO")
	t.Cleanup(func() { setTestDACL(t, path, "FA") })
	if err := safeWriteFile(path, []byte("new")); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("expected access denied, got %v", err)
	}
	requireFileBytes(t, path, old)
	requireNoSaveTemps(t, dir)
}

func TestWindowsRejectsDeviceAndStreamPaths(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "document.txt")
	putTestFile(t, path, []byte("old"))
	driveRelative := filepath.VolumeName(path) + "coteditor-drive-relative.txt"
	for _, unsupported := range []string{path + ":stream", filepath.Join(dir, "NUL"), filepath.Join(dir, "CON.txt"), path + ".", path + " ", `\\?\` + path, `\\.\NUL`, driveRelative} {
		if err := safeWriteFile(unsupported, []byte("new")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_PATH:") {
			t.Errorf("expected path refusal for %q, got %v", unsupported, err)
		}
		if _, err := readFileAt(unsupported); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_PATH:") {
			t.Errorf("expected read path refusal for %q, got %v", unsupported, err)
		}
	}
	requireFileBytes(t, path, []byte("old"))
	requireNoSaveTemps(t, dir)
}

func TestWindowsReplacementFailureRecovery(t *testing.T) {
	for _, scenario := range []string{"remove-failed", "move-failed", "restore", "restore-failed", "destination-reappeared"} {
		t.Run(scenario, func(t *testing.T) {
			dir := testDirectory(t)
			path := filepath.Join(dir, "document.txt")
			old := []byte("recover this original content")
			putTestFile(t, path, old)
			var backupPath string
			ops := defaultSaveFileOps()
			ops.publish = func(temp, target string, info os.FileInfo) error {
				replace := func(replacement, destination, backup string) error {
					backupPath = backup
					if scenario == "remove-failed" {
						return windows.ERROR_UNABLE_TO_REMOVE_REPLACED
					}
					if scenario == "move-failed" {
						return windows.ERROR_UNABLE_TO_MOVE_REPLACEMENT
					}
					// Simulate the documented 1177 state: the old file has moved
					// to backup, the replacement has not reached the destination.
					if err := os.Rename(destination, backup); err != nil {
						t.Fatal(err)
					}
					if scenario == "destination-reappeared" {
						putTestFile(t, destination, []byte("external file"))
					}
					return windows.ERROR_UNABLE_TO_MOVE_REPLACEMENT_2
				}
				restore := moveWindowsFile
				if scenario == "restore-failed" {
					restore = func(string, string) error { return windows.ERROR_ACCESS_DENIED }
				}
				return replaceWindowsFile(temp, target, replace, restore)
			}
			err := safeWriteFileWithOps(path, []byte("new data"), ops)
			if err == nil {
				t.Fatal("replacement failure was not reported")
			}
			if scenario == "restore-failed" || scenario == "destination-reappeared" {
				if !strings.Contains(err.Error(), "FILE_RECOVERY_REQUIRED:") || !strings.Contains(err.Error(), filepath.Base(backupPath)) {
					t.Fatalf("missing recovery path: %v", err)
				}
				requireFileBytes(t, backupPath, old)
				if scenario == "destination-reappeared" {
					requireFileBytes(t, path, []byte("external file"))
				} else if _, statErr := os.Lstat(path); !errors.Is(statErr, os.ErrNotExist) {
					t.Fatalf("unexpected destination: %v", statErr)
				}
				if removeErr := os.Remove(backupPath); removeErr != nil {
					t.Fatal(removeErr)
				}
			} else {
				requireFileBytes(t, path, old)
			}
			requireNoSaveTemps(t, dir)
		})
	}
}

// Junctions are reparse points that ordinary users can create, so they give
// real Windows coverage for following a reparse-point parent (redirected
// profiles, OneDrive folders) and for refusing a reparse point as the final
// target when the symlink privilege is unavailable.
func createTestJunction(t *testing.T, target, link string) {
	t.Helper()
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("junction creation unavailable: %v (%s)", err, strings.TrimSpace(string(out)))
	}
}

// Reading and saving both accept a junction in a parent directory: the
// document behind it is an ordinary file. The junction itself remains an
// invalid final target because replacing it would change a different object.
func TestWindowsReadsAndWritesThroughJunctionParent(t *testing.T) {
	dir := testDirectory(t)
	realDir := filepath.Join(dir, "real")
	if err := os.Mkdir(realDir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(realDir, "document.txt")
	old := []byte("readable content behind the junction")
	putTestFile(t, path, old)

	linkDir := filepath.Join(dir, "junction")
	createTestJunction(t, realDir, linkDir)
	viaLink := filepath.Join(linkDir, "document.txt")

	got, err := readFileAt(viaLink)
	if err != nil {
		t.Fatalf("read through a junction failed: %v", err)
	}
	if got.Path == nil || *got.Path != viaLink || got.Content != string(old) {
		t.Fatalf("unexpected junction read: %#v", got)
	}
	if _, err := readFileAt(linkDir); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:") {
		t.Errorf("junction to a directory was opened as text: %v", err)
	}

	overwritten := []byte("overwritten behind the junction")
	if err := safeWriteFile(viaLink, overwritten); err != nil {
		t.Fatalf("overwrite through a junction parent failed: %v", err)
	}
	requireFileBytes(t, path, overwritten)
	created := filepath.Join(linkDir, "created.txt")
	if err := safeWriteFile(created, []byte("new file behind the junction")); err != nil {
		t.Fatalf("create through a junction parent failed: %v", err)
	}
	requireFileBytes(t, filepath.Join(realDir, "created.txt"), []byte("new file behind the junction"))

	if err := safeWriteFile(linkDir, []byte("replacement")); err == nil ||
		(!strings.Contains(err.Error(), "FILE_UNSUPPORTED_LINK:") && !strings.Contains(err.Error(), "FILE_UNSUPPORTED_TYPE:")) {
		t.Errorf("junction as the final target was not refused: %v", err)
	}
	requireFileBytes(t, path, overwritten)
	requireNoSaveTemps(t, dir)
	requireNoSaveTemps(t, realDir)
}

func TestWindowsWriteRefusesLinkAsFinalTarget(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		dir := testDirectory(t)
		target := filepath.Join(dir, "real.txt")
		old := []byte("original content behind a symlink")
		putTestFile(t, target, old)
		link := filepath.Join(dir, "link.txt")
		if err := os.Symlink(target, link); err != nil {
			t.Skipf("symlink creation unavailable: %v", err)
		}
		if err := safeWriteFile(link, []byte("replacement")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_LINK:") {
			t.Fatalf("symlink final target was not refused: %v", err)
		}
		requireFileBytes(t, target, old)
		if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("symlink was replaced: %v %v", info, err)
		}
		requireNoSaveTemps(t, dir)
	})

	t.Run("junction", func(t *testing.T) {
		dir := testDirectory(t)
		realDir := filepath.Join(dir, "real")
		if err := os.Mkdir(realDir, 0700); err != nil {
			t.Fatal(err)
		}
		inside := filepath.Join(realDir, "keep.txt")
		putTestFile(t, inside, []byte("keep"))
		link := filepath.Join(dir, "junction-target")
		createTestJunction(t, realDir, link)
		if err := safeWriteFile(link, []byte("replacement")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_LINK:") {
			t.Fatalf("junction final target was not refused: %v", err)
		}
		requireFileBytes(t, inside, []byte("keep"))
		info, err := os.Lstat(link)
		if err != nil || !isPlatformLink(info) {
			t.Fatalf("junction was replaced: %v %v", info, err)
		}
		requireNoSaveTemps(t, dir)
	})
}

const fsctlSetSparse = 0x000900C4

func TestWindowsRefusesSpecialStorageAttributes(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "sparse.txt")
	old := []byte("keep the original sparse file")
	putTestFile(t, path, old)

	handle, err := windows.CreateFile(windowsTestName(t, path), windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var returned uint32
	sparseErr := windows.DeviceIoControl(handle, fsctlSetSparse, nil, 0, nil, 0, &returned, nil)
	if closeErr := windows.CloseHandle(handle); closeErr != nil {
		t.Fatal(closeErr)
	}
	if sparseErr != nil {
		t.Skipf("sparse files unavailable on this volume: %v", sparseErr)
	}
	var info windows.Win32FileAttributeData
	if err := windows.GetFileAttributesEx(windowsTestName(t, path), windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&info))); err != nil {
		t.Fatal(err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_SPARSE_FILE == 0 {
		t.Skip("volume did not mark the file sparse")
	}

	// Special storage must be refused rather than silently dropped by the
	// replacement; reading the file is still allowed.
	if _, err := readFileAt(path); err != nil {
		t.Fatalf("sparse file became unreadable: %v", err)
	}
	if err := safeWriteFile(path, []byte("new")); err == nil || !strings.Contains(err.Error(), "FILE_UNSUPPORTED_ATTRIBUTES:") {
		t.Fatalf("expected special-attribute refusal, got %v", err)
	}
	requireFileBytes(t, path, old)
	requireNoSaveTemps(t, dir)
}

func TestWindowsNewPublicationDoesNotOverwriteExistingFile(t *testing.T) {
	dir := testDirectory(t)
	path := filepath.Join(dir, "destination.txt")
	temp := filepath.Join(dir, "staged.txt")
	putTestFile(t, path, []byte("appeared externally"))
	putTestFile(t, temp, []byte("staged new data"))
	if err := publishFile(temp, path, nil); err == nil {
		t.Fatal("new-file publication overwrote an existing file")
	}
	requireFileBytes(t, path, []byte("appeared externally"))
	requireFileBytes(t, temp, []byte("staged new data"))
}

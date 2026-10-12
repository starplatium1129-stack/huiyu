"""Reuse exact SHA identities only while Windows denies file writes/deletes.

The single-threaded resident worker owns and explicitly closes this lease. Direct
fixed local NTFS paths are supported; unsupported paths/filesystems or failed locks use
the supplied full-byte fingerprint unchanged. No mtime/size identity cache.
Base protection persists across adapter changes; only new or invalidated
adapter identities need another full read while the original base lease holds.
"""
from __future__ import annotations

import copy
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import re
import stat
import threading

COMPONENTS = ("text_encoder", "text_conditioner", "transformer", "vae", "tokenizer", "t5_tokenizer", "scheduler")
GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING = 0x80000000, 1, 3
FILE_SHARE_WRITE = 2
FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT = 0x02000000, 0x00200000
FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_ATTRIBUTES = 1, 2, 4


class _Unsupported(OSError):
    pass


class _FileInfo(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME),
                ("accessed", wintypes.FILETIME), ("written", wintypes.FILETIME),
                ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                ("id_high", wintypes.DWORD), ("id_low", wintypes.DWORD)]


class _Windows:
    def __init__(self):
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        for name, arguments, result in (
            ("CreateFileW", (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                             wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE), wintypes.HANDLE),
            ("GetFileInformationByHandle", (wintypes.HANDLE, ctypes.POINTER(_FileInfo)), wintypes.BOOL),
            ("GetVolumeInformationByHandleW", (wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD,
                 ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                 wintypes.LPWSTR, wintypes.DWORD), wintypes.BOOL),
            ("GetDriveTypeW", (wintypes.LPCWSTR,), wintypes.UINT),
            ("QueryDosDeviceW", (wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD), wintypes.DWORD),
            ("CloseHandle", (wintypes.HANDLE,), wintypes.BOOL),
            ("FindFirstChangeNotificationW", (wintypes.LPCWSTR, wintypes.BOOL, wintypes.DWORD), wintypes.HANDLE),
            ("FindCloseChangeNotification", (wintypes.HANDLE,), wintypes.BOOL),
            ("WaitForSingleObject", (wintypes.HANDLE, wintypes.DWORD), wintypes.DWORD),
        ):
            function = getattr(self.api, name)
            function.argtypes, function.restype = arguments, result
        self._mapping_buffer = ctypes.create_unicode_buffer(32768)

    def mapping(self, drive):
        drive = drive.removeprefix("\\\\?\\").upper()
        if len(drive) != 2 or drive[0] not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" or drive[1] != ":":
            raise _Unsupported("Identity leases require a local drive letter")
        if not self.api.QueryDosDeviceW(drive, self._mapping_buffer, len(self._mapping_buffer)):
            raise ctypes.WinError(ctypes.get_last_error())
        # QueryDosDevice's first string is the active mapping; later strings are
        # undeleted old mappings. SUBST/other aliases cannot pin path resolution.
        target = self._mapping_buffer.value
        if re.fullmatch(r"\\Device\\HarddiskVolume[0-9]+", target) is None:
            raise _Unsupported("Identity leases require a direct local volume mapping")
        return target

    def open(self, path, directory=False):
        # Only fixed local drives with NTFS have the sharing/file-ID guarantees
        # used here. OPEN_REPARSE_POINT rejects junction/symlink redirection.
        # Rust canonicalize supplies extended local paths (\\\\?\\C:\\...).
        # Keep their exact spelling for Win32 calls; only classify the drive.
        drive = path.drive.removeprefix("\\\\?\\")
        if (len(drive) != 2 or drive[0] not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
                or drive[1] != ":" or self.api.GetDriveTypeW(path.anchor) != 3):
            raise _Unsupported("Identity leases require a fixed local NTFS drive")
        # Directory writes allow unrelated child files to be atomically saved;
        # denying DELETE still pins the directory itself. File bytes never share
        # writes. Directory membership/reparse changes are watched separately.
        sharing = FILE_SHARE_READ | (FILE_SHARE_WRITE if directory else 0)
        handle = self.api.CreateFileW(str(path), GENERIC_READ, sharing, None, OPEN_EXISTING,
                                     FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            info = _FileInfo()
            if not self.api.GetFileInformationByHandle(handle, ctypes.byref(info)):
                raise ctypes.WinError(ctypes.get_last_error())
            filesystem = ctypes.create_unicode_buffer(32)
            if not self.api.GetVolumeInformationByHandleW(handle, None, 0, None, None, None, filesystem, len(filesystem)):
                raise ctypes.WinError(ctypes.get_last_error())
            if filesystem.value != "NTFS" or info.attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise _Unsupported("Identity leases require ordinary NTFS files/directories")
            if bool(info.attributes & stat.FILE_ATTRIBUTE_DIRECTORY) != directory:
                raise _Unsupported("Model path changed its file/directory type")
            # NTFS file IDs remain stable while an open handle keeps that file
            # alive. Volume + file ID distinguishes replaced paths, not bytes.
            return handle, (info.volume, info.id_high, info.id_low)
        except BaseException:
            self.api.CloseHandle(handle)
            raise

    def close(self, handles):
        for handle in reversed(handles):
            self.api.CloseHandle(handle)

    def watch(self, path, subtree, changes):
        handle = self.api.FindFirstChangeNotificationW(str(path), subtree, changes)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def changed(self, watches):
        for handle in watches:
            result = self.api.WaitForSingleObject(handle, 0)
            if result == 0:
                return True
            if result != 258:  # WAIT_TIMEOUT is the only unchanged result.
                raise ctypes.WinError(ctypes.get_last_error())
        return False

    def close_watches(self, watches):
        for handle in reversed(watches):
            self.api.FindCloseChangeNotification(handle)


def _absolute(path):
    # Do not resolve away junctions before checking their reparse attributes.
    return Path(os.path.abspath(Path(path).expanduser()))


def _unique_paths(paths):
    # WindowsPath equality folds case even on case-sensitive NTFS directories.
    # Reject ambiguous spelling before a set/dict can lose a protected file.
    spellings = {}
    for path in paths:
        spelling = str(path)
        if spellings.setdefault(path, spelling) != spelling:
            raise _Unsupported("Case-distinct paths cannot receive an identity lease")
    return tuple(sorted(spellings))


def _inventory(root):
    files, directories = [], [root]

    def visit(folder):
        directories.append(folder)
        with os.scandir(folder) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise _Unsupported("Reparse points cannot receive an identity lease")
                path = Path(entry.path)
                if stat.S_ISDIR(info.st_mode):
                    visit(path)
                elif stat.S_ISREG(info.st_mode):
                    files.append(path)

    for name in COMPONENTS:
        visit(root / name)
    files.extend(root / name for name in ("modular_model_index.json", "model_index.json") if (root / name).is_file())
    # Hold ancestors too: renaming a parent must not redirect loader/hash paths
    # while a child file handle still refers to the old, now detached subtree.
    for path in [*directories, *files]:
        directories.extend(path.parents)
    return _unique_paths(directories), _unique_paths(files)


def _adapter_inventory(loras):
    files = _unique_paths(_absolute(row["path"]) for row in loras)
    return _unique_paths(parent for path in files for parent in path.parents), files


class _ProtectedFiles:
    """One explicitly owned set of file handles and latched directory events."""
    def __init__(self, windows, inventory, roots):
        self.windows = windows
        self.handles, self.watches, self.entries, self.file_ids = [], [], [], {}
        self._alive = False
        self.drive_mappings = {}
        try:
            # Filesystem watches do not observe DOS drive-letter remapping.
            # Capture before opening paths and check throughout the interval.
            self.drive_mappings = {drive: windows.mapping(drive) for drive in sorted(
                {path.drive.removeprefix("\\\\?\\").upper() for paths in inventory for path in paths})}
            for paths, directory in ((inventory[0], True), (inventory[1], False)):
                for path in paths:
                    handle, identity = windows.open(path, directory)
                    self.handles.append(handle)
                    self.entries.append((str(path), identity))
                    if not directory:
                        self.file_ids[path] = identity
            # Do not reset events: create -> hash/load -> delete invalidates the
            # entire protection interval even when both inventories are equal.
            for path in sorted(set(roots)):
                self.watches.append(windows.watch(path, True, FILE_NOTIFY_CHANGE_FILE_NAME |
                    FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_ATTRIBUTES))
            # Subtree watches omit the root's own attributes. Observe locked
            # directories from their parents, including transient reparse points.
            for parent in sorted({path.parent for path in inventory[0]}):
                self.watches.append(windows.watch(parent, False, FILE_NOTIFY_CHANGE_ATTRIBUTES))
            self._alive = True
        except BaseException:
            self.close()
            raise

    def valid(self):
        return (self._alive and all(self.windows.mapping(drive) == target
                for drive, target in self.drive_mappings.items()) and not self.windows.changed(self.watches))

    def close(self):
        self._alive = False
        self.windows.close_watches(self.watches)
        self.windows.close(self.handles)
        self.handles, self.watches = [], []


class IdentityLease:
    def __init__(self):
        self._windows = _Windows() if os.name == "nt" else None
        # The single-threaded resident worker owns the protection interval.
        # Reject cross-thread reuse or concurrent mutation of its handles.
        self._owner = threading.current_thread()
        self._acquiring = False
        self._base = self._adapters = None
        self._root = self._model_sha256 = self._adapter_scope = None
        self._adapter_hashes = {}
        self._component_sha256 = {}
        self.cached = self.reused = False

    def close(self):
        self._require_owner()
        for protected in (self._adapters, self._base):
            if protected is not None:
                protected.close()
        self._base = self._adapters = None
        self._root = self._model_sha256 = self._adapter_scope = None
        self._adapter_hashes = {}
        self._component_sha256 = {}
        self.cached = self.reused = False

    def _require_owner(self):
        if self._windows is not None and threading.current_thread() is not self._owner:
            raise RuntimeError("Identity leases must stay on their creating thread")

    def base_is_valid(self, root=None, model_sha256=None):
        """Cheap fail-closed check before/after reading the protected base files.

        The single worker owns the handles; a false result never rearms events
        or establishes a new interval. acquire() must validate a new identity.
        """
        try:
            if ((self._windows is not None and threading.current_thread() is not self._owner)
                    or (root is not None and str(_absolute(root)) != self._root)
                    or (model_sha256 is not None and model_sha256 != self._model_sha256)):
                return False
            return self._base is not None and self._base.valid()
        except OSError:
            return False

    def _warm_identity(self, root, scope, loras):
        # cached is set only after a complete full acquisition/fingerprint.
        # Continuously held handles pin every ancestor/file; latched watches
        # cover membership and reparse changes, so no fresh inventory is needed.
        if (not self.cached or str(root) != self._root
                or tuple(map(str, scope)) != tuple(map(str, self._adapter_scope))):
            return None
        try:
            if not self.base_is_valid() or self._adapters is None or not self._adapters.valid():
                return None
            result = {"modelSha256": self._model_sha256,
                      "componentSha256": copy.deepcopy(self._component_sha256),
                      "loras": [{"sha256": self._adapter_hashes[path], "strength": row["strength"]}
                                for path, row in zip(scope, loras)]}
            # A notification while constructing the detached result also forces
            # the original full acquisition path; never reset/rearm old events.
            if not self.base_is_valid() or not self._adapters.valid():
                return None
        except OSError:
            return None
        self.reused = True
        return result

    def acquire(self, root, loras, compute_identity, compute_adapters):
        """Return a detached identity; cached/reused describe this acquisition.

        compute_identity(root, loras) remains the full-byte fallback. The pure
        compute_adapters(loras) callback returns the same ordered LoRA rows for
        new files only. Base SHA is reused only under its original continuous
        protection interval. Existing adapter hashes require their own interval.
        reused means BOTH the base and ordered adapter group stayed protected;
        a group change returns false even if every file was already protected.
        """
        self._require_owner()
        if self._acquiring:
            raise RuntimeError("Identity lease acquisition cannot be reentered")
        self._acquiring = True
        try:
            return self._acquire(root, loras, compute_identity, compute_adapters)
        finally:
            self._acquiring = False

    def _acquire(self, root, loras, compute_identity, compute_adapters):
        self.reused = False
        root, loras = _absolute(root), copy.deepcopy(loras)
        if self._windows is None:
            self.close()
            return copy.deepcopy(compute_identity(root, loras))
        scope = tuple(_absolute(row["path"]) for row in loras)
        warm = self._warm_identity(root, scope, loras)
        if warm is not None:
            return warm
        base = adapters = None
        try:
            inventory, adapter_inventory = _inventory(root), _adapter_inventory(loras)
            base = _ProtectedFiles(self._windows, inventory, [root])
            adapters = _ProtectedFiles(self._windows, adapter_inventory,
                                       [path.parent for path in adapter_inventory[1]])
            if _inventory(root) != inventory:
                raise _Unsupported("Model membership changed while acquiring its lease")
            base_same = (str(root) == self._root and self.base_is_valid()
                         and base.entries == self._base.entries)
            adapters_valid = self._adapters is not None and self._adapters.valid()
        except BaseException as error:
            for protected in (adapters, base):
                if protected is not None:
                    protected.close()
            self.close()
            if isinstance(error, OSError):
                return copy.deepcopy(compute_identity(root, loras))
            raise
        adapters_same = (adapters_valid and scope == self._adapter_scope
                         and adapters.entries == self._adapters.entries)
        try:
            if not base_same:
                result = copy.deepcopy(compute_identity(root, loras))
            else:
                hashes = {path: digest for path, digest in self._adapter_hashes.items()
                          if adapters_valid and adapters.file_ids.get(path) == self._adapters.file_ids[path]}
                missing = {path: row for path, row in zip(scope, loras) if path not in hashes}
                if missing:
                    rows = compute_adapters(list(missing.values()))
                    hashes.update((path, row["sha256"]) for path, row in zip(missing, rows))
                result = {"modelSha256": self._model_sha256,
                          "componentSha256": copy.deepcopy(self._component_sha256),
                          "loras": [{"sha256": hashes[path], "strength": row["strength"]}
                                    for path, row in zip(scope, loras)]}
            if (_inventory(root) != inventory or not base.valid() or not adapters.valid()
                    or (base_same and not self.base_is_valid())
                    or (adapters_valid and not self._adapters.valid())):
                raise OSError("Model membership changed while fingerprinting; retry after the model update completes")
            # Prepare detached cache values before adopting the new handles so a
            # malformed/failed callback cannot leave a partially installed lease.
            model_sha256 = result["modelSha256"]
            component_sha256 = copy.deepcopy(result.get("componentSha256", {}))
            adapter_hashes = {path: row["sha256"] for path, row in zip(scope, result["loras"])}
        except BaseException:
            adapters.close()
            base.close()
            self.close()
            raise
        # Retain original base handles/events across adapter changes. Newly
        # acquired sets overlap old sets until replacement is fully validated.
        if base_same:
            base.close()
        else:
            if self._base is not None:
                self._base.close()
            self._base = base
        if adapters_same:
            adapters.close()
        else:
            if self._adapters is not None:
                self._adapters.close()
            self._adapters = adapters
        self._root, self._model_sha256, self._adapter_scope = str(root), model_sha256, scope
        self._component_sha256, self._adapter_hashes = component_sha256, adapter_hashes
        self.cached, self.reused = True, bool(base_same and adapters_same)
        return result

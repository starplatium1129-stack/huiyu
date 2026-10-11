"""Full-file SHA256 with the Windows system provider; no content/mtime cache."""
from __future__ import annotations

import ctypes
import hashlib
import os
from pathlib import Path


_CHUNK_BYTES = 8 * 1024 * 1024
# LOAD_LIBRARY_SEARCH_SYSTEM32: this provider is part of Windows, not the model.
_bcrypt = ctypes.WinDLL("bcrypt.dll", winmode=0x800) if os.name == "nt" else None
if _bcrypt is not None:
    _handle, _ulong = ctypes.c_void_p, ctypes.c_ulong
    for _name, _arguments in {
        "BCryptOpenAlgorithmProvider": [ctypes.POINTER(_handle), ctypes.c_wchar_p, ctypes.c_wchar_p, _ulong],
        "BCryptCreateHash": [_handle, ctypes.POINTER(_handle), _handle, _ulong, _handle, _ulong, _ulong],
        "BCryptHashData": [_handle, _handle, _ulong, _ulong],
        "BCryptFinishHash": [_handle, _handle, _ulong, _ulong],
        "BCryptDestroyHash": [_handle],
        "BCryptCloseAlgorithmProvider": [_handle, _ulong],
    }.items():
        _function = getattr(_bcrypt, _name)
        _function.argtypes = _arguments
        _function.restype = ctypes.c_long  # Signed 32-bit Windows NTSTATUS.


def _check(status, operation):
    if status < 0:
        raise OSError(f"{operation} failed with NTSTATUS 0x{status & 0xffffffff:08x}")


def file_sha256(path):
    """Read every byte on every call; Windows CNG failures propagate explicitly."""
    with Path(path).open("rb", buffering=0) as source:
        if _bcrypt is None:
            return hashlib.file_digest(source, "sha256").hexdigest()

        # Handles and buffers belong to this call, including concurrent callers.
        algorithm, digest_handle = ctypes.c_void_p(), ctypes.c_void_p()
        try:
            _check(_bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(algorithm), "SHA256", None, 0),
                   "BCryptOpenAlgorithmProvider")
            # Windows 7+ allocates the object when NULL/0 is passed; DestroyHash frees it.
            _check(_bcrypt.BCryptCreateHash(algorithm, ctypes.byref(digest_handle), None, 0, None, 0, 0),
                   "BCryptCreateHash")
            buffer = bytearray(_CHUNK_BYTES)
            native_buffer = (ctypes.c_ubyte * len(buffer)).from_buffer(buffer)
            while count := source.readinto(buffer):
                _check(_bcrypt.BCryptHashData(digest_handle, native_buffer, count, 0), "BCryptHashData")
            digest = (ctypes.c_ubyte * 32)()
            _check(_bcrypt.BCryptFinishHash(digest_handle, digest, len(digest), 0), "BCryptFinishHash")
            return bytes(digest).hex()
        finally:
            try:
                if digest_handle:
                    _check(_bcrypt.BCryptDestroyHash(digest_handle), "BCryptDestroyHash")
            finally:
                if algorithm:
                    _check(_bcrypt.BCryptCloseAlgorithmProvider(algorithm, 0), "BCryptCloseAlgorithmProvider")

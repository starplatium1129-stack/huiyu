/// A negative OS listener snapshot avoids waiting for an HTTP connection timeout.
/// A listener (or an unsupported/failed query) still needs the normal HTTP probe.
#[cfg(windows)]
pub(super) fn present(host: &str) -> Option<bool> {
    use std::{ffi::c_void, ptr};
    type ReadTable = unsafe extern "system" fn(*mut c_void, *mut u32, i32) -> u32;
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetTcpTable(table: *mut c_void, bytes: *mut u32, sorted: i32) -> u32;
        fn GetTcp6Table(table: *mut c_void, bytes: *mut u32, sorted: i32) -> u32;
    }
    fn read(reader: ReadTable, row_size: usize, port_offset: usize, port: u16) -> Option<bool> {
        let mut size = 0;
        // The documented null-buffer query returns ERROR_INSUFFICIENT_BUFFER.
        if unsafe { reader(ptr::null_mut(), &mut size, 0) } != 122 {
            return None;
        }
        for _ in 0..2 {
            if !(4..=16 * 1024 * 1024).contains(&size) {
                return None;
            }
            // DWORD alignment for MIB_TCPTABLE/MIB_TCP6TABLE.
            let mut buffer = vec![0_u32; (size as usize).div_ceil(4)];
            let result = unsafe { reader(buffer.as_mut_ptr().cast(), &mut size, 0) };
            if result == 122 {
                continue; // The connection table grew between the two calls.
            }
            if result != 0 {
                return None;
            }
            let bytes = unsafe {
                std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), buffer.len() * 4)
            };
            let bytes = bytes.get(..size as usize)?;
            let count = u32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
            let rows = bytes.get(4..4_usize.checked_add(count.checked_mul(row_size)?)?)?;
            return Some(rows.chunks_exact(row_size).any(|row| {
                u32::from_ne_bytes(row[..4].try_into().unwrap()) == 2 // MIB_TCP_STATE_LISTEN
                    && u16::from_be_bytes([row[port_offset], row[port_offset + 1]]) == port
            }));
        }
        None
    }
    let port = crate::upstream::local_url(host)
        .ok()?
        .port_or_known_default()?;
    // SDK DWORD/IN6_ADDR layouts: IPv4 row=20, local-port offset=8;
    // IPv6 row=52, local-port offset=24. Check both, including dual-stack sockets.
    if read(GetTcpTable, 20, 8, port)? {
        return Some(true);
    }
    read(GetTcp6Table, 52, 24, port)
}

#[cfg(not(windows))]
pub(super) fn present(_host: &str) -> Option<bool> {
    None
}

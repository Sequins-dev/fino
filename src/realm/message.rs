//! Serialized messages shared by reactor transit ports and process IPC.

use ::v8;

/// Transit metadata for one transferred message port.
#[derive(Debug)]
pub struct TransferredPortInfo {
    pub handle: u32,
    pub wake_read_fd: i32,
}

/// One serializer payload plus its transferred stores and ports.
#[derive(Debug)]
pub struct RealmMessage {
    pub data: Vec<u8>,
    pub transfer_stores: Vec<Vec<u8>>,
    pub transfer_ports: Vec<TransferredPortInfo>,
}

/// Extract `[[handle, wakeReadFd], ...]` from a JavaScript value.
pub(crate) fn extract_port_infos(
    scope: &mut v8::HandleScope,
    value: v8::Local<v8::Value>,
) -> Vec<TransferredPortInfo> {
    let Ok(array) = v8::Local::<v8::Array>::try_from(value) else {
        return Vec::new();
    };
    let mut infos = Vec::with_capacity(array.length() as usize);
    for index in 0..array.length() {
        let key = v8::Integer::new(scope, index as i32);
        let Some(element) = array.get(scope, key.into()) else {
            continue;
        };
        let Ok(pair) = v8::Local::<v8::Array>::try_from(element) else {
            continue;
        };
        let zero = v8::Integer::new(scope, 0);
        let one = v8::Integer::new(scope, 1);
        let Some(handle) = pair.get(scope, zero.into()) else {
            continue;
        };
        let Some(wake_read_fd) = pair.get(scope, one.into()) else {
            continue;
        };
        infos.push(TransferredPortInfo {
            handle: handle.integer_value(scope).unwrap_or(-1) as u32,
            wake_read_fd: wake_read_fd.integer_value(scope).unwrap_or(-1) as i32,
        });
    }
    infos
}

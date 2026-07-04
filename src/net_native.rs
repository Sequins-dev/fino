//! internal:net-native — small native networking helpers for JS socket code.

use std::ffi::CStr;
use std::net::{Ipv4Addr, Ipv6Addr};

use ::v8;

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["networkInterfaces"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:net-native").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    let tmpl = v8::FunctionTemplate::new(scope, network_interfaces);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "networkInterfaces")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    Some(v8::undefined(scope).into())
}

#[derive(Clone)]
struct NativeAddress {
    family: &'static str,
    ip: String,
    scope_id: Option<u32>,
}

struct NativeInterface {
    index: u32,
    name: String,
    flags: u32,
    addresses: Vec<NativeAddress>,
    netmasks: Vec<NativeAddress>,
}

fn network_interfaces(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match collect_interfaces() {
        Ok(interfaces) => rv.set(interfaces_to_js(scope, interfaces).into()),
        Err(err) => {
            let msg = v8::String::new(scope, &err).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
        }
    }
}

#[cfg(unix)]
fn collect_interfaces() -> Result<Vec<NativeInterface>, String> {
    use std::collections::BTreeMap;
    use std::ptr;

    let mut head: *mut libc::ifaddrs = ptr::null_mut();
    let rc = unsafe { libc::getifaddrs(&mut head) };
    if rc != 0 {
        return Err(format!(
            "getifaddrs failed: errno={}",
            std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default()
        ));
    }

    let mut by_name = BTreeMap::<String, NativeInterface>::new();
    let mut current = head;
    while !current.is_null() {
        let ifa = unsafe { &*current };
        if !ifa.ifa_name.is_null() {
            let name = unsafe { CStr::from_ptr(ifa.ifa_name) }
                .to_string_lossy()
                .into_owned();
            let index = unsafe { libc::if_nametoindex(ifa.ifa_name) };
            let entry = by_name
                .entry(name.clone())
                .or_insert_with(|| NativeInterface {
                    index,
                    name,
                    flags: ifa.ifa_flags,
                    addresses: Vec::new(),
                    netmasks: Vec::new(),
                });
            entry.flags = ifa.ifa_flags;
            if let Some(addr) = sockaddr_to_native(ifa.ifa_addr) {
                entry.addresses.push(addr);
                if let Some(mask) = sockaddr_to_native(ifa.ifa_netmask) {
                    entry.netmasks.push(mask);
                }
            }
        }
        current = ifa.ifa_next;
    }

    unsafe { libc::freeifaddrs(head) };
    Ok(by_name
        .into_values()
        .filter(|iface| iface.index > 0)
        .collect())
}

#[cfg(not(unix))]
fn collect_interfaces() -> Result<Vec<NativeInterface>, String> {
    Ok(Vec::new())
}

#[cfg(unix)]
fn sockaddr_to_native(ptr: *const libc::sockaddr) -> Option<NativeAddress> {
    if ptr.is_null() {
        return None;
    }
    let family = unsafe { (*ptr).sa_family as i32 };
    if family == libc::AF_INET {
        let sin = unsafe { &*(ptr as *const libc::sockaddr_in) };
        let octets = u32::from_be(sin.sin_addr.s_addr).to_be_bytes();
        return Some(NativeAddress {
            family: "ipv4",
            ip: Ipv4Addr::from(octets).to_string(),
            scope_id: None,
        });
    }
    if family == libc::AF_INET6 {
        let sin6 = unsafe { &*(ptr as *const libc::sockaddr_in6) };
        return Some(NativeAddress {
            family: "ipv6",
            ip: Ipv6Addr::from(sin6.sin6_addr.s6_addr).to_string(),
            scope_id: Some(sin6.sin6_scope_id),
        });
    }
    None
}

fn interfaces_to_js<'s>(
    scope: &mut v8::HandleScope<'s>,
    interfaces: Vec<NativeInterface>,
) -> v8::Local<'s, v8::Array> {
    let out = v8::Array::new(scope, interfaces.len() as i32);
    for (i, iface) in interfaces.into_iter().enumerate() {
        let obj = v8::Object::new(scope);
        set_u32(scope, obj, "index", iface.index);
        set_string(scope, obj, "name", &iface.name);
        set_u32(scope, obj, "flags", iface.flags);
        set_bool(scope, obj, "up", iface.flags & libc::IFF_UP as u32 != 0);
        set_bool(
            scope,
            obj,
            "loopback",
            iface.flags & libc::IFF_LOOPBACK as u32 != 0,
        );
        set_bool(
            scope,
            obj,
            "multicast",
            iface.flags & libc::IFF_MULTICAST as u32 != 0,
        );
        let addresses = addresses_to_js(scope, iface.addresses);
        set_value(scope, obj, "addresses", addresses.into());
        let netmasks = addresses_to_js(scope, iface.netmasks);
        set_value(scope, obj, "netmasks", netmasks.into());
        out.set_index(scope, i as u32, obj.into());
    }
    out
}

fn addresses_to_js<'s>(
    scope: &mut v8::HandleScope<'s>,
    addresses: Vec<NativeAddress>,
) -> v8::Local<'s, v8::Array> {
    let out = v8::Array::new(scope, addresses.len() as i32);
    for (i, address) in addresses.into_iter().enumerate() {
        let obj = v8::Object::new(scope);
        set_string(scope, obj, "family", address.family);
        set_string(scope, obj, "ip", &address.ip);
        set_u32(scope, obj, "port", 0);
        if let Some(scope_id) = address.scope_id {
            set_u32(scope, obj, "scopeId", scope_id);
        }
        out.set_index(scope, i as u32, obj.into());
    }
    out
}

fn set_string(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, value: &str) {
    let key = v8::String::new(scope, key).unwrap();
    let value = v8::String::new(scope, value).unwrap();
    obj.set(scope, key.into(), value.into());
}

fn set_u32(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, value: u32) {
    let key = v8::String::new(scope, key).unwrap();
    let value = v8::Integer::new_from_unsigned(scope, value);
    obj.set(scope, key.into(), value.into());
}

fn set_bool(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, value: bool) {
    let key = v8::String::new(scope, key).unwrap();
    let value = v8::Boolean::new(scope, value);
    obj.set(scope, key.into(), value.into());
}

fn set_value(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    key: &str,
    value: v8::Local<v8::Value>,
) {
    let key = v8::String::new(scope, key).unwrap();
    obj.set(scope, key.into(), value);
}

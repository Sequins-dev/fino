use std::{
    env, fs,
    path::{Path, PathBuf},
};

use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{JsxOptions, TransformOptions, Transformer, TypeScriptOptions};

fn main() {
    println!("cargo:rerun-if-changed=js/");
    println!("cargo:rerun-if-changed=src/profiler/binding.cc");
    println!("cargo:rerun-if-changed=src/v8_isolate_group/binding.cc");
    println!("cargo:rerun-if-changed=scripts/v8-compiler-wrapper.sh");
    println!("cargo:rerun-if-changed=scripts/v8-ninja-wrapper.sh");
    println!("cargo:rerun-if-env-changed=FINO_PROTOCOL_DEPS_PREFIX");

    link_linux_protocol_dependencies();

    // Compile Fino's C++ V8 shims against the crate's matching headers.
    let v8_include = find_v8_include();
    let v8_src = v8_include.parent().unwrap().parent().unwrap().join("src"); // for support.h
    let mut v8_bindings = cc::Build::new();
    v8_bindings
        .cpp(true)
        .flag("-std=c++20")
        // Keep the public V8 header ABI aligned with the custom rusty_v8
        // build. The shared-cage define is intentionally absent: every realm
        // gets its own pointer-compression cage.
        .define("V8_COMPRESS_POINTERS", None)
        .define("V8_31BIT_SMIS_ON_64BIT_ARCH", None)
        .define("V8_COMPRESS_POINTERS_IN_MULTIPLE_CAGES", None)
        .define("V8_EXTERNAL_CODE_SPACE", None)
        // V8 headers intentionally leave many virtual/interface parameters
        // unnamed by use. Keep profiler shim builds quiet without disabling
        // broader diagnostics for our C++ source.
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-comment")
        .flag_if_supported("-Wno-cast-function-type")
        .include(&v8_include)
        .include(&v8_src)
        .file("src/profiler/binding.cc")
        .file("src/v8_isolate_group/binding.cc")
        .compile("fino_profiler_binding");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = env::var("OUT_DIR").unwrap();

    let js_src = Path::new(&manifest_dir).join("js");
    let js_out = Path::new(&out_dir).join("js");

    process_dir(&js_src, &js_src, &js_out);
}

fn link_linux_protocol_dependencies() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    let Ok(prefix) = env::var("FINO_PROTOCOL_DEPS_PREFIX") else {
        return;
    };
    let lib_dir = PathBuf::from(prefix).join("lib");
    let libraries = [
        "ngtcp2_crypto_ossl",
        "ngtcp2",
        "nghttp3",
        "nghttp2",
        "ssl",
        "crypto",
    ];

    for library in libraries {
        let archive = lib_dir.join(format!("lib{library}.a"));
        if !archive.is_file() {
            panic!("FINO_PROTOCOL_DEPS_PREFIX is missing {}", archive.display());
        }
    }

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    for library in libraries {
        println!("cargo:rustc-link-lib=static:+whole-archive={library}");
    }

    // `dlopen(NULL, ...)` can only discover executable symbols that appear in
    // the ELF dynamic symbol table. Export the protocol APIs without exposing
    // every Rust and V8 symbol from the executable.
    for pattern in [
        "BIO_*",
        "BN_*",
        "CRYPTO_*",
        "d2i_*",
        "EC_KEY_*",
        "ECDSA_*",
        "EC_POINT_*",
        "ERR_*",
        "EVP_*",
        "HMAC",
        "i2d_*",
        "nghttp2_*",
        "nghttp3_*",
        "ngtcp2_*",
        "OBJ_*",
        "OSSL_QUIC_*",
        "PEM_*",
        "PKCS5_*",
        "PKCS8_*",
        "RAND_*",
        "RSA_*",
        "SSL_*",
        "TLS_*",
        "X509_*",
    ] {
        println!("cargo:rustc-link-arg=-Wl,--export-dynamic-symbol={pattern}");
    }

    // nghttp2 and nghttp3 both vendor sfparse. Shared builds keep those
    // support symbols private to each DSO, while whole-archive static linking
    // exposes the identical definitions to one link.
    println!("cargo:rustc-link-arg=-Wl,--allow-multiple-definition");
}

/// Recursively process a directory: strip TypeScript files and copy .mjs files as-is.
fn process_dir(src_root: &Path, src_dir: &Path, out_root: &Path) {
    for entry in fs::read_dir(src_dir).expect("failed to read js/ directory") {
        let entry = entry.expect("failed to read dir entry");
        let path = entry.path();

        if path.is_dir() {
            process_dir(src_root, &path, out_root);
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            match ext {
                "ts" | "mts" | "tsx" => process_ts(src_root, &path, out_root),
                "mjs" => copy_mjs(src_root, &path, out_root),
                _ => {}
            }
        }
    }
}

/// Strip TypeScript types from a file and write the result as a .mjs file in OUT_DIR.
fn process_ts(src_root: &Path, src_path: &Path, out_root: &Path) {
    let rel = src_path.strip_prefix(src_root).unwrap();
    let out_path = out_root.join(rel).with_extension("mjs");
    let map_path = out_root.join(rel).with_extension("mjs.map");

    fs::create_dir_all(out_path.parent().unwrap()).expect("failed to create output directory");

    let source_text = fs::read_to_string(src_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", src_path.display()));

    let stripped = strip_types(src_path, &source_text)
        .unwrap_or_else(|e| panic!("TypeScript error in {}: {e}", src_path.display()));

    fs::write(&out_path, stripped.code)
        .unwrap_or_else(|e| panic!("failed to write {}: {e}", out_path.display()));
    fs::write(&map_path, stripped.map.to_json_string())
        .unwrap_or_else(|e| panic!("failed to write {}: {e}", map_path.display()));
}

/// Copy a .mjs file as-is into OUT_DIR (for files not yet converted to .ts).
fn copy_mjs(src_root: &Path, src_path: &Path, out_root: &Path) {
    let rel = src_path.strip_prefix(src_root).unwrap();
    let out_path = out_root.join(rel);

    fs::create_dir_all(out_path.parent().unwrap()).expect("failed to create output directory");

    fs::copy(src_path, &out_path)
        .unwrap_or_else(|e| panic!("failed to copy {}: {e}", src_path.display()));
}

struct TranspiledSource {
    code: String,
    map: oxc_sourcemap::SourceMap,
}

/// Strip TypeScript type annotations from source text, returning plain JS.
fn strip_types(path: &Path, source_text: &str) -> Result<TranspiledSource, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());

    let ret = Parser::new(&allocator, source_text, source_type).parse();
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.message.to_string()).collect();
        return Err(msgs.join("\n"));
    }

    let mut program = ret.program;

    let scoping = SemanticBuilder::new()
        .with_excess_capacity(2.0)
        .build(&program)
        .semantic
        .into_scoping();

    let options = TransformOptions {
        typescript: TypeScriptOptions::default(),
        jsx: JsxOptions {
            import_source: Some("fino:ui".to_string()),
            ..JsxOptions::default()
        },
        ..TransformOptions::default()
    };

    let transformer_ret =
        Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);

    if !transformer_ret.errors.is_empty() {
        let msgs: Vec<String> = transformer_ret
            .errors
            .iter()
            .map(|e| e.message.to_string())
            .collect();
        return Err(msgs.join("\n"));
    }

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .with_source_text(source_text)
        .build(&program);

    Ok(TranspiledSource {
        code: generated.code,
        map: generated.map.expect("source map should be generated"),
    })
}

/// Locate the locked V8 crate's `v8/include/` directory in the Cargo registry.
/// The v8 crate vendors its V8 headers, and we need the exact matching version
/// to compile our C++ shim with the same ABI.
fn find_v8_include() -> PathBuf {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let lockfile = fs::read_to_string(manifest_dir.join("Cargo.lock"))
        .expect("failed to read Cargo.lock while locating V8 headers");
    let mut in_v8_package = false;
    let mut v8_version = None;
    for line in lockfile.lines() {
        if line == "[[package]]" {
            in_v8_package = false;
        } else if line == "name = \"v8\"" {
            in_v8_package = true;
        } else if in_v8_package && line.starts_with("version = \"") {
            v8_version = line
                .strip_prefix("version = \"")
                .and_then(|line| line.strip_suffix('"'));
            break;
        }
    }
    let v8_package = format!(
        "v8-{}",
        v8_version.expect("Cargo.lock does not contain the v8 package")
    );

    let cargo_home = env::var("CARGO_HOME").unwrap_or_else(|_| {
        let home = env::var("HOME").expect("HOME not set");
        format!("{home}/.cargo")
    });
    let registry_src = PathBuf::from(&cargo_home).join("registry/src");

    if let Ok(entries) = fs::read_dir(&registry_src) {
        for index_entry in entries.flatten() {
            if let Ok(pkgs) = fs::read_dir(index_entry.path()) {
                for pkg_entry in pkgs.flatten() {
                    let name = pkg_entry.file_name();
                    let name = name.to_string_lossy();
                    if name == v8_package.as_str() {
                        let include = pkg_entry.path().join("v8/include");
                        if include.exists() {
                            return include;
                        }
                    }
                }
            }
        }
    }
    panic!(
        "Could not find {v8_package} include directory in Cargo registry. Set CARGO_HOME if needed."
    );
}

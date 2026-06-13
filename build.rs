use std::{
    env, fs,
    path::{Path, PathBuf},
};

use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer, TypeScriptOptions};

fn main() {
    println!("cargo:rerun-if-changed=js/");
    println!("cargo:rerun-if-changed=src/profiler/binding.cc");

    // Compile the CpuProfiler C++ shim against V8 headers.
    let v8_include = find_v8_include();
    let v8_src = v8_include.parent().unwrap().parent().unwrap().join("src"); // for support.h
    cc::Build::new()
        .cpp(true)
        .flag("-std=c++20")
        // V8 headers intentionally leave many virtual/interface parameters
        // unnamed by use. Keep profiler shim builds quiet without disabling
        // broader diagnostics for our C++ source.
        .flag_if_supported("-Wno-unused-parameter")
        .include(&v8_include)
        .include(&v8_src)
        .file("src/profiler/binding.cc")
        .compile("fino_profiler_binding");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = env::var("OUT_DIR").unwrap();

    let js_src = Path::new(&manifest_dir).join("js");
    let js_out = Path::new(&out_dir).join("js");

    process_dir(&js_src, &js_src, &js_out);
}

/// Recursively process a directory: strip .mts files and copy .mjs files as-is.
fn process_dir(src_root: &Path, src_dir: &Path, out_root: &Path) {
    for entry in fs::read_dir(src_dir).expect("failed to read js/ directory") {
        let entry = entry.expect("failed to read dir entry");
        let path = entry.path();

        if path.is_dir() {
            process_dir(src_root, &path, out_root);
        } else {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            match ext {
                "mts" => process_mts(src_root, &path, out_root),
                "mjs" => copy_mjs(src_root, &path, out_root),
                _ => {}
            }
        }
    }
}

/// Strip TypeScript types from a .mts file and write the result as a .mjs file in OUT_DIR.
fn process_mts(src_root: &Path, src_path: &Path, out_root: &Path) {
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

/// Copy a .mjs file as-is into OUT_DIR (for files not yet converted to .mts).
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

/// Locate the V8 crate's `v8/include/` directory by scanning the Cargo registry.
/// The v8 crate vendors its V8 headers, and we need them to compile our C++ shim.
fn find_v8_include() -> PathBuf {
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
                    if name.starts_with("v8-") {
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
        "Could not find v8 crate include directory in Cargo registry. Set CARGO_HOME if needed."
    );
}

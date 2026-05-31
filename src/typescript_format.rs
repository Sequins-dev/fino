use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::{ast::CommentKind, Comment};
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::{config::RuntimeParserConfig, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer, TypeScriptOptions};
use serde::Serialize;
use v8;

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["parse", "transpile"]
        .iter()
        .map(|name| v8::String::new(scope, name).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:format/typescript").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    let tmpl = v8::FunctionTemplate::new(scope, parse_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "parse")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    let tmpl = v8::FunctionTemplate::new(scope, transpile_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "transpile")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    Some(v8::undefined(scope).into())
}

fn parse_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let source = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            throw_error(scope, "parse: expected source string");
            return;
        }
    };

    let options = parse_options(scope, args.get(1), true);
    let result = catch_unwind(AssertUnwindSafe(|| parse_source(&source, &options)));
    set_json_result(scope, rv, "parse", result);
}

fn transpile_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let source = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            throw_error(scope, "transpile: expected source string");
            return;
        }
    };

    let options = parse_options(scope, args.get(1), false);
    let result = catch_unwind(AssertUnwindSafe(|| transpile_source(&source, &options)));
    set_json_result(scope, rv, "transpile", result);
}

fn set_json_result(
    scope: &mut v8::HandleScope,
    mut rv: v8::ReturnValue,
    operation: &str,
    result: Result<Result<String, String>, Box<dyn std::any::Any + Send>>,
) {
    match result {
        Err(_) => throw_error(scope, &format!("{operation}: parser panicked")),
        Ok(Err(err)) => throw_error(scope, &format!("{operation}: {err}")),
        Ok(Ok(json)) => {
            let Some(json_value) = v8::String::new(scope, &json) else {
                throw_error(scope, &format!("{operation}: failed to allocate result"));
                return;
            };
            let Some(value) = v8::json::parse(scope, json_value) else {
                throw_error(scope, &format!("{operation}: failed to materialize result"));
                return;
            };
            rv.set(value.into());
        }
    }
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exc = v8::Exception::type_error(scope, msg);
    scope.throw_exception(exc);
}

#[derive(Default)]
struct ParseOptions {
    filename: Option<String>,
    source_type: Option<String>,
    tokens: bool,
}

fn parse_options(
    scope: &mut v8::HandleScope,
    value: v8::Local<v8::Value>,
    default_tokens: bool,
) -> ParseOptions {
    let mut options = ParseOptions {
        tokens: default_tokens,
        ..ParseOptions::default()
    };
    let Ok(object) = v8::Local::<v8::Object>::try_from(value) else {
        return options;
    };

    if let Some(filename) = get_string_property(scope, object, "filename") {
        options.filename = Some(filename);
    }
    if let Some(source_type) = get_string_property(scope, object, "sourceType") {
        options.source_type = Some(source_type);
    }
    if let Some(tokens) = get_bool_property(scope, object, "tokens") {
        options.tokens = tokens;
    }
    options
}

fn get_string_property(
    scope: &mut v8::HandleScope,
    object: v8::Local<v8::Object>,
    name: &str,
) -> Option<String> {
    let key = v8::String::new(scope, name)?;
    let value = object.get(scope, key.into())?;
    if value.is_null_or_undefined() {
        return None;
    }
    value
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
}

fn get_bool_property(
    scope: &mut v8::HandleScope,
    object: v8::Local<v8::Object>,
    name: &str,
) -> Option<bool> {
    let key = v8::String::new(scope, name)?;
    let value = object.get(scope, key.into())?;
    if value.is_null_or_undefined() {
        None
    } else {
        Some(value.boolean_value(scope))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseResult {
    ok: bool,
    ast: serde_json::Value,
    comments: Vec<CommentResult>,
    tokens: Vec<TokenResult>,
    errors: Vec<DiagnosticResult>,
    source_type: SourceTypeResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceTypeResult {
    language: &'static str,
    module_kind: &'static str,
    jsx: bool,
    typescript_definition: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommentResult {
    kind: &'static str,
    text: String,
    start: u32,
    end: u32,
    attached_to: u32,
    leading: bool,
    trailing: bool,
    jsdoc: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenResult {
    kind: String,
    text: String,
    start: u32,
    end: u32,
    on_new_line: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticResult {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranspileResult {
    ok: bool,
    code: String,
    map: String,
    errors: Vec<DiagnosticResult>,
}

fn parse_source(source: &str, options: &ParseOptions) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = resolve_source_type(options);
    let ret = Parser::new(&allocator, source, source_type)
        .with_config(RuntimeParserConfig::new(options.tokens))
        .parse();

    let ast = serde_json::from_str(&ret.program.to_estree_ts_json(true))
        .map_err(|err| format!("failed to serialize AST: {err}"))?;
    let comments = ret
        .program
        .comments
        .iter()
        .map(|comment| comment_result(*comment, source))
        .collect();
    let tokens = ret
        .tokens
        .iter()
        .filter(|token| token.end() > token.start())
        .map(|token| TokenResult {
            kind: token.kind().to_str().to_string(),
            text: source_slice(source, token.start(), token.end()),
            start: token.start(),
            end: token.end(),
            on_new_line: token.is_on_new_line(),
        })
        .collect();
    let errors = ret
        .errors
        .iter()
        .map(|error| DiagnosticResult {
            message: error.message.to_string(),
        })
        .collect::<Vec<_>>();
    let result = ParseResult {
        ok: errors.is_empty() && !ret.panicked,
        ast,
        comments,
        tokens,
        errors,
        source_type: source_type_result(source_type),
    };
    serde_json::to_string(&result).map_err(|err| format!("failed to serialize parse result: {err}"))
}

fn transpile_source(source: &str, options: &ParseOptions) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = resolve_source_type(options);
    let ret = Parser::new(&allocator, source, source_type).parse();
    if !ret.errors.is_empty() || ret.panicked {
        let result = TranspileResult {
            ok: false,
            code: String::new(),
            map: String::new(),
            errors: ret
                .errors
                .iter()
                .map(|error| DiagnosticResult {
                    message: error.message.to_string(),
                })
                .collect(),
        };
        return serde_json::to_string(&result)
            .map_err(|err| format!("failed to serialize transpile result: {err}"));
    }

    let mut program = ret.program;
    let scoping = SemanticBuilder::new()
        .with_excess_capacity(2.0)
        .build(&program)
        .semantic
        .into_scoping();
    let options_transform = TransformOptions {
        typescript: TypeScriptOptions::default(),
        ..TransformOptions::default()
    };
    let path = options
        .filename
        .as_deref()
        .map(Path::new)
        .unwrap_or_else(|| Path::new("module.ts"));
    let transformer_ret = Transformer::new(&allocator, path, &options_transform)
        .build_with_scoping(scoping, &mut program);
    if !transformer_ret.errors.is_empty() {
        let result = TranspileResult {
            ok: false,
            code: String::new(),
            map: String::new(),
            errors: transformer_ret
                .errors
                .iter()
                .map(|error| DiagnosticResult {
                    message: error.message.to_string(),
                })
                .collect(),
        };
        return serde_json::to_string(&result)
            .map_err(|err| format!("failed to serialize transpile result: {err}"));
    }

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .build(&program);
    let result = TranspileResult {
        ok: true,
        code: generated.code,
        map: generated
            .map
            .map(|map| map.to_json_string())
            .unwrap_or_default(),
        errors: Vec::new(),
    };
    serde_json::to_string(&result)
        .map_err(|err| format!("failed to serialize transpile result: {err}"))
}

fn resolve_source_type(options: &ParseOptions) -> SourceType {
    if let Some(source_type) = options.source_type.as_deref() {
        match source_type {
            "js" | "javascript" => return SourceType::mjs(),
            "script" => return SourceType::script(),
            "jsx" => return SourceType::jsx(),
            "ts" | "typescript" => return SourceType::ts(),
            "tsx" => return SourceType::tsx(),
            "dts" | "definition" => return SourceType::d_ts(),
            _ => {}
        }
    }
    if let Some(filename) = options.filename.as_deref() {
        if let Ok(source_type) = SourceType::from_path(Path::new(filename)) {
            return source_type;
        }
    }
    SourceType::ts()
}

fn source_type_result(source_type: SourceType) -> SourceTypeResult {
    SourceTypeResult {
        language: if source_type.is_typescript() {
            "typescript"
        } else {
            "javascript"
        },
        module_kind: if source_type.is_module() {
            "module"
        } else if source_type.is_script() {
            "script"
        } else if source_type.is_unambiguous() {
            "unambiguous"
        } else {
            "commonjs"
        },
        jsx: source_type.is_jsx(),
        typescript_definition: source_type.is_typescript_definition(),
    }
}

fn comment_result(comment: Comment, source: &str) -> CommentResult {
    CommentResult {
        kind: match comment.kind {
            CommentKind::Line => "line",
            CommentKind::SingleLineBlock | CommentKind::MultiLineBlock => "block",
        },
        text: comment.content_span().source_text(source).to_string(),
        start: comment.span.start,
        end: comment.span.end,
        attached_to: comment.attached_to,
        leading: comment.is_leading(),
        trailing: comment.is_trailing(),
        jsdoc: comment.is_jsdoc(),
    }
}

fn source_slice(source: &str, start: u32, end: u32) -> String {
    source
        .get(start as usize..end as usize)
        .unwrap_or_default()
        .to_string()
}

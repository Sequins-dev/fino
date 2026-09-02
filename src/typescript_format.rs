use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Arc;

use oxc_allocator::Allocator;
use oxc_ast::{Comment, ast::CommentKind};
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_formatter::{
    FormatOptions as OxcFormatOptions, Formatter as OxcFormatter, LineWidth, QuoteStyle,
    get_parse_options,
};
use oxc_linter::{
    AllowWarnDeny, ConfigStore, ConfigStoreBuilder, ContextSubHost, ExternalPluginStore, FixKind,
    Fixer, LintFilter, LintOptions as OxcLintOptions, Linter, ModuleRecord,
};
use oxc_parser::{Parser, config::RuntimeParserConfig};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{JsxOptions, TransformOptions, Transformer, TypeScriptOptions};
use serde::Serialize;
use v8;

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["parse", "transpile", "format", "lint"]
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
    v8::callback_scope!(unsafe let scope, context);
    let tmpl = v8::FunctionTemplate::new(scope, parse_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "parse")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    let tmpl = v8::FunctionTemplate::new(scope, transpile_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "transpile")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    let tmpl = v8::FunctionTemplate::new(scope, format_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "format")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    let tmpl = v8::FunctionTemplate::new(scope, lint_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "lint")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    Some(v8::undefined(scope).into())
}

fn parse_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let source = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            v8util::throw_type_error(scope, "parse: expected source string");
            return;
        }
    };

    let options = parse_options(scope, args.get(1), true);
    let result = catch_unwind(AssertUnwindSafe(|| parse_source(&source, &options)));
    set_json_result(scope, rv, "parse", result);
}

fn transpile_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let source = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            v8util::throw_type_error(scope, "transpile: expected source string");
            return;
        }
    };

    let options = parse_options(scope, args.get(1), false);
    let result = catch_unwind(AssertUnwindSafe(|| transpile_source(&source, &options)));
    set_json_result(scope, rv, "transpile", result);
}

fn format_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let source = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            v8util::throw_type_error(scope, "format: expected source string");
            return;
        }
    };

    let options = parse_options(scope, args.get(1), false);
    let result = catch_unwind(AssertUnwindSafe(|| format_source(&source, &options)));
    set_json_result(scope, rv, "format", result);
}

fn lint_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let source = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            v8util::throw_type_error(scope, "lint: expected source string");
            return;
        }
    };

    let options = parse_options(scope, args.get(1), false);
    let result = catch_unwind(AssertUnwindSafe(|| lint_source(&source, &options)));
    set_json_result(scope, rv, "lint", result);
}

fn set_json_result(
    scope: &mut v8::PinScope,
    mut rv: v8::ReturnValue,
    operation: &str,
    result: Result<Result<String, String>, Box<dyn std::any::Any + Send>>,
) {
    match result {
        Err(_) => v8util::throw_type_error(scope, &format!("{operation}: parser panicked")),
        Ok(Err(err)) => v8util::throw_type_error(scope, &format!("{operation}: {err}")),
        Ok(Ok(json)) => {
            let Some(json_value) = v8::String::new(scope, &json) else {
                v8util::throw_type_error(scope, &format!("{operation}: failed to allocate result"));
                return;
            };
            let Some(value) = v8::json::parse(scope, json_value) else {
                v8util::throw_type_error(
                    scope,
                    &format!("{operation}: failed to materialize result"),
                );
                return;
            };
            rv.set(value.into());
        }
    }
}

use crate::v8util;

#[derive(Default)]
struct ParseOptions {
    filename: Option<String>,
    source_type: Option<String>,
    tokens: bool,
    fix: bool,
}

fn parse_options(
    scope: &mut v8::PinScope,
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
    if let Some(fix) = get_bool_property(scope, object, "fix") {
        options.fix = fix;
    }
    options
}

fn get_string_property(
    scope: &mut v8::PinScope,
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
    scope: &mut v8::PinScope,
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
    code: String,
    message: String,
    severity: String,
    line: u32,
    column: u32,
    end_line: Option<u32>,
    end_column: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranspileResult {
    ok: bool,
    code: String,
    map: String,
    errors: Vec<DiagnosticResult>,
}

pub(crate) struct StrippedModule {
    pub code: String,
    pub map: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatResult {
    ok: bool,
    code: String,
    errors: Vec<DiagnosticResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LintResult {
    ok: bool,
    diagnostics: Vec<DiagnosticResult>,
    fixed_code: Option<String>,
}

fn parse_source(source: &str, options: &ParseOptions) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = resolve_source_type(options);
    let ret = Parser::new(&allocator, source, source_type)
        .with_config(RuntimeParserConfig::new(options.tokens))
        .parse();

    let ast_json = ret.program.to_estree_ts_json(true);
    let ast = parse_estree_json(&ast_json)?;
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
        .map(|error| diagnostic_result(source, "parse", &error.message.to_string(), None, "error"))
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

fn parse_estree_json(input: &str) -> Result<serde_json::Value, String> {
    match serde_json::from_str(input) {
        Ok(value) => Ok(value),
        Err(first_err) => {
            let escaped = escape_invalid_json_hex_escapes(input);
            if escaped == input {
                return Err(format!("failed to serialize AST: {first_err}"));
            }
            serde_json::from_str(&escaped).map_err(|err| format!("failed to serialize AST: {err}"))
        }
    }
}

fn escape_invalid_json_hex_escapes(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if !in_string {
            out.push(b as char);
            if b == b'"' {
                in_string = true;
            }
            i += 1;
            continue;
        }

        if b == b'"' {
            out.push('"');
            in_string = false;
            i += 1;
            continue;
        }

        if b == b'\\' && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'x' {
                out.push_str("\\\\x");
                i += 2;
                continue;
            }
            if next == b'u' && i + 5 < bytes.len() {
                if let Some(code) = hex_escape_code(&bytes[i + 2..i + 6]) {
                    if (0xD800..=0xDFFF).contains(&code)
                        && !is_valid_surrogate_pair_escape(bytes, i)
                    {
                        out.push_str("\\\\u");
                        out.push_str(&input[i + 2..i + 6]);
                        i += 6;
                        continue;
                    }
                }
            }
            out.push('\\');
            out.push(next as char);
            i += 2;
            continue;
        }

        out.push(b as char);
        i += 1;
    }
    out
}

fn hex_escape_code(bytes: &[u8]) -> Option<u32> {
    if bytes.len() != 4 {
        return None;
    }
    let mut value = 0u32;
    for &b in bytes {
        value = (value << 4)
            | match b {
                b'0'..=b'9' => u32::from(b - b'0'),
                b'a'..=b'f' => u32::from(b - b'a' + 10),
                b'A'..=b'F' => u32::from(b - b'A' + 10),
                _ => return None,
            };
    }
    Some(value)
}

fn is_valid_surrogate_pair_escape(bytes: &[u8], i: usize) -> bool {
    let Some(high) = hex_escape_code(bytes.get(i + 2..i + 6).unwrap_or_default()) else {
        return false;
    };
    if !(0xD800..=0xDBFF).contains(&high) {
        return false;
    }
    if bytes.get(i + 6) != Some(&b'\\') || bytes.get(i + 7) != Some(&b'u') {
        return false;
    }
    let Some(low) = hex_escape_code(bytes.get(i + 8..i + 12).unwrap_or_default()) else {
        return false;
    };
    (0xDC00..=0xDFFF).contains(&low)
}

fn transpile_source(source: &str, options: &ParseOptions) -> Result<String, String> {
    let path = options
        .filename
        .as_deref()
        .map(Path::new)
        .unwrap_or_else(|| Path::new("module.ts"));
    match strip_typescript_module(path, source) {
        Ok(stripped) => {
            let result = TranspileResult {
                ok: true,
                code: stripped.code,
                map: stripped.map,
                errors: Vec::new(),
            };
            return serde_json::to_string(&result)
                .map_err(|err| format!("failed to serialize transpile result: {err}"));
        }
        Err(message) => {
            let result = TranspileResult {
                ok: false,
                code: String::new(),
                map: String::new(),
                errors: vec![diagnostic_result(
                    source,
                    "transform",
                    &message,
                    None,
                    "error",
                )],
            };
            return serde_json::to_string(&result)
                .map_err(|err| format!("failed to serialize transpile result: {err}"));
        }
    }
}

pub(crate) fn strip_typescript_module(path: &Path, source: &str) -> Result<StrippedModule, String> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());
    let ret = Parser::new(&allocator, source, source_type).parse();
    if !ret.errors.is_empty() || ret.panicked {
        let messages = ret
            .errors
            .iter()
            .map(|error| error.message.to_string())
            .collect::<Vec<_>>();
        return Err(messages.join("\n"));
    }

    let mut program = ret.program;
    let scoping = SemanticBuilder::new()
        .with_excess_capacity(2.0)
        .build(&program)
        .semantic
        .into_scoping();
    let options_transform = TransformOptions {
        typescript: TypeScriptOptions::default(),
        jsx: JsxOptions {
            import_source: Some("fino:ui".to_string()),
            ..JsxOptions::default()
        },
        ..TransformOptions::default()
    };
    let transformer_ret = Transformer::new(&allocator, path, &options_transform)
        .build_with_scoping(scoping, &mut program);
    if !transformer_ret.errors.is_empty() {
        let messages = transformer_ret
            .errors
            .iter()
            .map(|error| error.message.to_string())
            .collect::<Vec<_>>();
        return Err(messages.join("\n"));
    }

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .build(&program);
    Ok(StrippedModule {
        code: generated.code,
        map: generated
            .map
            .map(|map| map.to_json_string())
            .unwrap_or_default(),
    })
}

fn format_source(source: &str, options: &ParseOptions) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = resolve_source_type(options);
    let ret = Parser::new(&allocator, source, source_type)
        .with_options(get_parse_options())
        .with_config(RuntimeParserConfig::new(true))
        .parse();
    if !ret.errors.is_empty() || ret.panicked {
        let result = FormatResult {
            ok: false,
            code: String::new(),
            errors: ret
                .errors
                .iter()
                .map(|error| {
                    diagnostic_result(source, "parse", &error.message.to_string(), None, "error")
                })
                .collect(),
        };
        return serde_json::to_string(&result)
            .map_err(|err| format!("failed to serialize format result: {err}"));
    }

    let formatter_options = OxcFormatOptions {
        line_width: LineWidth::try_from(100)
            .map_err(|error| format!("invalid formatter line width: {error}"))?,
        quote_style: QuoteStyle::Single,
        jsx_quote_style: QuoteStyle::Double,
        ..OxcFormatOptions::default()
    };
    let numeric_spellings = ret
        .tokens
        .iter()
        .filter(|token| token.kind().is_number())
        .map(|token| source_slice(source, token.start(), token.end()))
        .collect::<Vec<_>>();
    let code = OxcFormatter::new(&allocator, formatter_options).build(&ret.program);
    let code = restore_numeric_spellings(code, source_type, &numeric_spellings)?;
    let result = FormatResult {
        ok: true,
        code: normalize_formatted_code(code),
        errors: Vec::new(),
    };
    serde_json::to_string(&result)
        .map_err(|err| format!("failed to serialize format result: {err}"))
}

fn lint_source(source: &str, options: &ParseOptions) -> Result<String, String> {
    let allocator = Allocator::default();
    let source_type = resolve_source_type(options);
    let ret = Parser::new(&allocator, source, source_type).parse();
    let diagnostics: Vec<DiagnosticResult> = ret
        .errors
        .iter()
        .map(|error| diagnostic_result(source, "parse", &error.message.to_string(), None, "error"))
        .collect();

    if !diagnostics.is_empty() || ret.panicked {
        let result = LintResult {
            ok: false,
            diagnostics,
            fixed_code: None,
        };
        return serde_json::to_string(&result)
            .map_err(|err| format!("failed to serialize lint result: {err}"));
    }

    let path = options
        .filename
        .as_deref()
        .map(Path::new)
        .unwrap_or_else(|| Path::new("module.ts"));
    let semantic_ret = SemanticBuilder::new().with_cfg(true).build(&ret.program);
    if !semantic_ret.errors.is_empty() {
        let diagnostics = semantic_ret
            .errors
            .iter()
            .map(|error| {
                diagnostic_result(
                    source,
                    "semantic",
                    &error.message,
                    error
                        .labels
                        .as_ref()
                        .and_then(|labels| labels.first())
                        .map(|label| {
                            oxc_span::Span::new(
                                label.offset() as u32,
                                (label.offset() + label.len()) as u32,
                            )
                        }),
                    "error",
                )
            })
            .collect();
        let result = LintResult {
            ok: false,
            diagnostics,
            fixed_code: None,
        };
        return serde_json::to_string(&result)
            .map_err(|err| format!("failed to serialize lint result: {err}"));
    }

    let semantic = semantic_ret.semantic;
    let module_record = Arc::new(ModuleRecord::new(path, &ret.module_record, &semantic));
    let mut lint_config = ConfigStoreBuilder::empty();
    for rule in [
        "no-debugger",
        "no-const-assign",
        "no-dupe-keys",
        "no-duplicate-case",
        "no-unreachable",
        "use-isnan",
        "valid-typeof",
        "no-loss-of-precision",
        "no-new-native-nonconstructor",
        "no-sparse-arrays",
        "no-unsafe-negation",
        "no-useless-backreference",
    ] {
        let filter = LintFilter::new(AllowWarnDeny::Warn, rule)
            .map_err(|error| format!("invalid OXC lint rule {rule}: {error}"))?;
        lint_config = lint_config.with_filter(&filter);
    }
    let mut external_plugins = ExternalPluginStore::default();
    let base_config = lint_config
        .build(&mut external_plugins)
        .map_err(|error| format!("failed to build OXC lint configuration: {error}"))?;
    let config = ConfigStore::new(base_config, Default::default(), external_plugins);
    let linter = Linter::new(OxcLintOptions::default(), config, None).with_fix(if options.fix {
        FixKind::SafeFix
    } else {
        FixKind::None
    });
    let messages = linter.run(
        path,
        vec![ContextSubHost::new(semantic, module_record, 0)],
        &allocator,
    );
    let (messages, fixed_code) = if options.fix {
        let fixed = Fixer::new(source, messages, Some(source_type)).fix();
        (
            fixed.messages,
            fixed.fixed.then(|| fixed.fixed_code.into_owned()),
        )
    } else {
        (messages, None)
    };
    let diagnostics = messages
        .iter()
        .map(|message| {
            let code = message
                .error
                .code
                .number
                .as_deref()
                .or(message.error.code.scope.as_deref())
                .unwrap_or("lint");
            diagnostic_result(
                source,
                code,
                &message.error.message,
                Some(message.span),
                &format!("{:?}", message.error.severity).to_ascii_lowercase(),
            )
        })
        .collect::<Vec<_>>();
    let result = LintResult {
        ok: diagnostics.is_empty(),
        diagnostics,
        fixed_code,
    };
    serde_json::to_string(&result).map_err(|err| format!("failed to serialize lint result: {err}"))
}

fn restore_numeric_spellings(
    mut formatted: String,
    source_type: SourceType,
    original_spellings: &[String],
) -> Result<String, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &formatted, source_type)
        .with_config(RuntimeParserConfig::new(true))
        .parse();
    if parsed.panicked || !parsed.errors.is_empty() {
        return Err("OXC formatter produced source that could not be reparsed".to_string());
    }
    let formatted_numbers = parsed
        .tokens
        .iter()
        .filter(|token| token.kind().is_number())
        .map(|token| token.span())
        .collect::<Vec<_>>();
    if formatted_numbers.len() != original_spellings.len() {
        return Err("OXC formatter changed the number of numeric literal tokens".to_string());
    }
    for (span, spelling) in formatted_numbers.iter().zip(original_spellings).rev() {
        formatted.replace_range(span.start as usize..span.end as usize, spelling);
    }
    Ok(formatted)
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

fn normalize_formatted_code(mut code: String) -> String {
    code = code.replace("\r\n", "\n").replace('\r', "\n");
    while code.ends_with('\n') {
        code.pop();
    }
    code.push('\n');
    code
}

fn diagnostic_result(
    source: &str,
    code: &str,
    message: &str,
    span: Option<oxc_span::Span>,
    severity: &str,
) -> DiagnosticResult {
    let (line, column, end_line, end_column) = match span {
        Some(span) => {
            let (line, column) = line_column(source, span.start);
            let (end_line, end_column) = line_column(source, span.end);
            (line, column, Some(end_line), Some(end_column))
        }
        None => (1, 1, None, None),
    };
    DiagnosticResult {
        code: code.to_string(),
        message: message.to_string(),
        severity: severity.to_string(),
        line,
        column,
        end_line,
        end_column,
    }
}

fn line_column(source: &str, offset: u32) -> (u32, u32) {
    let mut line = 1;
    let mut column = 1;
    let limit = offset as usize;
    for (index, ch) in source.char_indices() {
        if index >= limit {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

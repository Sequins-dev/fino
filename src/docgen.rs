use std::{collections::HashMap, fs, path::Path};

use ::v8;
use oxc_allocator::Allocator;
use oxc_ast::{
    Comment,
    ast::{
        BindingPattern, Class, ClassElement, Declaration, ExportDefaultDeclaration,
        ExportDefaultDeclarationKind, ExportNamedDeclaration, Function, MethodDefinition,
        ModuleExportName, PropertyDefinition, PropertyKey, Statement, TSInterfaceDeclaration,
        TSSignature, TSTypeAliasDeclaration, VariableDeclarationKind, VariableDeclarator,
    },
};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType};
use serde::Serialize;

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["extractModule"]
        .iter()
        .map(|name| v8::String::new(scope, name).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:docgen").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    let tmpl = v8::FunctionTemplate::new(scope, extract_module_callback);
    let func = tmpl.get_function(scope)?;
    let key = v8::String::new(scope, "extractModule")?;
    module.set_synthetic_module_export(scope, key, func.into())?;
    Some(v8::undefined(scope).into())
}

fn extract_module_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = match args.get(0).to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            throw_error(scope, "extractModule: expected file path string");
            return;
        }
    };

    match extract_module(Path::new(&path)) {
        Ok(module_doc) => match serde_json::to_string(&module_doc) {
            Ok(json) => {
                let Some(value) = v8::String::new(scope, &json) else {
                    throw_error(scope, "extractModule: failed to allocate result");
                    return;
                };
                rv.set(value.into());
            }
            Err(err) => {
                throw_error(
                    scope,
                    &format!("extractModule: failed to serialize docs: {err}"),
                );
            }
        },
        Err(err) => {
            throw_error(scope, &format!("extractModule: {err}"));
        }
    }
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exc = v8::Exception::type_error(scope, msg);
    scope.throw_exception(exc);
}

#[derive(Serialize, Clone, Default)]
struct DocBlock {
    text: String,
    tags: Vec<DocTag>,
}

#[derive(Serialize, Clone)]
struct DocTag {
    name: String,
    value: String,
}

#[derive(Serialize, Clone)]
struct Location {
    line: u32,
    column: u32,
}

#[derive(Serialize, Clone)]
struct MemberDoc {
    name: String,
    kind: String,
    signature: String,
    doc: DocBlock,
    location: Location,
}

#[derive(Serialize, Clone)]
struct ExportDoc {
    name: String,
    kind: String,
    signature: String,
    doc: DocBlock,
    members: Vec<MemberDoc>,
    location: Location,
}

#[derive(Serialize)]
struct ModuleDoc {
    path: String,
    name: String,
    doc: DocBlock,
    exports: Vec<ExportDoc>,
}

#[derive(Clone)]
struct LocalBinding {
    kind: String,
    signature: String,
    doc: DocBlock,
    members: Vec<MemberDoc>,
    location: Location,
}

fn extract_module(path: &Path) -> Result<ModuleDoc, String> {
    let source_text = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::default());

    let ret = Parser::new(&allocator, &source_text, source_type).parse();
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.message.to_string()).collect();
        return Err(format!(
            "failed to parse {}:\n{}",
            path.display(),
            msgs.join("\n")
        ));
    }

    let program = ret.program;
    let comments: Vec<Comment> = program.comments.iter().copied().collect();
    let locals = collect_locals(&program.body, &comments, &source_text);
    let mut exports = Vec::new();

    for statement in &program.body {
        match statement {
            Statement::ExportNamedDeclaration(decl) => {
                collect_named_export(&mut exports, decl, &comments, &locals, &source_text);
            }
            Statement::ExportDefaultDeclaration(decl) => {
                exports.push(collect_default_export(decl, &comments, &source_text));
            }
            _ => {}
        }
    }

    let module_doc = first_jsdoc_before(
        &comments,
        program
            .body
            .first()
            .map(|statement| statement.span().start)
            .unwrap_or(u32::MAX),
        &source_text,
    )
    .unwrap_or_default();

    Ok(ModuleDoc {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("module")
            .to_string(),
        doc: module_doc,
        exports,
    })
}

fn collect_locals<'a>(
    body: &[Statement<'a>],
    comments: &[Comment],
    source_text: &str,
) -> HashMap<String, LocalBinding> {
    let mut locals = HashMap::new();
    for statement in body {
        match statement {
            Statement::FunctionDeclaration(func) => {
                if let Some(name) = func.id.as_ref().map(|id| id.name.as_str().to_string()) {
                    locals.insert(
                        name,
                        LocalBinding {
                            kind: "function".to_string(),
                            signature: function_signature(func, source_text, false),
                            doc: doc_for_span(comments, func.span.start, source_text),
                            members: Vec::new(),
                            location: location_for(source_text, func.span.start),
                        },
                    );
                }
            }
            Statement::ClassDeclaration(class) => {
                if let Some(name) = class.id.as_ref().map(|id| id.name.as_str().to_string()) {
                    locals.insert(
                        name,
                        LocalBinding {
                            kind: "class".to_string(),
                            signature: class_signature(class, source_text, false),
                            doc: doc_for_span(comments, class.span.start, source_text),
                            members: class_members(class, comments, source_text),
                            location: location_for(source_text, class.span.start),
                        },
                    );
                }
            }
            Statement::VariableDeclaration(decl) => {
                for declarator in &decl.declarations {
                    if let Some(name) = binding_name(&declarator.id) {
                        locals.insert(
                            name,
                            LocalBinding {
                                kind: "variable".to_string(),
                                signature: variable_signature(
                                    decl.kind,
                                    declarator,
                                    source_text,
                                    false,
                                ),
                                doc: doc_for_span(comments, declarator.span.start, source_text),
                                members: Vec::new(),
                                location: location_for(source_text, declarator.span.start),
                            },
                        );
                    }
                }
            }
            Statement::TSTypeAliasDeclaration(decl) => {
                locals.insert(
                    decl.id.name.as_str().to_string(),
                    LocalBinding {
                        kind: "type".to_string(),
                        signature: type_alias_signature(decl, source_text, false),
                        doc: doc_for_span(comments, decl.span.start, source_text),
                        members: Vec::new(),
                        location: location_for(source_text, decl.span.start),
                    },
                );
            }
            Statement::TSInterfaceDeclaration(decl) => {
                locals.insert(
                    decl.id.name.as_str().to_string(),
                    LocalBinding {
                        kind: "interface".to_string(),
                        signature: interface_signature(decl, source_text, false),
                        doc: doc_for_span(comments, decl.span.start, source_text),
                        members: interface_members(decl, comments, source_text),
                        location: location_for(source_text, decl.span.start),
                    },
                );
            }
            Statement::TSEnumDeclaration(decl) => {
                locals.insert(
                    decl.id.name.as_str().to_string(),
                    LocalBinding {
                        kind: "enum".to_string(),
                        signature: clean_signature(source_slice(
                            source_text,
                            decl.span.start,
                            decl.span.end,
                        )),
                        doc: doc_for_span(comments, decl.span.start, source_text),
                        members: Vec::new(),
                        location: location_for(source_text, decl.span.start),
                    },
                );
            }
            _ => {}
        }
    }
    locals
}

fn collect_named_export<'a>(
    exports: &mut Vec<ExportDoc>,
    decl: &ExportNamedDeclaration<'a>,
    comments: &[Comment],
    locals: &HashMap<String, LocalBinding>,
    source_text: &str,
) {
    if let Some(inner) = &decl.declaration {
        match inner {
            Declaration::FunctionDeclaration(func) => {
                let name = func
                    .id
                    .as_ref()
                    .map(|id| id.name.as_str().to_string())
                    .unwrap_or_else(|| "default".to_string());
                exports.push(ExportDoc {
                    name,
                    kind: "function".to_string(),
                    signature: function_signature(func, source_text, true),
                    doc: doc_for_span(comments, decl.span.start, source_text),
                    members: Vec::new(),
                    location: location_for(source_text, decl.span.start),
                });
            }
            Declaration::ClassDeclaration(class) => {
                let name = class
                    .id
                    .as_ref()
                    .map(|id| id.name.as_str().to_string())
                    .unwrap_or_else(|| "default".to_string());
                exports.push(ExportDoc {
                    name,
                    kind: "class".to_string(),
                    signature: class_signature(class, source_text, true),
                    doc: doc_for_span(comments, decl.span.start, source_text),
                    members: class_members(class, comments, source_text),
                    location: location_for(source_text, decl.span.start),
                });
            }
            Declaration::VariableDeclaration(var_decl) => {
                for declarator in &var_decl.declarations {
                    if let Some(name) = binding_name(&declarator.id) {
                        exports.push(ExportDoc {
                            name,
                            kind: "variable".to_string(),
                            signature: variable_signature(
                                var_decl.kind,
                                declarator,
                                source_text,
                                true,
                            ),
                            doc: doc_for_span(comments, decl.span.start, source_text),
                            members: Vec::new(),
                            location: location_for(source_text, declarator.span.start),
                        });
                    }
                }
            }
            Declaration::TSTypeAliasDeclaration(type_decl) => {
                exports.push(ExportDoc {
                    name: type_decl.id.name.as_str().to_string(),
                    kind: "type".to_string(),
                    signature: type_alias_signature(type_decl, source_text, true),
                    doc: doc_for_span(comments, decl.span.start, source_text),
                    members: Vec::new(),
                    location: location_for(source_text, decl.span.start),
                });
            }
            Declaration::TSInterfaceDeclaration(interface_decl) => {
                exports.push(ExportDoc {
                    name: interface_decl.id.name.as_str().to_string(),
                    kind: "interface".to_string(),
                    signature: interface_signature(interface_decl, source_text, true),
                    doc: doc_for_span(comments, decl.span.start, source_text),
                    members: interface_members(interface_decl, comments, source_text),
                    location: location_for(source_text, decl.span.start),
                });
            }
            Declaration::TSEnumDeclaration(enum_decl) => {
                exports.push(ExportDoc {
                    name: enum_decl.id.name.as_str().to_string(),
                    kind: "enum".to_string(),
                    signature: clean_signature(source_slice(
                        source_text,
                        decl.span.start,
                        decl.span.end,
                    )),
                    doc: doc_for_span(comments, decl.span.start, source_text),
                    members: Vec::new(),
                    location: location_for(source_text, decl.span.start),
                });
            }
            _ => {}
        }
        return;
    }

    if decl.source.is_some() {
        return;
    }

    for specifier in &decl.specifiers {
        let local_name = module_export_name(&specifier.local, source_text);
        let exported_name = module_export_name(&specifier.exported, source_text);
        if let Some(local) = locals.get(&local_name) {
            let mut item = local.clone();
            item.signature = if item.signature.starts_with("export ") {
                item.signature.clone()
            } else {
                format!("export {}", item.signature)
            };
            exports.push(ExportDoc {
                name: exported_name,
                kind: item.kind,
                signature: item.signature,
                doc: item.doc,
                members: item.members,
                location: item.location,
            });
        }
    }
}

fn collect_default_export<'a>(
    decl: &ExportDefaultDeclaration<'a>,
    comments: &[Comment],
    source_text: &str,
) -> ExportDoc {
    match &decl.declaration {
        ExportDefaultDeclarationKind::FunctionDeclaration(func) => ExportDoc {
            name: "default".to_string(),
            kind: "function".to_string(),
            signature: function_signature(func, source_text, true),
            doc: doc_for_span(comments, decl.span.start, source_text),
            members: Vec::new(),
            location: location_for(source_text, decl.span.start),
        },
        ExportDefaultDeclarationKind::ClassDeclaration(class) => ExportDoc {
            name: "default".to_string(),
            kind: "class".to_string(),
            signature: class_signature(class, source_text, true),
            doc: doc_for_span(comments, decl.span.start, source_text),
            members: class_members(class, comments, source_text),
            location: location_for(source_text, decl.span.start),
        },
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(interface_decl) => ExportDoc {
            name: "default".to_string(),
            kind: "interface".to_string(),
            signature: interface_signature(interface_decl, source_text, true),
            doc: doc_for_span(comments, decl.span.start, source_text),
            members: interface_members(interface_decl, comments, source_text),
            location: location_for(source_text, decl.span.start),
        },
        _ => ExportDoc {
            name: "default".to_string(),
            kind: "default".to_string(),
            signature: clean_signature(source_slice(source_text, decl.span.start, decl.span.end)),
            doc: doc_for_span(comments, decl.span.start, source_text),
            members: Vec::new(),
            location: location_for(source_text, decl.span.start),
        },
    }
}

fn function_signature(func: &Function<'_>, source_text: &str, exported: bool) -> String {
    let end = func
        .body
        .as_ref()
        .map(|body| body.span.start)
        .unwrap_or(func.span.end);
    let mut signature = clean_signature(source_slice(source_text, func.span.start, end));
    if exported && !signature.starts_with("export ") {
        signature = format!("export {signature}");
    }
    signature
}

fn class_signature(class: &Class<'_>, source_text: &str, exported: bool) -> String {
    let end = class
        .body
        .span
        .start
        .saturating_sub(1)
        .max(class.span.start);
    let mut signature = clean_signature(source_slice(source_text, class.span.start, end + 1));
    if exported && !signature.starts_with("export ") {
        signature = format!("export {signature}");
    }
    signature
}

fn interface_signature(
    interface_decl: &TSInterfaceDeclaration<'_>,
    source_text: &str,
    exported: bool,
) -> String {
    let mut signature = clean_signature(source_slice(
        source_text,
        interface_decl.span.start,
        interface_decl.body.span.start,
    ));
    if exported && !signature.starts_with("export ") {
        signature = format!("export {signature}");
    }
    signature
}

fn type_alias_signature(
    type_decl: &TSTypeAliasDeclaration<'_>,
    source_text: &str,
    exported: bool,
) -> String {
    let mut signature = clean_signature(source_slice(
        source_text,
        type_decl.span.start,
        type_decl.span.end,
    ));
    if exported && !signature.starts_with("export ") {
        signature = format!("export {signature}");
    }
    signature
}

fn variable_signature(
    kind: VariableDeclarationKind,
    declarator: &VariableDeclarator<'_>,
    source_text: &str,
    exported: bool,
) -> String {
    let prefix = if exported {
        format!("export {} ", variable_kind(kind))
    } else {
        format!("{} ", variable_kind(kind))
    };
    let body = if let Some(type_annotation) = &declarator.type_annotation {
        source_slice(
            source_text,
            declarator.id.span().start,
            type_annotation.span.end,
        )
    } else if let Some(init) = &declarator.init {
        let mut text = source_slice(source_text, declarator.id.span().start, init.span().start);
        text = text.trim_end().trim_end_matches('=').trim_end().to_string();
        text
    } else {
        source_slice(
            source_text,
            declarator.id.span().start,
            declarator.id.span().end,
        )
    };
    clean_signature(format!("{prefix}{body}"))
}

fn interface_members(
    interface_decl: &TSInterfaceDeclaration<'_>,
    comments: &[Comment],
    source_text: &str,
) -> Vec<MemberDoc> {
    let mut members = Vec::new();
    for item in &interface_decl.body.body {
        match item {
            TSSignature::TSPropertySignature(signature) => {
                members.push(MemberDoc {
                    name: property_key_name(&signature.key, source_text),
                    kind: "property".to_string(),
                    signature: clean_signature(source_slice(
                        source_text,
                        signature.span.start,
                        signature.span.end,
                    )),
                    doc: doc_for_span(comments, signature.span.start, source_text),
                    location: location_for(source_text, signature.span.start),
                });
            }
            TSSignature::TSMethodSignature(signature) => {
                members.push(MemberDoc {
                    name: property_key_name(&signature.key, source_text),
                    kind: "method".to_string(),
                    signature: clean_signature(source_slice(
                        source_text,
                        signature.span.start,
                        signature.span.end,
                    )),
                    doc: doc_for_span(comments, signature.span.start, source_text),
                    location: location_for(source_text, signature.span.start),
                });
            }
            _ => {}
        }
    }
    members
}

fn class_members(class: &Class<'_>, comments: &[Comment], source_text: &str) -> Vec<MemberDoc> {
    let mut members = Vec::new();
    for item in &class.body.body {
        match item {
            ClassElement::MethodDefinition(method) => {
                if !is_documentable_property_key(&method.key) {
                    continue;
                }
                members.push(MemberDoc {
                    name: property_key_name(&method.key, source_text),
                    kind: "method".to_string(),
                    signature: class_method_signature(method, source_text),
                    doc: doc_for_span(comments, method.span.start, source_text),
                    location: location_for(source_text, method.span.start),
                });
            }
            ClassElement::PropertyDefinition(property) => {
                if !is_documentable_property_key(&property.key) {
                    continue;
                }
                members.push(MemberDoc {
                    name: property_key_name(&property.key, source_text),
                    kind: "property".to_string(),
                    signature: class_property_signature(property, source_text),
                    doc: doc_for_span(comments, property.span.start, source_text),
                    location: location_for(source_text, property.span.start),
                });
            }
            _ => {}
        }
    }
    members
}

fn is_documentable_property_key(key: &PropertyKey<'_>) -> bool {
    !matches!(key, PropertyKey::PrivateIdentifier(_))
}

fn class_method_signature(method: &MethodDefinition<'_>, source_text: &str) -> String {
    let end = method
        .value
        .body
        .as_ref()
        .map(|body| body.span.start)
        .unwrap_or(method.span.end);
    clean_signature(source_slice(source_text, method.span.start, end))
}

fn class_property_signature(property: &PropertyDefinition<'_>, source_text: &str) -> String {
    let end = if let Some(type_annotation) = &property.type_annotation {
        type_annotation.span.end
    } else if let Some(value) = &property.value {
        value.span().start
    } else {
        property.span.end
    };
    let mut signature = source_slice(source_text, property.span.start, end);
    if property.value.is_some() {
        signature = signature
            .trim_end()
            .trim_end_matches('=')
            .trim_end()
            .to_string();
    }
    clean_signature(signature)
}

fn variable_kind(kind: VariableDeclarationKind) -> &'static str {
    match kind {
        VariableDeclarationKind::Var => "var",
        VariableDeclarationKind::Let => "let",
        VariableDeclarationKind::Const => "const",
        VariableDeclarationKind::Using => "using",
        VariableDeclarationKind::AwaitUsing => "await using",
    }
}

fn binding_name(pattern: &BindingPattern<'_>) -> Option<String> {
    match pattern {
        BindingPattern::BindingIdentifier(id) => Some(id.name.as_str().to_string()),
        _ => None,
    }
}

fn module_export_name(name: &ModuleExportName<'_>, _source_text: &str) -> String {
    match name {
        ModuleExportName::IdentifierName(id) => id.name.as_str().to_string(),
        ModuleExportName::IdentifierReference(id) => id.name.as_str().to_string(),
        ModuleExportName::StringLiteral(lit) => lit.value.as_str().to_string(),
    }
}

fn property_key_name(key: &PropertyKey<'_>, source_text: &str) -> String {
    match key {
        PropertyKey::StaticIdentifier(id) => id.name.as_str().to_string(),
        PropertyKey::PrivateIdentifier(id) => format!("#{}", id.name.as_str()),
        PropertyKey::StringLiteral(lit) => lit.value.as_str().to_string(),
        _ => clean_signature(source_slice(source_text, key.span().start, key.span().end)),
    }
}

fn first_jsdoc_before(comments: &[Comment], end: u32, source_text: &str) -> Option<DocBlock> {
    comments
        .iter()
        .find(|comment| comment.is_jsdoc() && comment.is_leading() && comment.span.start < end)
        .map(|comment| parse_doc_comment(comment, source_text))
}

fn doc_for_span(comments: &[Comment], start: u32, source_text: &str) -> DocBlock {
    comments
        .iter()
        .rev()
        .find(|comment| comment.is_jsdoc() && comment.is_leading() && comment.attached_to == start)
        .map(|comment| parse_doc_comment(comment, source_text))
        .unwrap_or_default()
}

fn parse_doc_comment(comment: &Comment, source_text: &str) -> DocBlock {
    let raw = comment.content_span().source_text(source_text);
    let mut text_lines = Vec::new();
    let mut tags = Vec::new();

    for raw_line in raw.lines() {
        let mut line = raw_line.trim_start();
        if let Some(rest) = line.strip_prefix('*') {
            line = rest.trim_start();
        }
        if let Some(tag_body) = line.strip_prefix('@') {
            let mut parts = tag_body.splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or("").trim();
            let value = parts.next().unwrap_or("").trim();
            if !name.is_empty() {
                tags.push(DocTag {
                    name: name.to_string(),
                    value: value.to_string(),
                });
            }
            continue;
        }
        text_lines.push(line.to_string());
    }

    while text_lines
        .first()
        .is_some_and(|line| line.trim().is_empty())
    {
        text_lines.remove(0);
    }
    while text_lines.last().is_some_and(|line| line.trim().is_empty()) {
        text_lines.pop();
    }

    DocBlock {
        text: text_lines.join("\n"),
        tags,
    }
}

fn source_slice(source_text: &str, start: u32, end: u32) -> String {
    source_text[start as usize..end as usize].to_string()
}

fn clean_signature(value: String) -> String {
    value
        .trim()
        .trim_end_matches(';')
        .trim()
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn location_for(source_text: &str, offset: u32) -> Location {
    let mut line = 1u32;
    let mut column = 1u32;
    for byte in source_text[..offset as usize].bytes() {
        if byte == b'\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    Location { line, column }
}

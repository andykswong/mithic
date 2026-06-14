#[derive(Debug, Clone)]
pub enum JValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JValue>),
    Object(Vec<(String, JValue)>),
}

impl PartialEq for JValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (JValue::Null, JValue::Null) => true,
            (JValue::Bool(a), JValue::Bool(b)) => a == b,
            (JValue::Number(a), JValue::Number(b)) => {
                if a.is_nan() && b.is_nan() { return true; }
                a == b
            }
            (JValue::String(a), JValue::String(b)) => a == b,
            (JValue::Array(a), JValue::Array(b)) => a == b,
            (JValue::Object(a), JValue::Object(b)) => {
                if a.len() != b.len() { return false; }
                let mut a_sorted: Vec<&(String, JValue)> = a.iter().collect();
                let mut b_sorted: Vec<&(String, JValue)> = b.iter().collect();
                a_sorted.sort_by(|x, y| x.0.cmp(&y.0));
                b_sorted.sort_by(|x, y| x.0.cmp(&y.0));
                a_sorted.iter().zip(b_sorted.iter()).all(|(av, bv)| av.0 == bv.0 && av.1 == bv.1)
            }
            _ => false,
        }
    }
}

impl PartialOrd for JValue {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        match (self, other) {
            (JValue::Null, JValue::Null) => Some(std::cmp::Ordering::Equal),
            (JValue::Bool(a), JValue::Bool(b)) => a.partial_cmp(b),
            (JValue::Number(a), JValue::Number(b)) => a.partial_cmp(b),
            (JValue::String(a), JValue::String(b)) => Some(a.cmp(b)),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct FormatOpts {
    pub compact: bool,
    pub sort_keys: bool,
    pub indent: usize,
    pub use_tab: bool,
    pub raw_output: bool,
}

impl FormatOpts {
    pub fn compact() -> Self {
        FormatOpts { compact: true, sort_keys: false, indent: 2, use_tab: false, raw_output: false }
    }
}

pub fn format_value(v: &JValue, opts: &FormatOpts) -> String {
    let mut out = String::new();
    format_value_inner(v, opts, 0, &mut out);
    out
}

fn format_value_inner(v: &JValue, opts: &FormatOpts, depth: usize, out: &mut String) {
    match v {
        JValue::Null => out.push_str("null"),
        JValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JValue::Number(n) => {
            if n.is_nan() {
                out.push_str("null");
            } else if n.is_infinite() {
                if *n > 0.0 {
                    out.push_str("1.7976931348623157e+308");
                } else {
                    out.push_str("-1.7976931348623157e+308");
                }
            } else {
                let f = *n;
                if f == f.trunc() && f.abs() < 1e15 && !f.is_nan() {
                    out.push_str(&format!("{}", f as i64));
                } else {
                    let s = format!("{}", f);
                    out.push_str(&s);
                }
            }
        }
        JValue::String(s) => {
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    '\x08' => out.push_str("\\b"),
                    '\x0c' => out.push_str("\\f"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        JValue::Array(arr) => {
            if arr.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            let indent_str = make_indent(opts, depth + 1);
            let close_indent = make_indent(opts, depth);
            for (i, item) in arr.iter().enumerate() {
                if opts.compact {
                    if i > 0 { out.push(','); }
                } else {
                    if i > 0 { out.push(','); }
                    out.push('\n');
                    out.push_str(&indent_str);
                }
                format_value_inner(item, opts, depth + 1, out);
            }
            if !opts.compact {
                out.push('\n');
                out.push_str(&close_indent);
            }
            out.push(']');
        }
        JValue::Object(obj) => {
            if obj.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            let indent_str = make_indent(opts, depth + 1);
            let close_indent = make_indent(opts, depth);
            let pairs: Vec<&(String, JValue)> = if opts.sort_keys {
                let mut v: Vec<&(String, JValue)> = obj.iter().collect();
                v.sort_by(|a, b| a.0.cmp(&b.0));
                v
            } else {
                obj.iter().collect()
            };
            for (i, (k, v)) in pairs.iter().enumerate() {
                if opts.compact {
                    if i > 0 { out.push(','); }
                } else {
                    if i > 0 { out.push(','); }
                    out.push('\n');
                    out.push_str(&indent_str);
                }
                out.push('"');
                for c in k.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        '\t' => out.push_str("\\t"),
                        '\x08' => out.push_str("\\b"),
                        '\x0c' => out.push_str("\\f"),
                        c if (c as u32) < 0x20 => { out.push_str(&format!("\\u{:04x}", c as u32)); }
                        c => out.push(c),
                    }
                }
                out.push('"');
                if opts.compact { out.push(':'); } else { out.push_str(": "); }
                format_value_inner(v, opts, depth + 1, out);
            }
            if !opts.compact {
                out.push('\n');
                out.push_str(&close_indent);
            }
            out.push('}');
        }
    }
}

fn make_indent(opts: &FormatOpts, depth: usize) -> String {
    if opts.compact { return String::new(); }
    if opts.use_tab {
        "\t".repeat(depth)
    } else {
        " ".repeat(opts.indent * depth)
    }
}

pub fn json_type_name(v: &JValue) -> &'static str {
    match v {
        JValue::Null => "null",
        JValue::Bool(_) => "boolean",
        JValue::Number(_) => "number",
        JValue::String(_) => "string",
        JValue::Array(_) => "array",
        JValue::Object(_) => "object",
    }
}

pub fn parse_json(s: &str) -> Result<JValue, String> {
    let (v, pos) = parse_json_at(s, 0)?;
    let rest = s[pos..].trim();
    if !rest.is_empty() {
        return Err(format!("unexpected trailing content"));
    }
    Ok(v)
}

pub fn parse_json_at(s: &str, start: usize) -> Result<(JValue, usize), String> {
    let bytes = s.as_bytes();
    let pos = skip_ws(bytes, start);
    if pos >= bytes.len() {
        return Err("unexpected end of input".to_string());
    }
    match bytes[pos] {
        b'n' => {
            if s[pos..].starts_with("null") { Ok((JValue::Null, pos + 4)) }
            else { Err(format!("invalid token at pos {}", pos)) }
        }
        b't' => {
            if s[pos..].starts_with("true") { Ok((JValue::Bool(true), pos + 4)) }
            else { Err(format!("invalid token at pos {}", pos)) }
        }
        b'f' => {
            if s[pos..].starts_with("false") { Ok((JValue::Bool(false), pos + 5)) }
            else { Err(format!("invalid token at pos {}", pos)) }
        }
        b'"' => {
            let (s_val, end) = parse_json_string(s, pos)?;
            Ok((JValue::String(s_val), end))
        }
        b'[' => parse_json_array(s, pos),
        b'{' => parse_json_object(s, pos),
        b'-' | b'0'..=b'9' => parse_json_number(s, pos),
        c => Err(format!("unexpected char '{}' at pos {}", c as char, pos)),
    }
}

pub fn skip_ws(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t' | b'\n' | b'\r') {
        pos += 1;
    }
    pos
}

fn parse_json_string(s: &str, pos: usize) -> Result<(String, usize), String> {
    let bytes = s.as_bytes();
    debug_assert_eq!(bytes[pos], b'"');
    let mut i = pos + 1;
    let mut result = String::new();
    loop {
        if i >= bytes.len() {
            return Err("unterminated string".to_string());
        }
        match bytes[i] {
            b'"' => { return Ok((result, i + 1)); }
            b'\\' => {
                i += 1;
                if i >= bytes.len() { return Err("unterminated escape".to_string()); }
                match bytes[i] {
                    b'"' => { result.push('"'); i += 1; }
                    b'\\' => { result.push('\\'); i += 1; }
                    b'/' => { result.push('/'); i += 1; }
                    b'b' => { result.push('\x08'); i += 1; }
                    b'f' => { result.push('\x0c'); i += 1; }
                    b'n' => { result.push('\n'); i += 1; }
                    b'r' => { result.push('\r'); i += 1; }
                    b't' => { result.push('\t'); i += 1; }
                    b'u' => {
                        if i + 4 >= bytes.len() { return Err("invalid unicode escape".to_string()); }
                        let hex = &s[i+1..i+5];
                        let code = u32::from_str_radix(hex, 16)
                            .map_err(|_| format!("invalid unicode escape \\u{}", hex))?;
                        i += 5;
                        if (0xD800..=0xDBFF).contains(&code) {
                            if i + 1 < bytes.len() && bytes[i] == b'\\' && bytes[i+1] == b'u' {
                                if i + 5 < bytes.len() {
                                    let hex2 = &s[i+2..i+6];
                                    if let Ok(code2) = u32::from_str_radix(hex2, 16) {
                                        if (0xDC00..=0xDFFF).contains(&code2) {
                                            let full = 0x10000 + ((code - 0xD800) << 10) + (code2 - 0xDC00);
                                            if let Some(c) = char::from_u32(full) {
                                                result.push(c);
                                                i += 6;
                                                continue;
                                            }
                                        }
                                    }
                                }
                            }
                            result.push(char::REPLACEMENT_CHARACTER);
                        } else if (0xDC00..=0xDFFF).contains(&code) {
                            result.push(char::REPLACEMENT_CHARACTER);
                        } else {
                            result.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
                        }
                    }
                    c => { return Err(format!("invalid escape \\{}", c as char)); }
                }
            }
            _ => {
                let ch_start = i;
                if let Some(c) = s[ch_start..].chars().next() {
                    result.push(c);
                    i = ch_start + c.len_utf8();
                } else {
                    i += 1;
                }
            }
        }
    }
}

fn parse_json_number(s: &str, pos: usize) -> Result<(JValue, usize), String> {
    let bytes = s.as_bytes();
    let mut i = pos;
    if i < bytes.len() && bytes[i] == b'-' { i += 1; }
    if i >= bytes.len() { return Err("expected digit".to_string()); }
    if bytes[i] == b'0' {
        i += 1;
    } else if bytes[i] >= b'1' && bytes[i] <= b'9' {
        while i < bytes.len() && bytes[i] >= b'0' && bytes[i] <= b'9' { i += 1; }
    } else {
        return Err(format!("invalid number at pos {}", pos));
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        if i >= bytes.len() || !(bytes[i] >= b'0' && bytes[i] <= b'9') {
            return Err("expected digit after decimal point".to_string());
        }
        while i < bytes.len() && bytes[i] >= b'0' && bytes[i] <= b'9' { i += 1; }
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') { i += 1; }
        if i >= bytes.len() || !(bytes[i] >= b'0' && bytes[i] <= b'9') {
            return Err("expected digit in exponent".to_string());
        }
        while i < bytes.len() && bytes[i] >= b'0' && bytes[i] <= b'9' { i += 1; }
    }
    let num_str = &s[pos..i];
    let n: f64 = num_str.parse().map_err(|_| format!("invalid number: {}", num_str))?;
    Ok((JValue::Number(n), i))
}

fn parse_json_array(s: &str, pos: usize) -> Result<(JValue, usize), String> {
    let bytes = s.as_bytes();
    debug_assert_eq!(bytes[pos], b'[');
    let mut i = skip_ws(bytes, pos + 1);
    let mut arr = Vec::new();
    if i < bytes.len() && bytes[i] == b']' {
        return Ok((JValue::Array(arr), i + 1));
    }
    loop {
        let (v, next) = parse_json_at(s, i)?;
        arr.push(v);
        i = skip_ws(bytes, next);
        if i >= bytes.len() { return Err("unterminated array".to_string()); }
        match bytes[i] {
            b',' => { i = skip_ws(bytes, i + 1); }
            b']' => { return Ok((JValue::Array(arr), i + 1)); }
            c => return Err(format!("expected ',' or ']', got '{}' at pos {}", c as char, i)),
        }
    }
}

fn parse_json_object(s: &str, pos: usize) -> Result<(JValue, usize), String> {
    let bytes = s.as_bytes();
    debug_assert_eq!(bytes[pos], b'{');
    let mut i = skip_ws(bytes, pos + 1);
    let mut obj: Vec<(String, JValue)> = Vec::new();
    if i < bytes.len() && bytes[i] == b'}' {
        return Ok((JValue::Object(obj), i + 1));
    }
    loop {
        i = skip_ws(bytes, i);
        if i >= bytes.len() { return Err("unterminated object".to_string()); }
        if bytes[i] != b'"' {
            return Err(format!("expected string key, got '{}' at pos {}", bytes[i] as char, i));
        }
        let (key, next) = parse_json_string(s, i)?;
        i = skip_ws(bytes, next);
        if i >= bytes.len() || bytes[i] != b':' {
            return Err(format!("expected ':', got at pos {}", i));
        }
        i = skip_ws(bytes, i + 1);
        let (val, next2) = parse_json_at(s, i)?;
        obj.push((key, val));
        i = skip_ws(bytes, next2);
        if i >= bytes.len() { return Err("unterminated object".to_string()); }
        match bytes[i] {
            b',' => { i = i + 1; }
            b'}' => { return Ok((JValue::Object(obj), i + 1)); }
            c => return Err(format!("expected ',' or '}}', got '{}' at pos {}", c as char, i)),
        }
    }
}

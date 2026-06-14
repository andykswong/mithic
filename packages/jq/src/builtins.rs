use std::collections::VecDeque;
use regex::Regex;
use crate::json::{JValue, FormatOpts, format_value, json_type_name, parse_json};
use crate::filter::Filter;
use crate::eval::{JqError, Env, eval, eval_special, collect_recurse, jvalue_cmp, jvalue_add, jvalue_sub, jvalue_mul, jvalue_div, jvalue_mod, is_truthy, jvalue_getpath, jvalue_setpath, jvalue_delpath, jvalue_to_path, collect_paths, eval_path_expr, write_stderr, Path};

pub fn eval_call(name: &str, args: &[Filter], input: &JValue, env: &mut Env) -> Result<Vec<JValue>, JqError> {
    if let Some(def) = env.lookup_func(name, args.len()).cloned() {
        let body = def.body.clone();
        let params = def.params.clone();
        let mut child = env.child();
        for (param, arg) in params.iter().zip(args.iter()) {
            if param.starts_with('$') {
                let vals = eval(arg, input, env)?;
                let val = vals.into_iter().next().unwrap_or(JValue::Null);
                child.bind(param[1..].to_string(), val);
            } else {
                let arg_clone = arg.clone();
                child.define_func(param.clone(), vec![], arg_clone);
            }
        }
        return eval(&body, input, &mut child);
    }

    match (name, args.len()) {
        ("empty", 0) => Ok(vec![]),
        ("error", 0) => Err(JqError::Msg(match input {
            JValue::String(s) => s.clone(),
            v => format_value(v, &FormatOpts::compact()),
        })),
        ("error", 1) => {
            let msgs = eval(&args[0], input, env)?;
            let msg = msgs.into_iter().next().unwrap_or(JValue::Null);
            Err(JqError::Msg(match msg { JValue::String(s) => s, v => format_value(&v, &FormatOpts::compact()) }))
        }
        ("debug", 0) => {
            write_stderr(&format!("DEBUG: {}\n", format_value(input, &FormatOpts::compact())));
            Ok(vec![input.clone()])
        }
        ("debug", 1) => {
            let msgs = eval(&args[0], input, env)?;
            for m in &msgs {
                write_stderr(&format!("DEBUG: {}\n", format_value(m, &FormatOpts::compact())));
            }
            Ok(vec![input.clone()])
        }
        ("halt", 0) => Err(JqError::Halt),
        ("halt_error", 0) => {
            let code = match input { JValue::Number(n) => *n as u8, _ => 5 };
            Err(JqError::HaltError(code))
        }
        ("halt_error", 1) => {
            let ns = eval(&args[0], input, env)?;
            let code = match ns.first() { Some(JValue::Number(n)) => *n as u8, _ => 5 };
            Err(JqError::HaltError(code))
        }
        ("type", 0) => Ok(vec![JValue::String(json_type_name(input).to_string())]),
        ("null", 0) => Ok(vec![JValue::Null]),
        ("true", 0) => Ok(vec![JValue::Bool(true)]),
        ("false", 0) => Ok(vec![JValue::Bool(false)]),
        ("not", 0) => Ok(vec![JValue::Bool(!is_truthy(input))]),
        ("nan", 0) => Ok(vec![JValue::Number(f64::NAN)]),
        ("infinite", 0) => Ok(vec![JValue::Number(f64::INFINITY)]),
        ("isinfinite", 0) => Ok(vec![JValue::Bool(matches!(input, JValue::Number(n) if n.is_infinite()))]),
        ("isnan", 0) => Ok(vec![JValue::Bool(matches!(input, JValue::Number(n) if n.is_nan()))]),
        ("isnormal", 0) => Ok(vec![JValue::Bool(matches!(input, JValue::Number(n) if n.is_normal()))]),
        ("tonumber", 0) | ("to_number", 0) => match input {
            JValue::Number(n) => Ok(vec![JValue::Number(*n)]),
            JValue::String(s) => s.trim().parse::<f64>()
                .map(|n| vec![JValue::Number(n)])
                .map_err(|_| JqError::Msg(format!("invalid numeric literal: {}", s))),
            _ => Err(JqError::Msg(format!("cannot convert {} to number", json_type_name(input)))),
        },
        ("tostring", 0) => match input {
            JValue::String(s) => Ok(vec![JValue::String(s.clone())]),
            _ => Ok(vec![JValue::String(format_value(input, &FormatOpts::compact()))]),
        },
        ("tojson", 0) => Ok(vec![JValue::String(format_value(input, &FormatOpts::compact()))]),
        ("fromjson", 0) => match input {
            JValue::String(s) => parse_json(s).map(|v| vec![v]).map_err(|e| JqError::Msg(e)),
            _ => Err(JqError::Msg("fromjson: input must be string".to_string())),
        },
        ("ascii_downcase", 0) => match input {
            JValue::String(s) => Ok(vec![JValue::String(s.to_lowercase())]),
            _ => Err(JqError::Msg("ascii_downcase: input must be string".to_string())),
        },
        ("ascii_upcase", 0) => match input {
            JValue::String(s) => Ok(vec![JValue::String(s.to_uppercase())]),
            _ => Err(JqError::Msg("ascii_upcase: input must be string".to_string())),
        },
        ("length", 0) => match input {
            JValue::Null => Ok(vec![JValue::Number(0.0)]),
            JValue::Bool(_) => Err(JqError::Msg("length: boolean has no length".to_string())),
            JValue::Number(n) => Ok(vec![JValue::Number(n.abs())]),
            JValue::String(s) => Ok(vec![JValue::Number(s.chars().count() as f64)]),
            JValue::Array(a) => Ok(vec![JValue::Number(a.len() as f64)]),
            JValue::Object(o) => Ok(vec![JValue::Number(o.len() as f64)]),
        },
        ("utf8bytelength", 0) => match input {
            JValue::String(s) => Ok(vec![JValue::Number(s.len() as f64)]),
            _ => Err(JqError::Msg("utf8bytelength: input must be string".to_string())),
        },
        ("keys", 0) => match input {
            JValue::Object(obj) => {
                let mut keys: Vec<JValue> = obj.iter().map(|(k, _)| JValue::String(k.clone())).collect();
                keys.sort_by(|a, b| if let (JValue::String(sa), JValue::String(sb)) = (a, b) { sa.cmp(sb) } else { std::cmp::Ordering::Equal });
                Ok(vec![JValue::Array(keys)])
            }
            JValue::Array(arr) => {
                let keys: Vec<JValue> = (0..arr.len()).map(|i| JValue::Number(i as f64)).collect();
                Ok(vec![JValue::Array(keys)])
            }
            _ => Err(JqError::Msg(format!("keys: {} has no keys", json_type_name(input)))),
        },
        ("keys_unsorted", 0) => match input {
            JValue::Object(obj) => {
                let keys: Vec<JValue> = obj.iter().map(|(k, _)| JValue::String(k.clone())).collect();
                Ok(vec![JValue::Array(keys)])
            }
            JValue::Array(arr) => {
                let keys: Vec<JValue> = (0..arr.len()).map(|i| JValue::Number(i as f64)).collect();
                Ok(vec![JValue::Array(keys)])
            }
            _ => Err(JqError::Msg(format!("keys_unsorted: {} has no keys", json_type_name(input)))),
        },
        ("values", 0) => match input {
            JValue::Object(obj) => Ok(vec![JValue::Array(obj.iter().map(|(_, v)| v.clone()).collect())]),
            JValue::Array(arr) => Ok(vec![JValue::Array(arr.clone())]),
            _ => Err(JqError::Msg(format!("values: {} has no values", json_type_name(input)))),
        },
        ("has", 1) => {
            let ks = eval(&args[0], input, env)?;
            let k = ks.into_iter().next().unwrap_or(JValue::Null);
            match (input, &k) {
                (JValue::Object(obj), JValue::String(key)) => Ok(vec![JValue::Bool(obj.iter().any(|(ck, _)| ck == key))]),
                (JValue::Array(arr), JValue::Number(n)) => Ok(vec![JValue::Bool((*n as usize) < arr.len())]),
                _ => Err(JqError::Msg("has: invalid arguments".to_string())),
            }
        }
        ("in", 1) => {
            let objs = eval(&args[0], input, env)?;
            let obj = objs.into_iter().next().unwrap_or(JValue::Null);
            match (&obj, input) {
                (JValue::Object(o), JValue::String(k)) => Ok(vec![JValue::Bool(o.iter().any(|(ck, _)| ck == k))]),
                (JValue::Array(a), JValue::Number(n)) => Ok(vec![JValue::Bool((*n as usize) < a.len())]),
                _ => Err(JqError::Msg("in: invalid arguments".to_string())),
            }
        }
        ("contains", 1) => {
            let bs = eval(&args[0], input, env)?;
            let b = bs.into_iter().next().unwrap_or(JValue::Null);
            Ok(vec![JValue::Bool(jvalue_contains(input, &b))])
        }
        ("inside", 1) => {
            let bs = eval(&args[0], input, env)?;
            let b = bs.into_iter().next().unwrap_or(JValue::Null);
            Ok(vec![JValue::Bool(jvalue_contains(&b, input))])
        }
        ("map", 1) => match input {
            JValue::Array(arr) => {
                let mut out = Vec::new();
                for v in arr { out.extend(eval(&args[0], v, env)?); }
                Ok(vec![JValue::Array(out)])
            }
            _ => Err(JqError::Msg("map: input must be array".to_string())),
        },
        ("map_values", 1) => match input {
            JValue::Array(arr) => {
                let mut out = Vec::new();
                for v in arr {
                    let results = eval(&args[0], v, env)?;
                    out.push(results.into_iter().next().unwrap_or(JValue::Null));
                }
                Ok(vec![JValue::Array(out)])
            }
            JValue::Object(obj) => {
                let mut new_obj = Vec::new();
                for (k, v) in obj {
                    let results = eval(&args[0], v, env)?;
                    new_obj.push((k.clone(), results.into_iter().next().unwrap_or(JValue::Null)));
                }
                Ok(vec![JValue::Object(new_obj)])
            }
            _ => Err(JqError::Msg("map_values: input must be array or object".to_string())),
        },
        ("select", 1) => {
            let outs = eval(&args[0], input, env)?;
            if outs.iter().any(is_truthy) { Ok(vec![input.clone()]) } else { Ok(vec![]) }
        }
        ("recurse", 0) => {
            let mut out = Vec::new();
            collect_recurse(input, &mut out);
            Ok(out)
        }
        ("recurse", 1) => {
            let f = args[0].clone();
            let mut out = vec![input.clone()];
            let mut queue = VecDeque::new();
            queue.push_back(input.clone());
            while let Some(cur) = queue.pop_front() {
                match eval(&f, &cur, env) {
                    Ok(vs) => { for v in vs { out.push(v.clone()); queue.push_back(v); } }
                    Err(_) => {}
                }
            }
            Ok(out)
        }
        ("recurse", 2) => {
            let f = args[0].clone();
            let cond = args[1].clone();
            let mut out = vec![input.clone()];
            let mut queue = VecDeque::new();
            queue.push_back(input.clone());
            while let Some(cur) = queue.pop_front() {
                match eval(&f, &cur, env) {
                    Ok(vs) => {
                        for v in vs {
                            let cs = eval(&cond, &v, env).unwrap_or_default();
                            if cs.iter().any(is_truthy) {
                                out.push(v.clone());
                                queue.push_back(v);
                            }
                        }
                    }
                    Err(_) => {}
                }
            }
            Ok(out)
        }
        ("first", 0) => match input {
            JValue::Array(arr) => Ok(arr.first().cloned().into_iter().collect()),
            _ => Err(JqError::Msg("first: input must be array".to_string())),
        },
        ("last", 0) => match input {
            JValue::Array(arr) => Ok(arr.last().cloned().into_iter().collect()),
            _ => Err(JqError::Msg("last: input must be array".to_string())),
        },
        ("first", 1) => { let vs = eval(&args[0], input, env)?; Ok(vs.into_iter().take(1).collect()) }
        ("last", 1) => { let vs = eval(&args[0], input, env)?; Ok(vs.into_iter().last().into_iter().collect()) }
        ("nth", 2) => {
            let ns = eval(&args[0], input, env)?;
            let n = match ns.first() { Some(JValue::Number(n)) => *n as usize, _ => return Err(JqError::Msg("nth: first arg must be number".to_string())) };
            let vs = eval(&args[1], input, env)?;
            Ok(vs.into_iter().nth(n).into_iter().collect())
        }
        ("range", 1) => {
            let ns = eval(&args[0], input, env)?;
            let n = match ns.first() { Some(JValue::Number(n)) => *n, _ => return Err(JqError::Msg("range: arg must be number".to_string())) };
            let mut out = Vec::new();
            let mut i = 0.0_f64;
            while i < n { out.push(JValue::Number(i)); i += 1.0; }
            Ok(out)
        }
        ("range", 2) => {
            let fs = eval(&args[0], input, env)?;
            let ts = eval(&args[1], input, env)?;
            let from = match fs.first() { Some(JValue::Number(n)) => *n, _ => 0.0 };
            let to = match ts.first() { Some(JValue::Number(n)) => *n, _ => 0.0 };
            let mut out = Vec::new();
            let mut i = from;
            while i < to { out.push(JValue::Number(i)); i += 1.0; }
            Ok(out)
        }
        ("range", 3) => {
            let fs = eval(&args[0], input, env)?;
            let ts = eval(&args[1], input, env)?;
            let ss = eval(&args[2], input, env)?;
            let from = match fs.first() { Some(JValue::Number(n)) => *n, _ => 0.0 };
            let to = match ts.first() { Some(JValue::Number(n)) => *n, _ => 0.0 };
            let step = match ss.first() { Some(JValue::Number(n)) => *n, _ => 1.0 };
            if step == 0.0 { return Err(JqError::Msg("range: step cannot be zero".to_string())); }
            let mut out = Vec::new();
            let mut i = from;
            if step > 0.0 { while i < to { out.push(JValue::Number(i)); i += step; } }
            else { while i > to { out.push(JValue::Number(i)); i += step; } }
            Ok(out)
        }
        ("flatten", 0) => Ok(vec![flatten_array(input, -1)?]),
        ("flatten", 1) => {
            let ds = eval(&args[0], input, env)?;
            let d = match ds.first() { Some(JValue::Number(n)) => *n as i64, _ => -1 };
            Ok(vec![flatten_array(input, d)?])
        }
        ("sort", 0) => match input {
            JValue::Array(arr) => {
                let mut v = arr.clone();
                v.sort_by(|a, b| jvalue_cmp(a, b).cmp(&0));
                Ok(vec![JValue::Array(v)])
            }
            _ => Err(JqError::Msg("sort: input must be array".to_string())),
        },
        ("sort_by", 1) => match input {
            JValue::Array(arr) => {
                let f = args[0].clone();
                let mut keyed: Vec<(JValue, JValue)> = arr.iter().map(|v| {
                    let k = eval(&f, v, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    (k, v.clone())
                }).collect();
                keyed.sort_by(|(ka, _), (kb, _)| jvalue_cmp(ka, kb).cmp(&0));
                Ok(vec![JValue::Array(keyed.into_iter().map(|(_, v)| v).collect())])
            }
            _ => Err(JqError::Msg("sort_by: input must be array".to_string())),
        },
        ("group_by", 1) => match input {
            JValue::Array(arr) => {
                let f = args[0].clone();
                let mut keyed: Vec<(JValue, JValue)> = arr.iter().map(|v| {
                    let k = eval(&f, v, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    (k, v.clone())
                }).collect();
                keyed.sort_by(|(ka, _), (kb, _)| jvalue_cmp(ka, kb).cmp(&0));
                let mut groups: Vec<JValue> = Vec::new();
                let mut cur_key: Option<JValue> = None;
                let mut cur_group: Vec<JValue> = Vec::new();
                for (k, v) in keyed {
                    match &cur_key {
                        Some(ck) if ck == &k => cur_group.push(v),
                        _ => {
                            if !cur_group.is_empty() { groups.push(JValue::Array(cur_group.clone())); }
                            cur_group = vec![v];
                            cur_key = Some(k);
                        }
                    }
                }
                if !cur_group.is_empty() { groups.push(JValue::Array(cur_group)); }
                Ok(vec![JValue::Array(groups)])
            }
            _ => Err(JqError::Msg("group_by: input must be array".to_string())),
        },
        ("unique", 0) => match input {
            JValue::Array(arr) => {
                let mut v = arr.clone();
                v.sort_by(|a, b| jvalue_cmp(a, b).cmp(&0));
                v.dedup_by(|a, b| a == b);
                Ok(vec![JValue::Array(v)])
            }
            _ => Err(JqError::Msg("unique: input must be array".to_string())),
        },
        ("unique_by", 1) => match input {
            JValue::Array(arr) => {
                let f = args[0].clone();
                let mut keyed: Vec<(JValue, JValue)> = arr.iter().map(|v| {
                    let k = eval(&f, v, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    (k, v.clone())
                }).collect();
                keyed.sort_by(|(ka, _), (kb, _)| jvalue_cmp(ka, kb).cmp(&0));
                let mut seen_keys: Vec<JValue> = Vec::new();
                let mut out = Vec::new();
                for (k, v) in keyed {
                    if !seen_keys.contains(&k) { seen_keys.push(k); out.push(v); }
                }
                Ok(vec![JValue::Array(out)])
            }
            _ => Err(JqError::Msg("unique_by: input must be array".to_string())),
        },
        ("min", 0) => match input {
            JValue::Array(arr) if arr.is_empty() => Ok(vec![JValue::Null]),
            JValue::Array(arr) => Ok(vec![arr.iter().min_by(|a, b| jvalue_cmp(a, b).cmp(&0)).unwrap().clone()]),
            _ => Err(JqError::Msg("min: input must be array".to_string())),
        },
        ("max", 0) => match input {
            JValue::Array(arr) if arr.is_empty() => Ok(vec![JValue::Null]),
            JValue::Array(arr) => Ok(vec![arr.iter().max_by(|a, b| jvalue_cmp(a, b).cmp(&0)).unwrap().clone()]),
            _ => Err(JqError::Msg("max: input must be array".to_string())),
        },
        ("min_by", 1) => match input {
            JValue::Array(arr) if arr.is_empty() => Ok(vec![JValue::Null]),
            JValue::Array(arr) => {
                let f = args[0].clone();
                let result = arr.iter().min_by(|a, b| {
                    let ka = eval(&f, a, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    let kb = eval(&f, b, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    jvalue_cmp(&ka, &kb).cmp(&0)
                });
                Ok(result.cloned().into_iter().collect())
            }
            _ => Err(JqError::Msg("min_by: input must be array".to_string())),
        },
        ("max_by", 1) => match input {
            JValue::Array(arr) if arr.is_empty() => Ok(vec![JValue::Null]),
            JValue::Array(arr) => {
                let f = args[0].clone();
                let result = arr.iter().max_by(|a, b| {
                    let ka = eval(&f, a, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    let kb = eval(&f, b, env).unwrap_or_default().into_iter().next().unwrap_or(JValue::Null);
                    jvalue_cmp(&ka, &kb).cmp(&0)
                });
                Ok(result.cloned().into_iter().collect())
            }
            _ => Err(JqError::Msg("max_by: input must be array".to_string())),
        },
        ("add", 0) => match input {
            JValue::Array(arr) if arr.is_empty() => Ok(vec![JValue::Null]),
            JValue::Array(arr) => {
                let mut acc = arr[0].clone();
                for v in &arr[1..] { acc = jvalue_add(acc, v.clone())?; }
                Ok(vec![acc])
            }
            _ => Err(JqError::Msg("add: input must be array".to_string())),
        },
        ("any", 0) => match input {
            JValue::Array(arr) => Ok(vec![JValue::Bool(arr.iter().any(is_truthy))]),
            _ => Err(JqError::Msg("any: input must be array".to_string())),
        },
        ("all", 0) => match input {
            JValue::Array(arr) => Ok(vec![JValue::Bool(arr.iter().all(is_truthy))]),
            _ => Err(JqError::Msg("all: input must be array".to_string())),
        },
        ("any", 1) => { let vs = eval(&args[0], input, env)?; Ok(vec![JValue::Bool(vs.iter().any(is_truthy))]) }
        ("all", 1) => { let vs = eval(&args[0], input, env)?; Ok(vec![JValue::Bool(vs.iter().all(is_truthy))]) }
        ("any", 2) => {
            let gen_vals = eval(&args[0], input, env)?;
            for v in gen_vals {
                let cs = eval(&args[1], &v, env)?;
                if cs.iter().any(is_truthy) { return Ok(vec![JValue::Bool(true)]); }
            }
            Ok(vec![JValue::Bool(false)])
        }
        ("all", 2) => {
            let gen_vals = eval(&args[0], input, env)?;
            for v in gen_vals {
                let cs = eval(&args[1], &v, env)?;
                if !cs.iter().all(is_truthy) { return Ok(vec![JValue::Bool(false)]); }
            }
            Ok(vec![JValue::Bool(true)])
        }
        ("ltrimstr", 1) => {
            let ss = eval(&args[0], input, env)?;
            let prefix = match ss.first() { Some(JValue::String(s)) => s.clone(), _ => return Ok(vec![input.clone()]) };
            match input {
                JValue::String(s) => Ok(vec![JValue::String(if s.starts_with(&prefix) { s[prefix.len()..].to_string() } else { s.clone() })]),
                _ => Ok(vec![input.clone()]),
            }
        }
        ("rtrimstr", 1) => {
            let ss = eval(&args[0], input, env)?;
            let suffix = match ss.first() { Some(JValue::String(s)) => s.clone(), _ => return Ok(vec![input.clone()]) };
            match input {
                JValue::String(s) => Ok(vec![JValue::String(if s.ends_with(&suffix) { s[..s.len()-suffix.len()].to_string() } else { s.clone() })]),
                _ => Ok(vec![input.clone()]),
            }
        }
        ("startswith", 1) => {
            let ss = eval(&args[0], input, env)?;
            let prefix = match ss.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            match input { JValue::String(s) => Ok(vec![JValue::Bool(s.starts_with(&prefix))]), _ => Err(JqError::Msg("startswith: input must be string".to_string())) }
        }
        ("endswith", 1) => {
            let ss = eval(&args[0], input, env)?;
            let suffix = match ss.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            match input { JValue::String(s) => Ok(vec![JValue::Bool(s.ends_with(&suffix))]), _ => Err(JqError::Msg("endswith: input must be string".to_string())) }
        }
        ("explode", 0) => match input {
            JValue::String(s) => Ok(vec![JValue::Array(s.chars().map(|c| JValue::Number(c as u32 as f64)).collect())]),
            _ => Err(JqError::Msg("explode: input must be string".to_string())),
        },
        ("implode", 0) => match input {
            JValue::Array(arr) => {
                let s: Result<String, _> = arr.iter().map(|v| match v { JValue::Number(n) => char::from_u32(*n as u32).ok_or(()), _ => Err(()) }).collect();
                s.map(|s| vec![JValue::String(s)]).map_err(|_| JqError::Msg("implode: array must contain codepoints".to_string()))
            }
            _ => Err(JqError::Msg("implode: input must be array".to_string())),
        },
        ("split", 1) => {
            let ss = eval(&args[0], input, env)?;
            let sep = match ss.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            match input {
                JValue::String(s) => { let parts: Vec<JValue> = s.split(sep.as_str()).map(|p| JValue::String(p.to_string())).collect(); Ok(vec![JValue::Array(parts)]) }
                _ => Err(JqError::Msg("split: input must be string".to_string())),
            }
        }
        ("join", 1) => {
            let ss = eval(&args[0], input, env)?;
            let sep = match ss.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            match input {
                JValue::Array(arr) => {
                    let parts: Vec<String> = arr.iter().map(|v| match v { JValue::String(s) => s.clone(), JValue::Null => String::new(), _ => format_value(v, &FormatOpts::compact()) }).collect();
                    Ok(vec![JValue::String(parts.join(&sep))])
                }
                _ => Err(JqError::Msg("join: input must be array".to_string())),
            }
        }
        ("ascii", 0) => match input {
            JValue::Number(n) => Ok(vec![JValue::String(char::from_u32(*n as u32).map(|c| c.to_string()).unwrap_or_default())]),
            _ => Err(JqError::Msg("ascii: input must be number".to_string())),
        },
        ("test", 1) => {
            let rs = eval(&args[0], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("test: regex must be string".to_string())) };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("test: input must be string".to_string())) };
            let re = Regex::new(&re_str).map_err(|e| JqError::Msg(format!("test: invalid regex: {}", e)))?;
            Ok(vec![JValue::Bool(re.is_match(&text))])
        }
        ("test", 2) => {
            let rs = eval(&args[0], input, env)?;
            let fs = eval(&args[1], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("test: regex must be string".to_string())) };
            let flags = match fs.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("test: input must be string".to_string())) };
            let pattern = apply_regex_flags(&re_str, &flags);
            let re = Regex::new(&pattern).map_err(|e| JqError::Msg(format!("test: invalid regex: {}", e)))?;
            Ok(vec![JValue::Bool(re.is_match(&text))])
        }
        ("match", 1) => {
            let rs = eval(&args[0], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("match: regex must be string".to_string())) };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("match: input must be string".to_string())) };
            let re = Regex::new(&re_str).map_err(|e| JqError::Msg(format!("match: invalid regex: {}", e)))?;
            match re.captures(&text) {
                None => Err(JqError::Msg(format!("match: regex did not match"))),
                Some(caps) => Ok(vec![make_match_obj(&re, &caps, &text)]),
            }
        }
        ("match", 2) => {
            let rs = eval(&args[0], input, env)?;
            let fs = eval(&args[1], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("match: regex must be string".to_string())) };
            let flags = match fs.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("match: input must be string".to_string())) };
            let is_global = flags.contains('g');
            let pattern = apply_regex_flags(&re_str, &flags);
            let re = Regex::new(&pattern).map_err(|e| JqError::Msg(format!("match: invalid regex: {}", e)))?;
            if is_global {
                let results: Vec<JValue> = re.captures_iter(&text).map(|caps| make_match_obj(&re, &caps, &text)).collect();
                Ok(results)
            } else {
                match re.captures(&text) {
                    None => Err(JqError::Msg("match: regex did not match".to_string())),
                    Some(caps) => Ok(vec![make_match_obj(&re, &caps, &text)]),
                }
            }
        }
        ("capture", 1) => {
            let rs = eval(&args[0], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("capture: regex must be string".to_string())) };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("capture: input must be string".to_string())) };
            let re = Regex::new(&re_str).map_err(|e| JqError::Msg(format!("capture: invalid regex: {}", e)))?;
            match re.captures(&text) { None => Err(JqError::Msg("capture: regex did not match".to_string())), Some(caps) => Ok(vec![make_capture_obj(&re, &caps)]) }
        }
        ("capture", 2) => {
            let rs = eval(&args[0], input, env)?;
            let fs = eval(&args[1], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("capture: regex must be string".to_string())) };
            let flags = match fs.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("capture: input must be string".to_string())) };
            let pattern = apply_regex_flags(&re_str, &flags);
            let re = Regex::new(&pattern).map_err(|e| JqError::Msg(format!("capture: invalid regex: {}", e)))?;
            match re.captures(&text) { None => Err(JqError::Msg("capture: regex did not match".to_string())), Some(caps) => Ok(vec![make_capture_obj(&re, &caps)]) }
        }
        ("scan", 1) => {
            let rs = eval(&args[0], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("scan: regex must be string".to_string())) };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("scan: input must be string".to_string())) };
            let re = Regex::new(&re_str).map_err(|e| JqError::Msg(format!("scan: invalid regex: {}", e)))?;
            let results: Vec<JValue> = re.captures_iter(&text).map(|caps| {
                if caps.len() > 1 {
                    JValue::Array((1..caps.len()).map(|i| JValue::String(caps.get(i).map(|m| m.as_str().to_string()).unwrap_or_default())).collect())
                } else { JValue::String(caps[0].to_string()) }
            }).collect();
            Ok(results)
        }
        ("gsub", 2) | ("gsub", 3) => {
            let rs = eval(&args[0], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("gsub: regex must be string".to_string())) };
            let flags = if args.len() == 3 { let fs = eval(&args[2], input, env)?; match fs.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() } } else { String::new() };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("gsub: input must be string".to_string())) };
            let pattern = apply_regex_flags(&re_str, &flags);
            let re = Regex::new(&pattern).map_err(|e| JqError::Msg(format!("gsub: invalid regex: {}", e)))?;
            let result = regex_replace_all(&re, &text, &args[1], env, true)?;
            Ok(vec![JValue::String(result)])
        }
        ("sub", 2) | ("sub", 3) => {
            let rs = eval(&args[0], input, env)?;
            let re_str = match rs.first() { Some(JValue::String(s)) => s.clone(), _ => return Err(JqError::Msg("sub: regex must be string".to_string())) };
            let flags = if args.len() == 3 { let fs = eval(&args[2], input, env)?; match fs.first() { Some(JValue::String(s)) => s.clone(), _ => String::new() } } else { String::new() };
            let text = match input { JValue::String(s) => s.clone(), _ => return Err(JqError::Msg("sub: input must be string".to_string())) };
            let pattern = apply_regex_flags(&re_str, &flags);
            let re = Regex::new(&pattern).map_err(|e| JqError::Msg(format!("sub: invalid regex: {}", e)))?;
            let result = regex_replace_all(&re, &text, &args[1], env, false)?;
            Ok(vec![JValue::String(result)])
        }
        ("to_entries", 0) => match input {
            JValue::Object(obj) => {
                let entries: Vec<JValue> = obj.iter().map(|(k, v)| JValue::Object(vec![("key".to_string(), JValue::String(k.clone())), ("value".to_string(), v.clone())])).collect();
                Ok(vec![JValue::Array(entries)])
            }
            JValue::Array(arr) => {
                let entries: Vec<JValue> = arr.iter().enumerate().map(|(i, v)| JValue::Object(vec![("key".to_string(), JValue::Number(i as f64)), ("value".to_string(), v.clone())])).collect();
                Ok(vec![JValue::Array(entries)])
            }
            _ => Err(JqError::Msg("to_entries: input must be object or array".to_string())),
        },
        ("from_entries", 0) => match input {
            JValue::Array(arr) => {
                let mut obj: Vec<(String, JValue)> = Vec::new();
                for entry in arr {
                    match entry {
                        JValue::Object(fields) => {
                            let key = fields.iter().find(|(k, _)| k == "key" || k == "name").map(|(_, v)| match v { JValue::String(s) => s.clone(), JValue::Number(n) => format!("{}", n), _ => String::new() }).unwrap_or_default();
                            let val = fields.iter().find(|(k, _)| k == "value").map(|(_, v)| v.clone()).unwrap_or(JValue::Null);
                            obj.push((key, val));
                        }
                        _ => return Err(JqError::Msg("from_entries: each entry must be an object".to_string())),
                    }
                }
                Ok(vec![JValue::Object(obj)])
            }
            _ => Err(JqError::Msg("from_entries: input must be array".to_string())),
        },
        ("with_entries", 1) => {
            let entries_result = eval_call("to_entries", &[], input, env)?;
            let mapped: Result<Vec<JValue>, _> = entries_result.into_iter().map(|entries| {
                match entries {
                    JValue::Array(arr) => {
                        let mut mapped_arr = Vec::new();
                        for entry in &arr { mapped_arr.extend(eval(&args[0], entry, env)?); }
                        eval_call("from_entries", &[], &JValue::Array(mapped_arr), env).map(|v| v.into_iter().next().unwrap_or(JValue::Null))
                    }
                    _ => Ok(JValue::Null),
                }
            }).collect();
            Ok(mapped?)
        }
        ("del", 1) => {
            let paths = collect_paths(&args[0], input, env)?;
            let mut result = input.clone();
            let mut paths_sorted = paths;
            paths_sorted.sort_by(|a, b| b.len().cmp(&a.len()));
            for p in &paths_sorted { result = jvalue_delpath(&result, p); }
            Ok(vec![result])
        }
        ("indices", 1) => {
            let vs = eval(&args[0], input, env)?;
            let needle = vs.into_iter().next().unwrap_or(JValue::Null);
            Ok(vec![JValue::Array(find_indices(input, &needle))])
        }
        ("index", 1) => {
            let vs = eval(&args[0], input, env)?;
            let needle = vs.into_iter().next().unwrap_or(JValue::Null);
            let idxs = find_indices(input, &needle);
            Ok(vec![idxs.into_iter().next().unwrap_or(JValue::Null)])
        }
        ("rindex", 1) => {
            let vs = eval(&args[0], input, env)?;
            let needle = vs.into_iter().next().unwrap_or(JValue::Null);
            let idxs = find_indices(input, &needle);
            Ok(vec![idxs.into_iter().last().unwrap_or(JValue::Null)])
        }
        ("paths", 0) => { let mut all_paths: Vec<JValue> = Vec::new(); collect_leaf_paths(input, vec![], &mut all_paths); Ok(all_paths) }
        ("paths", 1) => {
            let f = args[0].clone();
            let mut all_paths: Vec<JValue> = Vec::new();
            let mut all: Vec<Vec<JValue>> = Vec::new();
            collect_all_paths(input, vec![], &mut all);
            for path in all {
                let leaf = jvalue_getpath(input, &path);
                let cs = eval(&f, &leaf, env)?;
                if cs.iter().any(is_truthy) { all_paths.push(JValue::Array(path)); }
            }
            Ok(all_paths)
        }
        ("leaf_paths", 0) => { let mut all_paths: Vec<JValue> = Vec::new(); collect_leaf_paths(input, vec![], &mut all_paths); Ok(all_paths) }
        ("getpath", 1) => { let ps = eval(&args[0], input, env)?; let path = ps.into_iter().next().unwrap_or(JValue::Null); let p = jvalue_to_path(&path)?; Ok(vec![jvalue_getpath(input, &p)]) }
        ("setpath", 2) => { let ps = eval(&args[0], input, env)?; let vs = eval(&args[1], input, env)?; let path = ps.into_iter().next().unwrap_or(JValue::Null); let p = jvalue_to_path(&path)?; let v = vs.into_iter().next().unwrap_or(JValue::Null); Ok(vec![jvalue_setpath(input, &p, v)?]) }
        ("delpaths", 1) => {
            let ps = eval(&args[0], input, env)?;
            let paths_v = ps.into_iter().next().unwrap_or(JValue::Null);
            match &paths_v {
                JValue::Array(paths) => {
                    let mut result = input.clone();
                    let mut path_vecs: Vec<Vec<JValue>> = paths.iter().map(|p| jvalue_to_path(p)).collect::<Result<_, _>>()?;
                    path_vecs.sort_by(|a, b| b.len().cmp(&a.len()));
                    for path in path_vecs { result = jvalue_delpath(&result, &path); }
                    Ok(vec![result])
                }
                _ => Err(JqError::Msg("delpaths: argument must be array of paths".to_string())),
            }
        }
        ("limit", 2) => {
            let ns = eval(&args[0], input, env)?;
            let n = match ns.first() { Some(JValue::Number(n)) => *n as usize, _ => return Err(JqError::Msg("limit: first arg must be number".to_string())) };
            let vs = eval(&args[1], input, env)?;
            Ok(vs.into_iter().take(n).collect())
        }
        ("until", 2) => eval_special(&Filter::Until(Box::new(args[0].clone()), Box::new(args[1].clone())), input, env),
        ("while", 2) => eval_special(&Filter::While(Box::new(args[0].clone()), Box::new(args[1].clone())), input, env),
        ("repeat", 1) => eval_special(&Filter::Repeat(Box::new(args[0].clone())), input, env),
        ("walk", 1) => eval_special(&Filter::Walk(Box::new(args[0].clone())), input, env),
        ("isempty", 1) => eval_special(&Filter::IsEmpty(Box::new(args[0].clone())), input, env),
        ("strings", 0) => Ok(if matches!(input, JValue::String(_)) { vec![input.clone()] } else { vec![] }),
        ("numbers", 0) => Ok(if matches!(input, JValue::Number(_)) { vec![input.clone()] } else { vec![] }),
        ("booleans", 0) => Ok(if matches!(input, JValue::Bool(_)) { vec![input.clone()] } else { vec![] }),
        ("nulls", 0) => Ok(if matches!(input, JValue::Null) { vec![input.clone()] } else { vec![] }),
        ("arrays", 0) => Ok(if matches!(input, JValue::Array(_)) { vec![input.clone()] } else { vec![] }),
        ("objects", 0) => Ok(if matches!(input, JValue::Object(_)) { vec![input.clone()] } else { vec![] }),
        ("iterables", 0) => Ok(if matches!(input, JValue::Array(_) | JValue::Object(_)) { vec![input.clone()] } else { vec![] }),
        ("scalars", 0) => Ok(if !matches!(input, JValue::Array(_) | JValue::Object(_)) { vec![input.clone()] } else { vec![] }),
        ("values", 0) => Ok(if !matches!(input, JValue::Null) { vec![input.clone()] } else { vec![] }),
        ("normals", 0) => Ok(if matches!(input, JValue::Number(n) if n.is_normal()) { vec![input.clone()] } else { vec![] }),
        ("infinites", 0) => Ok(if matches!(input, JValue::Number(n) if n.is_infinite()) { vec![input.clone()] } else { vec![] }),
        ("nans", 0) => Ok(if matches!(input, JValue::Number(n) if n.is_nan()) { vec![input.clone()] } else { vec![] }),
        ("env", 0) => { let obj: Vec<(String, JValue)> = std::env::vars().map(|(k, v)| (k, JValue::String(v))).collect(); Ok(vec![JValue::Object(obj)]) }
        ("path", 1) => eval_path_expr(&args[0], input, env),
        ("input_line_number", 0) => Ok(vec![JValue::Number(0.0)]),
        ("transpose", 0) => match input {
            JValue::Array(rows) => {
                let cols = rows.iter().map(|r| if let JValue::Array(a) = r { a.len() } else { 0 }).max().unwrap_or(0);
                let mut result: Vec<Vec<JValue>> = (0..cols).map(|_| Vec::new()).collect();
                for row in rows { if let JValue::Array(cells) = row { for (i, cell) in cells.iter().enumerate() { if i < cols { result[i].push(cell.clone()); } } } }
                Ok(vec![JValue::Array(result.into_iter().map(JValue::Array).collect())])
            }
            _ => Err(JqError::Msg("transpose: input must be array".to_string())),
        },
        ("modulemeta", 0) => Ok(vec![JValue::Null]),
        ("input", 0) => Ok(vec![JValue::Null]),
        ("inputs", 0) => Ok(vec![]),
        ("builtins", 0) => {
            let names = vec!["empty","error","type","null","true","false","not","nan","infinite","isinfinite","isnan","isnormal","length","utf8bytelength","keys","keys_unsorted","values","has","in","contains","inside","map","map_values","select","recurse","first","last","nth","range","flatten","sort","sort_by","group_by","unique","unique_by","min","max","min_by","max_by","add","any","all","tonumber","tostring","tojson","fromjson","ascii_downcase","ascii_upcase","ltrimstr","rtrimstr","startswith","endswith","explode","implode","split","join","test","match","capture","scan","gsub","sub","to_entries","from_entries","with_entries","del","indices","index","rindex","paths","leaf_paths","getpath","setpath","delpaths","limit","until","while","walk","isempty","strings","numbers","booleans","nulls","arrays","objects","iterables","scalars","normals","infinites","nans","env","path","input_line_number","transpose","modulemeta","debug","halt","halt_error","ascii","builtins"];
            Ok(vec![JValue::Array(names.iter().map(|s| JValue::String(s.to_string())).collect())])
        }
        _ => Err(JqError::Msg(format!("{}/{}: function not defined", name, args.len()))),
    }
}

fn apply_regex_flags(pattern: &str, flags: &str) -> String {
    let mut prefix = String::from("(?");
    let mut has_flags = false;
    if flags.contains('i') { prefix.push('i'); has_flags = true; }
    if flags.contains('x') { prefix.push('x'); has_flags = true; }
    if flags.contains('s') { prefix.push('s'); has_flags = true; }
    if flags.contains('m') { prefix.push('m'); has_flags = true; }
    if has_flags { prefix.push(')'); format!("{}{}", prefix, pattern) } else { pattern.to_string() }
}

fn make_match_obj(re: &Regex, caps: &regex::Captures<'_>, _text: &str) -> JValue {
    let m = caps.get(0).unwrap();
    let offset = m.start();
    let length = m.len();
    let matched = m.as_str().to_string();
    let captures: Vec<JValue> = (1..caps.len()).map(|i| {
        match caps.get(i) {
            Some(c) => JValue::Object(vec![("offset".to_string(), JValue::Number(c.start() as f64)), ("length".to_string(), JValue::Number(c.len() as f64)), ("string".to_string(), JValue::String(c.as_str().to_string())), ("name".to_string(), JValue::Null)]),
            None => JValue::Object(vec![("offset".to_string(), JValue::Number(-1.0)), ("length".to_string(), JValue::Number(0.0)), ("string".to_string(), JValue::Null), ("name".to_string(), JValue::Null)]),
        }
    }).collect();
    JValue::Object(vec![("offset".to_string(), JValue::Number(offset as f64)), ("length".to_string(), JValue::Number(length as f64)), ("string".to_string(), JValue::String(matched)), ("captures".to_string(), JValue::Array(captures))])
}

fn make_capture_obj(re: &Regex, caps: &regex::Captures<'_>) -> JValue {
    let mut obj: Vec<(String, JValue)> = Vec::new();
    for name in re.capture_names().flatten() {
        let val = match caps.name(name) { Some(m) => JValue::String(m.as_str().to_string()), None => JValue::Null };
        obj.push((name.to_string(), val));
    }
    if obj.is_empty() {
        for i in 1..caps.len() {
            let val = caps.get(i).map(|m| JValue::String(m.as_str().to_string())).unwrap_or(JValue::Null);
            obj.push((i.to_string(), val));
        }
    }
    JValue::Object(obj)
}

fn regex_replace_all(re: &Regex, text: &str, replacement_f: &Filter, env: &mut Env, global: bool) -> Result<String, JqError> {
    let mut result = String::new();
    let mut last_end = 0;
    for caps in re.captures_iter(text) {
        let m = caps.get(0).unwrap();
        result.push_str(&text[last_end..m.start()]);
        let cap_obj: Vec<(String, JValue)> = re.capture_names().enumerate()
            .filter_map(|(i, name)| {
                let val = caps.get(i).map(|m| JValue::String(m.as_str().to_string())).unwrap_or(JValue::Null);
                Some((name.unwrap_or(&i.to_string()).to_string(), val))
            }).collect();
        let cap_input = JValue::Object(cap_obj);
        let replacement_vals = eval(replacement_f, &cap_input, env)?;
        let replacement = match replacement_vals.into_iter().next().unwrap_or(JValue::Null) { JValue::String(s) => s, v => format_value(&v, &FormatOpts::compact()) };
        result.push_str(&replacement);
        last_end = m.end();
        if !global { break; }
    }
    result.push_str(&text[last_end..]);
    Ok(result)
}

pub fn apply_format(fmt: &str, v: &JValue) -> Result<JValue, JqError> {
    let s = match v { JValue::String(s) => s.clone(), JValue::Null => "".to_string(), _ => format_value(v, &FormatOpts::compact()) };
    match fmt {
        "json" => Ok(JValue::String(format_value(v, &FormatOpts::compact()))),
        "text" => Ok(JValue::String(s)),
        "base64" => Ok(JValue::String(base64_encode(s.as_bytes()))),
        "base64d" => {
            let decoded = base64_decode(&s).map_err(|e| JqError::Msg(format!("@base64d: {}", e)))?;
            String::from_utf8(decoded).map(|s| JValue::String(s)).map_err(|_| JqError::Msg("@base64d: invalid UTF-8".to_string()))
        }
        "html" => Ok(JValue::String(html_escape(&s))),
        "uri" => Ok(JValue::String(uri_encode(&s))),
        "csv" => match v {
            JValue::Array(arr) => {
                let parts: Vec<String> = arr.iter().map(|item| match item { JValue::String(s) => format!("\"{}\"", s.replace('"', "\"\"")), JValue::Null => String::new(), _ => format_value(item, &FormatOpts::compact()) }).collect();
                Ok(JValue::String(parts.join(",")))
            }
            _ => Err(JqError::Msg("@csv: input must be array".to_string())),
        },
        "tsv" => match v {
            JValue::Array(arr) => {
                let parts: Vec<String> = arr.iter().map(|item| match item { JValue::String(s) => s.replace('\\', "\\\\").replace('\t', "\\t").replace('\n', "\\n").replace('\r', "\\r"), JValue::Null => String::new(), _ => format_value(item, &FormatOpts::compact()) }).collect();
                Ok(JValue::String(parts.join("\t")))
            }
            _ => Err(JqError::Msg("@tsv: input must be array".to_string())),
        },
        "sh" => Ok(JValue::String(format!("'{}'", s.replace('\'', "'\\''")))),
        _ => Err(JqError::Msg(format!("unknown format @{}", fmt))),
    }
}

fn html_escape(s: &str) -> String {
    s.chars().map(|c| match c { '<' => "&lt;".to_string(), '>' => "&gt;".to_string(), '&' => "&amp;".to_string(), '\'' => "&#39;".to_string(), '"' => "&quot;".to_string(), c => c.to_string() }).collect()
}

fn uri_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() { match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char), _ => out.push_str(&format!("%{:02X}", b)) } }
    out
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[(b0 >> 2)] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const DECODE: [i8; 128] = { let mut table = [-1i8; 128]; let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; let mut i = 0usize; while i < chars.len() { table[chars[i] as usize] = i as i8; i += 1; } table };
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if s.len() % 4 != 0 { return Err("invalid base64 length".to_string()); }
    let mut out = Vec::new();
    for chunk in s.as_bytes().chunks(4) {
        let get = |c: u8| -> Result<u8, String> { if c == b'=' { return Ok(0); } if c as usize >= 128 { return Err(format!("invalid base64 char: {}", c as char)); } let v = DECODE[c as usize]; if v < 0 { Err(format!("invalid base64 char: {}", c as char)) } else { Ok(v as u8) } };
        let b0 = get(chunk[0])?; let b1 = get(chunk[1])?; let b2 = get(chunk[2])?; let b3 = get(chunk[3])?;
        out.push((b0 << 2) | (b1 >> 4));
        if chunk[2] != b'=' { out.push(((b1 & 0xf) << 4) | (b2 >> 2)); }
        if chunk[3] != b'=' { out.push(((b2 & 3) << 6) | b3); }
    }
    Ok(out)
}

fn flatten_array(v: &JValue, depth: i64) -> Result<JValue, JqError> {
    match v {
        JValue::Array(arr) => {
            let mut out = Vec::new();
            for item in arr {
                if depth != 0 { if let JValue::Array(_) = item { let sub = flatten_array(item, if depth < 0 { -1 } else { depth - 1 })?; if let JValue::Array(sub_arr) = sub { out.extend(sub_arr); } continue; } }
                out.push(item.clone());
            }
            Ok(JValue::Array(out))
        }
        _ => Err(JqError::Msg("flatten: input must be array".to_string())),
    }
}

fn jvalue_contains(a: &JValue, b: &JValue) -> bool {
    match (a, b) {
        (JValue::Null, JValue::Null) => true,
        (JValue::Bool(x), JValue::Bool(y)) => x == y,
        (JValue::Number(x), JValue::Number(y)) => x == y,
        (JValue::String(x), JValue::String(y)) => x.contains(y.as_str()),
        (JValue::Array(ax), JValue::Array(by)) => by.iter().all(|b_item| ax.iter().any(|a_item| jvalue_contains(a_item, b_item))),
        (JValue::Object(ax), JValue::Object(by)) => by.iter().all(|(bk, bv)| ax.iter().find(|(ak, _)| ak == bk).map_or(false, |(_, av)| jvalue_contains(av, bv))),
        _ => false,
    }
}

fn find_indices(v: &JValue, needle: &JValue) -> Vec<JValue> {
    match (v, needle) {
        (JValue::Array(arr), JValue::Array(sub)) => {
            let mut idxs = Vec::new();
            if sub.is_empty() { return idxs; }
            for i in 0..arr.len() { if arr[i..].starts_with(sub.as_slice()) { idxs.push(JValue::Number(i as f64)); } }
            idxs
        }
        (JValue::Array(arr), _) => arr.iter().enumerate().filter(|(_, v)| v == &needle).map(|(i, _)| JValue::Number(i as f64)).collect(),
        (JValue::String(s), JValue::String(sub)) => {
            let mut idxs = Vec::new();
            let mut start = 0;
            while let Some(pos) = s[start..].find(sub.as_str()) { idxs.push(JValue::Number((start + pos) as f64)); start += pos + sub.len().max(1); }
            idxs
        }
        _ => Vec::new(),
    }
}

fn collect_leaf_paths(v: &JValue, prefix: Vec<JValue>, out: &mut Vec<JValue>) {
    match v {
        JValue::Array(arr) if !arr.is_empty() => { for (i, child) in arr.iter().enumerate() { let mut p = prefix.clone(); p.push(JValue::Number(i as f64)); collect_leaf_paths(child, p, out); } }
        JValue::Object(obj) if !obj.is_empty() => { for (k, child) in obj { let mut p = prefix.clone(); p.push(JValue::String(k.clone())); collect_leaf_paths(child, p, out); } }
        _ => { out.push(JValue::Array(prefix)); }
    }
}

fn collect_all_paths(v: &JValue, prefix: Vec<JValue>, out: &mut Vec<Vec<JValue>>) {
    out.push(prefix.clone());
    match v {
        JValue::Array(arr) => { for (i, child) in arr.iter().enumerate() { let mut p = prefix.clone(); p.push(JValue::Number(i as f64)); collect_all_paths(child, p, out); } }
        JValue::Object(obj) => { for (k, child) in obj { let mut p = prefix.clone(); p.push(JValue::String(k.clone())); collect_all_paths(child, p, out); } }
        _ => {}
    }
}

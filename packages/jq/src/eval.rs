use std::collections::VecDeque;
use crate::json::{JValue, FormatOpts, format_value, json_type_name, parse_json};
use crate::filter::{Filter, Pattern, ObjEntry, StringPart};
use crate::builtins::eval_call;

#[derive(Debug, Clone)]
pub enum JqError {
    Msg(String),
    Break(String),
    Halt,
    HaltError(u8),
}

impl std::fmt::Display for JqError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JqError::Msg(s) => write!(f, "{}", s),
            JqError::Break(l) => write!(f, "break ${}", l),
            JqError::Halt => write!(f, "halt"),
            JqError::HaltError(c) => write!(f, "halt_error({})", c),
        }
    }
}

#[derive(Clone)]
pub struct FuncDef {
    pub params: Vec<String>,
    pub body: Filter,
}

#[derive(Clone)]
pub struct Env {
    pub vars: Vec<(String, JValue)>,
    pub funcs: std::collections::HashMap<String, Vec<FuncDef>>,
}

impl Env {
    pub fn new() -> Self {
        Env { vars: Vec::new(), funcs: std::collections::HashMap::new() }
    }

    pub fn bind(&mut self, name: String, val: JValue) {
        self.vars.push((name, val));
    }

    pub fn lookup_var(&self, name: &str) -> Option<&JValue> {
        self.vars.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v)
    }

    pub fn define_func(&mut self, name: String, params: Vec<String>, body: Filter) {
        self.funcs.entry(name).or_default().push(FuncDef { params, body });
    }

    pub fn lookup_func(&self, name: &str, arity: usize) -> Option<&FuncDef> {
        if let Some(defs) = self.funcs.get(name) {
            defs.iter().rev().find(|d| d.params.len() == arity)
        } else { None }
    }

    pub fn child(&self) -> Env {
        Env { vars: self.vars.clone(), funcs: self.funcs.clone() }
    }
}

pub fn eval(filter: &Filter, input: &JValue, env: &mut Env) -> Result<Vec<JValue>, JqError> {
    match filter {
        Filter::Identity => Ok(vec![input.clone()]),

        Filter::Recurse => {
            let mut out = Vec::new();
            collect_recurse(input, &mut out);
            Ok(out)
        }

        Filter::Literal(v) => Ok(vec![v.clone()]),

        Filter::Var(name) => {
            if name == "__loc__" {
                return Ok(vec![JValue::Object(vec![
                    ("file".to_string(), JValue::String("unknown".to_string())),
                    ("line".to_string(), JValue::Number(0.0)),
                ])]);
            }
            match env.lookup_var(name) {
                Some(v) => Ok(vec![v.clone()]),
                None => Err(JqError::Msg(format!("${} is not defined", name))),
            }
        }

        Filter::Field(name, optional) => {
            match input {
                JValue::Object(obj) => {
                    let v = obj.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
                        .unwrap_or(JValue::Null);
                    Ok(vec![v])
                }
                JValue::Null => Ok(vec![JValue::Null]),
                _ => {
                    if *optional { Ok(vec![]) }
                    else { Err(JqError::Msg(format!("null (null) and {} ({})) cannot be iterated over", name, json_type_name(input)))) }
                }
            }
        }

        Filter::Index(idx_filter) => {
            let indices = eval(idx_filter, input, env)?;
            let mut out = Vec::new();
            for idx in indices {
                let v = jvalue_index(input, &idx)?;
                out.push(v);
            }
            Ok(out)
        }

        Filter::Slice(from_f, to_f) => {
            let from_vals: Vec<JValue> = if let Some(f) = from_f {
                eval(f, input, env)?
            } else { vec![JValue::Null] };
            let to_vals: Vec<JValue> = if let Some(f) = to_f {
                eval(f, input, env)?
            } else { vec![JValue::Null] };
            let mut out = Vec::new();
            for fv in &from_vals {
                for tv in &to_vals {
                    out.push(jvalue_slice(input, fv, tv)?);
                }
            }
            Ok(out)
        }

        Filter::Iter(optional) => {
            match input {
                JValue::Array(arr) => Ok(arr.clone()),
                JValue::Object(obj) => Ok(obj.iter().map(|(_, v)| v.clone()).collect()),
                _ => {
                    if *optional { Ok(vec![]) }
                    else { Err(JqError::Msg(format!("null (null) and {} cannot be iterated over", json_type_name(input)))) }
                }
            }
        }

        Filter::Pipe(left, right) => {
            let lefts = eval(left, input, env)?;
            let mut out = Vec::new();
            for v in lefts {
                let rights = eval(right, &v, env)?;
                out.extend(rights);
            }
            Ok(out)
        }

        Filter::Comma(left, right) => {
            let mut out = eval(left, input, env)?;
            out.extend(eval(right, input, env)?);
            Ok(out)
        }

        Filter::Array(inner) => {
            let items = eval(inner, input, env)?;
            Ok(vec![JValue::Array(items)])
        }

        Filter::Object(entries) => {
            let mut results: Vec<Vec<(String, JValue)>> = vec![vec![]];
            for entry in entries {
                match entry {
                    ObjEntry::Fixed(key, val_filter) => {
                        let vals = eval(val_filter, input, env)?;
                        let mut new_results = Vec::new();
                        for base in &results {
                            for v in &vals {
                                let mut obj = base.clone();
                                obj.push((key.clone(), v.clone()));
                                new_results.push(obj);
                            }
                        }
                        results = new_results;
                    }
                    ObjEntry::Shorthand(key) => {
                        let field_val = match input {
                            JValue::Object(obj) => obj.iter().find(|(k,_)| k == key)
                                .map(|(_,v)| v.clone()).unwrap_or(JValue::Null),
                            _ => JValue::Null,
                        };
                        for base in &mut results {
                            base.push((key.clone(), field_val.clone()));
                        }
                    }
                    ObjEntry::Computed(key_filter, val_filter) => {
                        let keys = eval(key_filter, input, env)?;
                        let vals = eval(val_filter, input, env)?;
                        let mut new_results = Vec::new();
                        for base in &results {
                            for k in &keys {
                                for v in &vals {
                                    let key_str = match k {
                                        JValue::String(s) => s.clone(),
                                        _ => format_value(k, &FormatOpts::compact()),
                                    };
                                    let mut obj = base.clone();
                                    obj.push((key_str, v.clone()));
                                    new_results.push(obj);
                                }
                            }
                        }
                        results = new_results;
                    }
                }
            }
            Ok(results.into_iter().map(JValue::Object).collect())
        }

        Filter::Try(body, handler) => {
            match eval(body, input, env) {
                Ok(v) => Ok(v),
                Err(JqError::Break(l)) => Err(JqError::Break(l)),
                Err(JqError::Halt) => Err(JqError::Halt),
                Err(JqError::HaltError(c)) => Err(JqError::HaltError(c)),
                Err(e) => {
                    if let Some(h) = handler {
                        let err_val = JValue::String(e.to_string());
                        eval(h, &err_val, env)
                    } else {
                        Ok(vec![])
                    }
                }
            }
        }

        Filter::Optional(inner) => {
            match eval(inner, input, env) {
                Ok(v) => Ok(v),
                Err(JqError::Break(l)) => Err(JqError::Break(l)),
                Err(JqError::Halt) => Err(JqError::Halt),
                Err(JqError::HaltError(c)) => Err(JqError::HaltError(c)),
                Err(_) => Ok(vec![]),
            }
        }

        Filter::Neg(inner) => {
            let vs = eval(inner, input, env)?;
            vs.into_iter().map(|v| match v {
                JValue::Number(n) => Ok(JValue::Number(-n)),
                _ => Err(JqError::Msg(format!("cannot negate {}", json_type_name(&v)))),
            }).collect()
        }

        Filter::Add(l, r) => eval_binop(l, r, input, env, jvalue_add),
        Filter::Sub(l, r) => eval_binop(l, r, input, env, jvalue_sub),
        Filter::Mul(l, r) => eval_binop(l, r, input, env, jvalue_mul),
        Filter::Div(l, r) => eval_binop(l, r, input, env, jvalue_div),
        Filter::Mod(l, r) => eval_binop(l, r, input, env, jvalue_mod),

        Filter::Eq(l, r) => eval_binop(l, r, input, env, |a, b| Ok(JValue::Bool(a == b))),
        Filter::Ne(l, r) => eval_binop(l, r, input, env, |a, b| Ok(JValue::Bool(a != b))),
        Filter::Lt(l, r) => eval_binop(l, r, input, env, |a, b| Ok(JValue::Bool(jvalue_cmp(&a, &b) < 0))),
        Filter::Le(l, r) => eval_binop(l, r, input, env, |a, b| Ok(JValue::Bool(jvalue_cmp(&a, &b) <= 0))),
        Filter::Gt(l, r) => eval_binop(l, r, input, env, |a, b| Ok(JValue::Bool(jvalue_cmp(&a, &b) > 0))),
        Filter::Ge(l, r) => eval_binop(l, r, input, env, |a, b| Ok(JValue::Bool(jvalue_cmp(&a, &b) >= 0))),

        Filter::And(l, r) => {
            let ls = eval(l, input, env)?;
            let mut out = Vec::new();
            for lv in ls {
                let lb = is_truthy(&lv);
                if !lb {
                    out.push(JValue::Bool(false));
                } else {
                    let rs = eval(r, input, env)?;
                    for rv in rs {
                        out.push(JValue::Bool(is_truthy(&rv)));
                    }
                }
            }
            Ok(out)
        }

        Filter::Or(l, r) => {
            let ls = eval(l, input, env)?;
            let mut out = Vec::new();
            for lv in ls {
                let lb = is_truthy(&lv);
                if lb {
                    out.push(JValue::Bool(true));
                } else {
                    let rs = eval(r, input, env)?;
                    for rv in rs {
                        out.push(JValue::Bool(is_truthy(&rv)));
                    }
                }
            }
            Ok(out)
        }

        Filter::Not => {
            Ok(vec![JValue::Bool(!is_truthy(input))])
        }

        Filter::Alt(l, r) => {
            let ls = eval(l, input, env)?;
            let all_falsy = ls.iter().all(|v| !is_truthy(v));
            if all_falsy || ls.is_empty() {
                eval(r, input, env)
            } else {
                Ok(ls)
            }
        }

        Filter::IfElse(cond, then_f, elif_branches, else_f) => {
            let conds = eval(cond, input, env)?;
            let mut out = Vec::new();
            for cv in conds {
                if is_truthy(&cv) {
                    out.extend(eval(then_f, input, env)?);
                } else {
                    let mut matched = false;
                    for (ec, et) in elif_branches {
                        let evs = eval(ec, input, env)?;
                        if evs.iter().any(is_truthy) {
                            out.extend(eval(et, input, env)?);
                            matched = true;
                            break;
                        }
                    }
                    if !matched {
                        if let Some(ef) = else_f {
                            out.extend(eval(ef, input, env)?);
                        }
                    }
                }
            }
            Ok(out)
        }

        Filter::Reduce(gen_f, pat, body) => {
            let (init_f, update_f) = match body.as_ref() {
                Filter::Pipe(a, b) => (a.as_ref(), b.as_ref()),
                _ => unreachable!(),
            };
            let mut acc = eval(init_f, input, env)?.into_iter().next().unwrap_or(JValue::Null);
            let gen_vals = eval(gen_f, input, env)?;
            for gv in gen_vals {
                let mut child = env.child();
                bind_pattern(pat, &gv, &mut child)?;
                let updates = eval(update_f, &acc, &mut child)?;
                acc = updates.into_iter().next().unwrap_or(JValue::Null);
            }
            Ok(vec![acc])
        }

        Filter::Foreach(gen_f, pat, body, extract) => {
            let (init_f, update_f) = match body.as_ref() {
                Filter::Pipe(a, b) => (a.as_ref(), b.as_ref()),
                _ => unreachable!(),
            };
            let mut acc = eval(init_f, input, env)?.into_iter().next().unwrap_or(JValue::Null);
            let gen_vals = eval(gen_f, input, env)?;
            let mut out = Vec::new();
            for gv in gen_vals {
                let mut child = env.child();
                bind_pattern(pat, &gv, &mut child)?;
                let updates = eval(update_f, &acc, &mut child)?;
                acc = updates.into_iter().next().unwrap_or(JValue::Null);
                if let Some(ef) = extract {
                    let extracted = eval(ef, &acc, env)?;
                    out.extend(extracted);
                } else {
                    out.push(acc.clone());
                }
            }
            Ok(out)
        }

        Filter::Label(name, body) => {
            match eval(body, input, env) {
                Ok(v) => Ok(v),
                Err(JqError::Break(l)) if &l == name => Ok(vec![]),
                Err(e) => Err(e),
            }
        }

        Filter::Break(name) => Err(JqError::Break(name.clone())),

        Filter::Binding(expr, pat, body) => {
            let vals = eval(expr, input, env)?;
            let mut out = Vec::new();
            for v in vals {
                let mut child = env.child();
                bind_pattern(pat, &v, &mut child)?;
                out.extend(eval(body, input, &mut child)?);
            }
            Ok(out)
        }

        Filter::FuncDef(name, params, body, rest) => {
            let mut child = env.child();
            child.define_func(name.clone(), params.clone(), *body.clone());
            eval(rest, input, &mut child)
        }

        Filter::Call(name, args) => {
            eval_call(name, args, input, env)
        }

        Filter::StringInterp(parts) => {
            let mut s = String::new();
            for part in parts {
                match part {
                    StringPart::Literal(lit) => s.push_str(lit),
                    StringPart::Interp(f) => {
                        let vs = eval(f, input, env)?;
                        for v in vs {
                            match &v {
                                JValue::String(st) => s.push_str(st),
                                _ => s.push_str(&format_value(&v, &FormatOpts::compact())),
                            }
                        }
                    }
                }
            }
            Ok(vec![JValue::String(s)])
        }

        Filter::Format(fmt_name, inner) => {
            let vals = if let Some(f) = inner {
                eval(f, input, env)?
            } else {
                vec![input.clone()]
            };
            vals.into_iter().map(|v| crate::builtins::apply_format(fmt_name, &v)).collect()
        }

        Filter::Path(inner) => {
            eval_path_expr(inner, input, env)
        }

        Filter::Assign(path_f, val_f) => {
            let vals = eval(val_f, input, env)?;
            let mut out = Vec::new();
            for val in vals {
                let paths = collect_paths(path_f, input, env)?;
                let mut result = input.clone();
                for p in &paths {
                    result = jvalue_setpath(&result, p, val.clone())?;
                }
                out.push(result);
            }
            if out.is_empty() {
                Ok(vec![input.clone()])
            } else {
                Ok(out)
            }
        }

        Filter::UpdateAdd(path_f, val_f) => eval_update(path_f, val_f, input, env, jvalue_add),
        Filter::UpdateSub(path_f, val_f) => eval_update(path_f, val_f, input, env, jvalue_sub),
        Filter::UpdateMul(path_f, val_f) => eval_update(path_f, val_f, input, env, jvalue_mul),
        Filter::UpdateDiv(path_f, val_f) => eval_update(path_f, val_f, input, env, jvalue_div),
        Filter::UpdateMod(path_f, val_f) => eval_update(path_f, val_f, input, env, jvalue_mod),
        Filter::UpdateAlt(path_f, val_f) => {
            let paths = collect_paths(path_f, input, env)?;
            let mut result = input.clone();
            for p in &paths {
                let cur = jvalue_getpath(&result, p);
                if !is_truthy(&cur) {
                    let new_vals = eval(val_f, &cur, env)?;
                    if let Some(nv) = new_vals.into_iter().next() {
                        result = jvalue_setpath(&result, p, nv)?;
                    }
                }
            }
            Ok(vec![result])
        }

        Filter::GetPath(path_f) => {
            let paths = eval(path_f, input, env)?;
            paths.into_iter().map(|p| {
                let path = jvalue_to_path(&p)?;
                Ok(jvalue_getpath(input, &path))
            }).collect()
        }

        Filter::SetPath(path_f, val_f) => {
            let paths = eval(path_f, input, env)?;
            let vals = eval(val_f, input, env)?;
            let mut out = Vec::new();
            for p in &paths {
                let path = jvalue_to_path(p)?;
                for v in &vals {
                    out.push(jvalue_setpath(input, &path, v.clone())?);
                }
            }
            Ok(out)
        }

        Filter::DelPaths(paths_f) => {
            let paths_list = eval(paths_f, input, env)?;
            let mut result = input.clone();
            for pv in &paths_list {
                match pv {
                    JValue::Array(paths) => {
                        let mut path_vecs: Vec<Vec<JValue>> = paths.iter()
                            .map(|p| jvalue_to_path(p))
                            .collect::<Result<_, _>>()?;
                        path_vecs.sort_by(|a, b| b.len().cmp(&a.len()));
                        for path in path_vecs {
                            result = jvalue_delpath(&result, &path);
                        }
                    }
                    _ => return Err(JqError::Msg("delpaths: argument must be array".to_string())),
                }
            }
            Ok(vec![result])
        }

        Filter::Debug(msg_f) => {
            if let Some(mf) = msg_f {
                let msgs = eval(mf, input, env)?;
                for m in msgs {
                    let s = match &m {
                        JValue::String(s) => format!("DEBUG: {}\n", s),
                        _ => format!("DEBUG: {}\n", format_value(&m, &FormatOpts::compact())),
                    };
                    write_stderr(&s);
                }
            } else {
                write_stderr(&format!("DEBUG: {}\n", format_value(input, &FormatOpts::compact())));
            }
            Ok(vec![input.clone()])
        }

        Filter::Error(msg_f) => {
            if let Some(mf) = msg_f {
                let msgs = eval(mf, input, env)?;
                let msg = msgs.into_iter().next().unwrap_or(JValue::Null);
                Err(JqError::Msg(match msg {
                    JValue::String(s) => s,
                    v => format_value(&v, &FormatOpts::compact()),
                }))
            } else {
                Err(JqError::Msg(match input {
                    JValue::String(s) => s.clone(),
                    v => format_value(v, &FormatOpts::compact()),
                }))
            }
        }

        Filter::Env => {
            let obj: Vec<(String, JValue)> = std::env::vars()
                .map(|(k, v)| (k, JValue::String(v)))
                .collect();
            Ok(vec![JValue::Object(obj)])
        }

        Filter::EnvVar => {
            let obj: Vec<(String, JValue)> = std::env::vars()
                .map(|(k, v)| (k, JValue::String(v)))
                .collect();
            Ok(vec![JValue::Object(obj)])
        }

        Filter::InputLine => {
            Ok(vec![JValue::Number(0.0)])
        }

        Filter::Limit(_, _) | Filter::First(_) | Filter::Last(_) | Filter::Nth(_, _) |
        Filter::Until(_, _) | Filter::While(_, _) | Filter::Repeat(_) |
        Filter::Recurse2(_) | Filter::RecurseF(_, _) | Filter::Walk(_) |
        Filter::IsEmpty(_) | Filter::AnyF(_) | Filter::AllF(_) |
        Filter::AnyG(_, _) | Filter::AllG(_, _) => {
            eval_special(filter, input, env)
        }
    }
}

pub fn eval_special(filter: &Filter, input: &JValue, env: &mut Env) -> Result<Vec<JValue>, JqError> {
    match filter {
        Filter::Limit(n_f, gen_f) => {
            let ns = eval(n_f, input, env)?;
            let n = match ns.first() {
                Some(JValue::Number(n)) => *n as usize,
                _ => return Err(JqError::Msg("limit: first arg must be number".to_string())),
            };
            let vs = eval(gen_f, input, env)?;
            Ok(vs.into_iter().take(n).collect())
        }
        Filter::First(gen_f) => {
            let vs = eval(gen_f, input, env)?;
            Ok(vs.into_iter().take(1).collect())
        }
        Filter::Last(gen_f) => {
            let vs = eval(gen_f, input, env)?;
            Ok(vs.into_iter().last().into_iter().collect())
        }
        Filter::Nth(n_f, gen_f) => {
            let ns = eval(n_f, input, env)?;
            let n = match ns.first() {
                Some(JValue::Number(n)) => *n as usize,
                _ => return Err(JqError::Msg("nth: first arg must be number".to_string())),
            };
            let vs = eval(gen_f, input, env)?;
            Ok(vs.into_iter().nth(n).into_iter().collect())
        }
        Filter::Until(cond_f, update_f) => {
            let mut cur = input.clone();
            for _ in 0..1_000_000 {
                let cs = eval(cond_f, &cur, env)?;
                if cs.first().map_or(false, is_truthy) { break; }
                let us = eval(update_f, &cur, env)?;
                cur = us.into_iter().next().unwrap_or(JValue::Null);
            }
            Ok(vec![cur])
        }
        Filter::While(cond_f, update_f) => {
            let mut cur = input.clone();
            let mut out = Vec::new();
            for _ in 0..1_000_000 {
                let cs = eval(cond_f, &cur, env)?;
                if !cs.first().map_or(false, is_truthy) { break; }
                out.push(cur.clone());
                let us = eval(update_f, &cur, env)?;
                cur = us.into_iter().next().unwrap_or(JValue::Null);
            }
            Ok(out)
        }
        Filter::Repeat(f) => {
            let mut cur = input.clone();
            let mut out = Vec::new();
            for _ in 0..1_000_000 {
                match eval(f, &cur, env) {
                    Ok(vs) => {
                        cur = vs.into_iter().next().unwrap_or(JValue::Null);
                        out.push(cur.clone());
                    }
                    Err(_) => break,
                }
            }
            Ok(out)
        }
        Filter::IsEmpty(gen_f) => {
            let vs = eval(gen_f, input, env)?;
            Ok(vec![JValue::Bool(vs.is_empty())])
        }
        Filter::AnyF(f) => {
            let vs = eval(f, input, env)?;
            Ok(vec![JValue::Bool(vs.iter().any(is_truthy))])
        }
        Filter::AllF(f) => {
            let vs = eval(f, input, env)?;
            Ok(vec![JValue::Bool(vs.iter().all(is_truthy))])
        }
        Filter::AnyG(gen_f, cond_f) => {
            let gen_vals = eval(gen_f, input, env)?;
            for v in gen_vals {
                let cs = eval(cond_f, &v, env)?;
                if cs.iter().any(is_truthy) { return Ok(vec![JValue::Bool(true)]); }
            }
            Ok(vec![JValue::Bool(false)])
        }
        Filter::AllG(gen_f, cond_f) => {
            let gen_vals = eval(gen_f, input, env)?;
            for v in gen_vals {
                let cs = eval(cond_f, &v, env)?;
                if !cs.iter().all(is_truthy) { return Ok(vec![JValue::Bool(false)]); }
            }
            Ok(vec![JValue::Bool(true)])
        }
        Filter::Walk(f) => {
            fn walk_val(v: &JValue, f: &Filter, env: &mut Env) -> Result<JValue, JqError> {
                let walked = match v {
                    JValue::Array(arr) => {
                        let items: Result<Vec<JValue>, _> = arr.iter().map(|x| walk_val(x, f, env)).collect();
                        JValue::Array(items?)
                    }
                    JValue::Object(obj) => {
                        let fields: Result<Vec<(String, JValue)>, _> = obj.iter()
                            .map(|(k, x)| walk_val(x, f, env).map(|v2| (k.clone(), v2)))
                            .collect();
                        JValue::Object(fields?)
                    }
                    _ => v.clone(),
                };
                let out = eval(f, &walked, env)?;
                Ok(out.into_iter().next().unwrap_or(JValue::Null))
            }
            let result = walk_val(input, f, env)?;
            Ok(vec![result])
        }
        Filter::Recurse2(f) => {
            let mut out = vec![input.clone()];
            let mut queue = VecDeque::new();
            queue.push_back(input.clone());
            while let Some(cur) = queue.pop_front() {
                let children = match eval(f, &cur, env) {
                    Ok(vs) => vs,
                    Err(_) => continue,
                };
                for child in children {
                    out.push(child.clone());
                    queue.push_back(child);
                }
            }
            Ok(out)
        }
        Filter::RecurseF(f, cond_opt) => {
            let mut out = vec![input.clone()];
            let mut queue = VecDeque::new();
            queue.push_back(input.clone());
            while let Some(cur) = queue.pop_front() {
                let children = match eval(f, &cur, env) {
                    Ok(vs) => vs,
                    Err(_) => continue,
                };
                for child in children {
                    let include = if let Some(cf) = cond_opt {
                        eval(cf, &child, env)?.iter().any(is_truthy)
                    } else { true };
                    if include {
                        out.push(child.clone());
                        queue.push_back(child);
                    }
                }
            }
            Ok(out)
        }
        _ => Err(JqError::Msg(format!("unhandled special filter"))),
    }
}

fn eval_binop<F>(l: &Filter, r: &Filter, input: &JValue, env: &mut Env, op: F) -> Result<Vec<JValue>, JqError>
where F: Fn(JValue, JValue) -> Result<JValue, JqError>
{
    let ls = eval(l, input, env)?;
    let rs = eval(r, input, env)?;
    let mut out = Vec::new();
    for lv in &ls {
        for rv in &rs {
            out.push(op(lv.clone(), rv.clone())?);
        }
    }
    Ok(out)
}

pub fn eval_update<F>(path_f: &Filter, val_f: &Filter, input: &JValue, env: &mut Env, op: F) -> Result<Vec<JValue>, JqError>
where F: Fn(JValue, JValue) -> Result<JValue, JqError>
{
    let paths = collect_paths(path_f, input, env)?;
    let mut result = input.clone();
    for p in &paths {
        let cur = jvalue_getpath(&result, p);
        let new_vals = eval(val_f, &cur, env)?;
        if let Some(nv) = new_vals.into_iter().next() {
            let updated = op(cur, nv)?;
            result = jvalue_setpath(&result, p, updated)?;
        }
    }
    Ok(vec![result])
}

pub fn bind_pattern(pat: &Pattern, val: &JValue, env: &mut Env) -> Result<(), JqError> {
    match pat {
        Pattern::Var(name) => {
            env.bind(name.clone(), val.clone());
            Ok(())
        }
        Pattern::Array(pats) => {
            match val {
                JValue::Array(arr) => {
                    for (i, p) in pats.iter().enumerate() {
                        let v = arr.get(i).cloned().unwrap_or(JValue::Null);
                        bind_pattern(p, &v, env)?;
                    }
                    Ok(())
                }
                _ => Err(JqError::Msg(format!("cannot destructure {} as array", json_type_name(val)))),
            }
        }
        Pattern::Object(fields) => {
            for (key, p) in fields {
                let v = match val {
                    JValue::Object(obj) => obj.iter().find(|(k, _)| k == key)
                        .map(|(_, v)| v.clone()).unwrap_or(JValue::Null),
                    _ => JValue::Null,
                };
                bind_pattern(p, &v, env)?;
            }
            Ok(())
        }
    }
}

pub type Path = Vec<JValue>;

pub fn jvalue_getpath(v: &JValue, path: &[JValue]) -> JValue {
    if path.is_empty() { return v.clone(); }
    match (&path[0], v) {
        (JValue::String(k), JValue::Object(obj)) => {
            let child = obj.iter().find(|(ck, _)| ck == k).map(|(_, v)| v.clone()).unwrap_or(JValue::Null);
            jvalue_getpath(&child, &path[1..])
        }
        (JValue::Number(n), JValue::Array(arr)) => {
            let idx = normalize_index(*n as i64, arr.len());
            let child = arr.get(idx).cloned().unwrap_or(JValue::Null);
            jvalue_getpath(&child, &path[1..])
        }
        _ => JValue::Null,
    }
}

pub fn jvalue_setpath(v: &JValue, path: &[JValue], new_val: JValue) -> Result<JValue, JqError> {
    if path.is_empty() { return Ok(new_val); }
    match &path[0] {
        JValue::String(k) => {
            let obj = match v {
                JValue::Object(obj) => obj.clone(),
                JValue::Null => Vec::new(),
                _ => return Err(JqError::Msg(format!("cannot set field on {}", json_type_name(v)))),
            };
            let mut new_obj = obj;
            let key = k.clone();
            let child = new_obj.iter().find(|(ck, _)| ck == &key).map(|(_, v)| v.clone()).unwrap_or(JValue::Null);
            let updated = jvalue_setpath(&child, &path[1..], new_val)?;
            if let Some(pos) = new_obj.iter().position(|(ck, _)| ck == &key) {
                new_obj[pos].1 = updated;
            } else {
                new_obj.push((key, updated));
            }
            Ok(JValue::Object(new_obj))
        }
        JValue::Number(n) => {
            let mut arr = match v {
                JValue::Array(a) => a.clone(),
                JValue::Null => Vec::new(),
                _ => return Err(JqError::Msg(format!("cannot index {} with number", json_type_name(v)))),
            };
            let idx = normalize_index(*n as i64, arr.len());
            while arr.len() <= idx { arr.push(JValue::Null); }
            let child = arr[idx].clone();
            arr[idx] = jvalue_setpath(&child, &path[1..], new_val)?;
            Ok(JValue::Array(arr))
        }
        _ => Err(JqError::Msg("invalid path element".to_string())),
    }
}

pub fn jvalue_delpath(v: &JValue, path: &[JValue]) -> JValue {
    if path.is_empty() { return JValue::Null; }
    if path.len() == 1 {
        match (&path[0], v) {
            (JValue::String(k), JValue::Object(obj)) => {
                let new_obj: Vec<_> = obj.iter().filter(|(ck, _)| ck != k).cloned().collect();
                return JValue::Object(new_obj);
            }
            (JValue::Number(n), JValue::Array(arr)) => {
                let idx = normalize_index(*n as i64, arr.len());
                if idx < arr.len() {
                    let mut new_arr = arr.clone();
                    new_arr.remove(idx);
                    return JValue::Array(new_arr);
                }
                return v.clone();
            }
            _ => return v.clone(),
        }
    }
    match (&path[0], v) {
        (JValue::String(k), JValue::Object(obj)) => {
            let new_obj: Vec<_> = obj.iter().map(|(ck, cv)| {
                if ck == k { (ck.clone(), jvalue_delpath(cv, &path[1..])) }
                else { (ck.clone(), cv.clone()) }
            }).collect();
            JValue::Object(new_obj)
        }
        (JValue::Number(n), JValue::Array(arr)) => {
            let idx = normalize_index(*n as i64, arr.len());
            let mut new_arr = arr.clone();
            if idx < new_arr.len() {
                new_arr[idx] = jvalue_delpath(&new_arr[idx].clone(), &path[1..]);
            }
            JValue::Array(new_arr)
        }
        _ => v.clone(),
    }
}

pub fn jvalue_to_path(v: &JValue) -> Result<Path, JqError> {
    match v {
        JValue::Array(arr) => Ok(arr.clone()),
        _ => Err(JqError::Msg("path must be array".to_string())),
    }
}

pub fn collect_paths(path_f: &Filter, input: &JValue, env: &mut Env) -> Result<Vec<Path>, JqError> {
    eval_path_expr(path_f, input, env).map(|vs| {
        vs.into_iter().map(|v| match v {
            JValue::Array(a) => a,
            _ => vec![],
        }).collect()
    })
}

pub fn eval_path_expr(filter: &Filter, input: &JValue, env: &mut Env) -> Result<Vec<JValue>, JqError> {
    fn collect(filter: &Filter, input: &JValue, env: &mut Env, prefix: Vec<JValue>, out: &mut Vec<Vec<JValue>>) -> Result<(), JqError> {
        match filter {
            Filter::Identity => { out.push(prefix); Ok(()) }
            Filter::Field(name, opt) => {
                match input {
                    JValue::Object(_) | JValue::Null => {
                        let mut p = prefix.clone();
                        p.push(JValue::String(name.clone()));
                        out.push(p);
                        Ok(())
                    }
                    _ if *opt => Ok(()),
                    _ => Err(JqError::Msg(format!("cannot index {} with string", json_type_name(input)))),
                }
            }
            Filter::Index(idx_f) => {
                let idxs = eval(idx_f, input, env)?;
                for idx in idxs {
                    let mut p = prefix.clone();
                    p.push(idx);
                    out.push(p);
                }
                Ok(())
            }
            Filter::Iter(_opt) => {
                match input {
                    JValue::Array(arr) => {
                        for i in 0..arr.len() {
                            let mut p = prefix.clone();
                            p.push(JValue::Number(i as f64));
                            out.push(p);
                        }
                        Ok(())
                    }
                    JValue::Object(obj) => {
                        for (k, _) in obj {
                            let mut p = prefix.clone();
                            p.push(JValue::String(k.clone()));
                            out.push(p);
                        }
                        Ok(())
                    }
                    _ => Ok(()),
                }
            }
            Filter::Pipe(left, right) => {
                let mut left_paths: Vec<Vec<JValue>> = Vec::new();
                collect(left, input, env, vec![], &mut left_paths)?;
                for lp in left_paths {
                    let child_input = jvalue_getpath(input, &lp);
                    let mut sub_paths: Vec<Vec<JValue>> = Vec::new();
                    collect(right, &child_input, env, vec![], &mut sub_paths)?;
                    for sp in sub_paths {
                        let mut full = prefix.clone();
                        full.extend(lp.clone());
                        full.extend(sp);
                        out.push(full);
                    }
                }
                Ok(())
            }
            Filter::Comma(l, r) => {
                collect(l, input, env, prefix.clone(), out)?;
                collect(r, input, env, prefix, out)?;
                Ok(())
            }
            Filter::Recurse => {
                fn recurse_paths(v: &JValue, prefix: Vec<JValue>, out: &mut Vec<Vec<JValue>>) {
                    out.push(prefix.clone());
                    match v {
                        JValue::Array(arr) => {
                            for (i, child) in arr.iter().enumerate() {
                                let mut p = prefix.clone();
                                p.push(JValue::Number(i as f64));
                                recurse_paths(child, p, out);
                            }
                        }
                        JValue::Object(obj) => {
                            for (k, child) in obj {
                                let mut p = prefix.clone();
                                p.push(JValue::String(k.clone()));
                                recurse_paths(child, p, out);
                            }
                        }
                        _ => {}
                    }
                }
                recurse_paths(input, prefix, out);
                Ok(())
            }
            _ => {
                let vs = eval(filter, input, env)?;
                for _ in vs {
                    out.push(prefix.clone());
                }
                Ok(())
            }
        }
    }

    let mut paths: Vec<Vec<JValue>> = Vec::new();
    collect(filter, input, env, vec![], &mut paths)?;
    Ok(paths.into_iter().map(JValue::Array).collect())
}

pub fn jvalue_add(a: JValue, b: JValue) -> Result<JValue, JqError> {
    match (a, b) {
        (JValue::Null, x) | (x, JValue::Null) => Ok(x),
        (JValue::Number(x), JValue::Number(y)) => Ok(JValue::Number(x + y)),
        (JValue::String(x), JValue::String(y)) => Ok(JValue::String(x + &y)),
        (JValue::Array(mut x), JValue::Array(y)) => { x.extend(y); Ok(JValue::Array(x)) }
        (JValue::Object(mut x), JValue::Object(y)) => {
            for (k, v) in y {
                if let Some(pos) = x.iter().position(|(ck, _)| ck == &k) {
                    x[pos].1 = v;
                } else {
                    x.push((k, v));
                }
            }
            Ok(JValue::Object(x))
        }
        (a, b) => Err(JqError::Msg(format!("{} and {} cannot be added", json_type_name(&a), json_type_name(&b)))),
    }
}

pub fn jvalue_sub(a: JValue, b: JValue) -> Result<JValue, JqError> {
    match (a, b) {
        (JValue::Number(x), JValue::Number(y)) => Ok(JValue::Number(x - y)),
        (JValue::Array(x), JValue::Array(y)) => {
            let result: Vec<JValue> = x.into_iter().filter(|v| !y.contains(v)).collect();
            Ok(JValue::Array(result))
        }
        (a, b) => Err(JqError::Msg(format!("{} and {} cannot be subtracted", json_type_name(&a), json_type_name(&b)))),
    }
}

pub fn jvalue_mul(a: JValue, b: JValue) -> Result<JValue, JqError> {
    match (a, b) {
        (JValue::Number(x), JValue::Number(y)) => Ok(JValue::Number(x * y)),
        (JValue::String(s), JValue::Number(n)) | (JValue::Number(n), JValue::String(s)) => {
            if n <= 0.0 { return Ok(JValue::Null); }
            let count = n as usize;
            Ok(JValue::String(s.repeat(count)))
        }
        (JValue::Object(mut x), JValue::Object(y)) => {
            fn merge_obj(base: &mut Vec<(String, JValue)>, overlay: Vec<(String, JValue)>) {
                for (k, v) in overlay {
                    if let Some(pos) = base.iter().position(|(ck, _)| ck == &k) {
                        match (&base[pos].1.clone(), &v) {
                            (JValue::Object(bo), JValue::Object(ov)) => {
                                let mut merged = bo.clone();
                                merge_obj(&mut merged, ov.clone());
                                base[pos].1 = JValue::Object(merged);
                            }
                            _ => { base[pos].1 = v; }
                        }
                    } else {
                        base.push((k, v));
                    }
                }
            }
            merge_obj(&mut x, y);
            Ok(JValue::Object(x))
        }
        (a, b) => Err(JqError::Msg(format!("{} and {} cannot be multiplied", json_type_name(&a), json_type_name(&b)))),
    }
}

pub fn jvalue_div(a: JValue, b: JValue) -> Result<JValue, JqError> {
    match (a, b) {
        (JValue::Number(x), JValue::Number(y)) => {
            if y == 0.0 { return Err(JqError::Msg("number divided by zero".to_string())); }
            Ok(JValue::Number(x / y))
        }
        (JValue::String(s), JValue::String(sep)) => {
            let parts: Vec<JValue> = s.split(sep.as_str()).map(|p| JValue::String(p.to_string())).collect();
            Ok(JValue::Array(parts))
        }
        (a, b) => Err(JqError::Msg(format!("{} and {} cannot be divided", json_type_name(&a), json_type_name(&b)))),
    }
}

pub fn jvalue_mod(a: JValue, b: JValue) -> Result<JValue, JqError> {
    match (a, b) {
        (JValue::Number(x), JValue::Number(y)) => {
            if y == 0.0 { return Err(JqError::Msg("number divided by zero (remainder)".to_string())); }
            Ok(JValue::Number(x % y))
        }
        (a, b) => Err(JqError::Msg(format!("{} and {} cannot be divided (remainder)", json_type_name(&a), json_type_name(&b)))),
    }
}

pub fn jvalue_index(v: &JValue, idx: &JValue) -> Result<JValue, JqError> {
    match (v, idx) {
        (JValue::Object(obj), JValue::String(k)) => {
            Ok(obj.iter().find(|(ck, _)| ck == k).map(|(_, v)| v.clone()).unwrap_or(JValue::Null))
        }
        (JValue::Array(arr), JValue::Number(n)) => {
            let i = normalize_index(*n as i64, arr.len());
            Ok(arr.get(i).cloned().unwrap_or(JValue::Null))
        }
        (JValue::Null, _) => Ok(JValue::Null),
        (v, idx) => Err(JqError::Msg(format!("cannot index {} with {}", json_type_name(v), json_type_name(idx)))),
    }
}

fn jvalue_slice(v: &JValue, from: &JValue, to: &JValue) -> Result<JValue, JqError> {
    fn to_idx(n: &JValue, len: usize) -> i64 {
        match n {
            JValue::Number(n) => {
                let i = *n as i64;
                if i < 0 { (len as i64 + i).max(0) } else { i.min(len as i64) }
            }
            JValue::Null => 0,
            _ => 0,
        }
    }
    match v {
        JValue::Array(arr) => {
            let len = arr.len();
            let f = to_idx(from, len) as usize;
            let t = match to { JValue::Null => len, _ => to_idx(to, len) as usize };
            let f = f.min(len);
            let t = t.min(len).max(f);
            Ok(JValue::Array(arr[f..t].to_vec()))
        }
        JValue::String(s) => {
            let chars: Vec<char> = s.chars().collect();
            let len = chars.len();
            let f = to_idx(from, len) as usize;
            let t = match to { JValue::Null => len, _ => to_idx(to, len) as usize };
            let f = f.min(len);
            let t = t.min(len).max(f);
            Ok(JValue::String(chars[f..t].iter().collect()))
        }
        JValue::Null => Ok(JValue::Null),
        _ => Err(JqError::Msg(format!("cannot slice {}", json_type_name(v)))),
    }
}

pub fn jvalue_cmp(a: &JValue, b: &JValue) -> i32 {
    fn type_order(v: &JValue) -> i32 {
        match v {
            JValue::Null => 0,
            JValue::Bool(false) => 1,
            JValue::Bool(true) => 2,
            JValue::Number(_) => 3,
            JValue::String(_) => 4,
            JValue::Array(_) => 5,
            JValue::Object(_) => 6,
        }
    }
    let ta = type_order(a);
    let tb = type_order(b);
    if ta != tb { return ta.cmp(&tb) as i32; }
    match (a, b) {
        (JValue::Number(x), JValue::Number(y)) => x.partial_cmp(y).map(|o| o as i32).unwrap_or(0),
        (JValue::String(x), JValue::String(y)) => x.cmp(y) as i32,
        (JValue::Array(x), JValue::Array(y)) => {
            for (a, b) in x.iter().zip(y.iter()) {
                let c = jvalue_cmp(a, b);
                if c != 0 { return c; }
            }
            x.len().cmp(&y.len()) as i32
        }
        (JValue::Object(x), JValue::Object(y)) => {
            let mut xk: Vec<&str> = x.iter().map(|(k, _)| k.as_str()).collect();
            let mut yk: Vec<&str> = y.iter().map(|(k, _)| k.as_str()).collect();
            xk.sort();
            yk.sort();
            let kc = xk.iter().zip(yk.iter()).find(|(a, b)| a != b)
                .map(|(a, b)| a.cmp(b) as i32).unwrap_or(0);
            if kc != 0 { return kc; }
            0
        }
        _ => 0,
    }
}

pub fn normalize_index(i: i64, len: usize) -> usize {
    if i < 0 {
        let j = len as i64 + i;
        if j < 0 { 0 } else { j as usize }
    } else {
        i as usize
    }
}

pub fn is_truthy(v: &JValue) -> bool {
    !matches!(v, JValue::Null | JValue::Bool(false))
}

pub fn collect_recurse(v: &JValue, out: &mut Vec<JValue>) {
    out.push(v.clone());
    match v {
        JValue::Array(arr) => { for x in arr { collect_recurse(x, out); } }
        JValue::Object(obj) => { for (_, x) in obj { collect_recurse(x, out); } }
        _ => {}
    }
}

pub fn write_stderr(s: &str) {
    use std::io::Write;
    let mut err = std::io::stderr();
    err.write_all(s.as_bytes()).ok();
    err.flush().ok();
}

use crate::brace::expand_braces;
use crate::executor::expansion::{
    expand_tilde, has_glob_ext, glob_match_ext, glob_replace_first, glob_replace_all,
    remove_shortest_prefix, remove_longest_prefix, remove_shortest_suffix, remove_longest_suffix,
    shell_substring, split_var_and_op, parse_array_subscript,
};
use crate::parser::{List, ListItem, ListOp, Parser, Word, WordPart};
use crate::runtime::{InputHandle, Runtime};
use crate::shell::Shell;
use crate::value::ShellValue;

impl<R: Runtime> Shell<R> {
    pub(crate) fn expand_word(&mut self, word: &Word) -> String {
        let parts: Vec<_> = word.parts().to_vec();
        parts.iter().map(|p| self.expand_part(p)).collect()
    }

    pub(crate) fn try_expand_word(&mut self, word: &Word) -> Result<String, u8> {
        self.expansion_error = false;
        let result = self.expand_word(word);
        if self.expansion_error { Err(self.last_exit) } else { Ok(result) }
    }

    pub(crate) fn try_expand_words_to_args(&mut self, words: &[Word]) -> Result<Vec<String>, u8> {
        self.expansion_error = false;
        let result: Vec<String> = words.iter()
            .flat_map(|w| self.expand_word_to_args(w))
            .collect();
        if self.expansion_error { Err(self.last_exit) } else { Ok(result) }
    }

    pub(crate) fn expand_word_to_args(&mut self, w: &Word) -> Vec<String> {
        // Special case: a word that is just ${arr[@]}, ${arr[*]}, $@, or $* should expand
        // to multiple words rather than a single space-joined string.
        if let Some(elements) = self.try_expand_array_all(w) {
            return elements;
        }

        let expanded = self.expand_word(w);
        let extglob = self.options.extglob;
        // Only apply brace expansion when the word has unquoted parts containing braces.
        let has_unquoted_braces = w.parts().iter().any(|p| {
            matches!(p, WordPart::Literal(s) if s.contains('{') || s.contains('}'))
        });
        // Only apply glob expansion when the word has unquoted parts containing glob chars.
        let has_unquoted_globs = w.parts().iter().any(|p| {
            matches!(p, WordPart::Literal(s) if has_glob_ext(s, extglob))
        });

        let brace_results = if has_unquoted_braces && !self.options.posix {
            expand_braces(&expanded)
        } else {
            vec![expanded]
        };
        brace_results.into_iter().flat_map(|s| {
            if has_unquoted_globs && has_glob_ext(&s, extglob) { self.expand_glob(&s) } else { vec![s] }
        }).collect()
    }

    /// If the word is a standalone `${arr[@]}`, `${arr[*]}`, `$@`, or `$*`, return elements.
    /// `$@` / `${arr[@]}` → each element as a separate word.
    /// `$*` / `${arr[*]}` → all elements joined by IFS[0] (default space) as one word.
    fn try_expand_array_all(&self, w: &Word) -> Option<Vec<String>> {
        let parts = w.parts();
        if parts.len() != 1 {
            return None;
        }

        let ifs_sep = self.env.get("IFS")
            .map(|v| v.as_scalar().chars().next().unwrap_or(' '))
            .unwrap_or(' ');

        match &parts[0] {
            WordPart::BraceVar(raw) => {
                // ${!name[@]} is indirect/key-list expansion, not array-all; skip it here
                if raw.starts_with('!') {
                    return None;
                }
                let (name, subscript) = parse_array_subscript(raw)?;
                if subscript != "@" && subscript != "*" {
                    return None;
                }
                if let Some(special_elements) = self.get_special_array_elements(name) {
                    if subscript == "*" {
                        let joined: String = special_elements.join(&ifs_sep.to_string());
                        return Some(vec![joined]);
                    } else {
                        return Some(special_elements);
                    }
                }
                let elements = match self.env.get(name) {
                    Some(ShellValue::Array(elements)) => elements.clone(),
                    Some(ShellValue::Scalar(s)) => vec![s.clone()],
                    Some(ShellValue::AssocArray(map)) => map.values().cloned().collect(),
                    None => return Some(Vec::new()),
                };
                if subscript == "*" {
                    let joined: String = elements.join(&ifs_sep.to_string());
                    Some(vec![joined])
                } else {
                    Some(elements)
                }
            }
            WordPart::Var(name) if name == "@" || name == "*" => {
                let all = self.params.all();
                if all.is_empty() {
                    Some(Vec::new())
                } else if name == "*" {
                    let joined = all.join(&ifs_sep.to_string());
                    Some(vec![joined])
                } else {
                    Some(all.to_vec())
                }
            }
            _ => None,
        }
    }

    pub(crate) fn expand_part(&mut self, part: &WordPart) -> String {
        match part {
            WordPart::Literal(s) => {
                let home = self.env.get("HOME").map(|v| v.as_scalar()).unwrap_or("/");
                expand_tilde(s, home)
            }
            WordPart::Quoted(s) => s.clone(),
            WordPart::Var(name) => self.expand_var(name, true),
            WordPart::BraceVar(raw) => self.expand_brace_var(raw),
            WordPart::CmdSub(raw) => self.exec_capturing(raw),
            WordPart::ArithSub(expr) => self.eval_arithmetic(expr),
            WordPart::ProcSubIn(raw) => self.exec_proc_sub_in(raw),
            WordPart::ProcSubOut(raw) => self.exec_proc_sub_out(raw),
        }
    }

    pub(crate) fn expand_var(&mut self, name: &str, check_nounset: bool) -> String {
        match name {
            "?" => self.last_exit.to_string(),
            "#" => self.params.count().to_string(),
            "@" => self.params.all().join(" "),
            "*" => {
                let ifs_sep = self.env.get("IFS")
                    .map(|v| v.as_scalar().chars().next().unwrap_or(' '))
                    .unwrap_or(' ');
                self.params.all().join(&ifs_sep.to_string())
            }
            "!" => self.env.get("!").map(|v| v.as_scalar().to_string()).unwrap_or_default(),
            "$" => {
                // $$ expands to the shell's PID. In WASM there is no real PID; use 1.
                "1".to_string()
            }
            "BASHPID" => {
                // $BASHPID expands to the current process PID (same as $$ for non-subshells).
                "1".to_string()
            }
            "SHLVL" => {
                if self.shlvl == 0 {
                    String::new()
                } else {
                    self.shlvl.to_string()
                }
            }
            "BASH_VERSION" => crate::config::bash_version_string(),
            "BASH_VERSINFO" => {
                // Bare $BASH_VERSINFO returns element [0] (major version)
                crate::config::bash_versinfo_elements()[0].clone()
            }
            "RANDOM" => {
                // Simple LCG pseudo-random number generator (16-bit, 0..32767)
                self.random_state = self.random_state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((self.random_state >> 33) % 32768).to_string()
            }
            "LINENO" => self.current_line.to_string(),
            "SECONDS" => {
                let elapsed = self.start_time.elapsed().as_secs() as i64;
                let val = elapsed + self.seconds_offset;
                val.max(0).to_string()
            }
            "FUNCNAME" => {
                if let Some(frame) = self.call_stack.last() {
                    frame.function_name.clone()
                } else {
                    "main".to_string()
                }
            }
            "BASH_SOURCE" => {
                if let Some(frame) = self.call_stack.last() {
                    frame.source_file.clone()
                } else {
                    self.current_source_file.clone()
                }
            }
            "BASH_LINENO" => {
                if let Some(frame) = self.call_stack.last() {
                    frame.call_line.to_string()
                } else {
                    "0".to_string()
                }
            }
            "-" => {
                let mut flags = String::new();
                if self.is_interactive { flags.push('i'); }
                if self.options.errexit { flags.push('e'); }
                if self.options.nounset { flags.push('u'); }
                if self.options.xtrace { flags.push('x'); }
                if self.options.verbose { flags.push('v'); }
                if self.options.noclobber { flags.push('C'); }
                flags.push('s');
                flags
            }
            "SHELLOPTS" => {
                self.options.enabled_set_o_options().join(":")
            }
            "BASHOPTS" => {
                self.options.enabled_shopt_options().join(":")
            }
            _ => {
                if name == "0" {
                    return self.env.get("0").map(|v| v.as_scalar().to_string())
                        .unwrap_or_else(|| self.shell_name.clone());
                }
                if let Ok(n) = name.parse::<usize>() {
                    return self.params.get(n).unwrap_or("").to_string();
                }
                if check_nounset && self.options.nounset && !self.env.contains_key(name) {
                    self.rt.write_stderr(&format!("{}: {}: unbound variable\n", self.shell_name, name));
                    self.last_exit = 1;
                    self.exit_requested = true;
                    return String::new();
                }
                self.env.get(name).map(|v| v.as_scalar().to_string()).unwrap_or_default()
            }
        }
    }

    pub(crate) fn expand_brace_var(&mut self, raw: &str) -> String {
        // ${!name[@]} or ${!name[*]} — list keys of array/assoc array
        if let Some(inner) = raw.strip_prefix('!') {
            if let Some((arr_name, subscript)) = parse_array_subscript(inner) {
                if subscript == "@" || subscript == "*" {
                    // Check special arrays first (BASH_VERSINFO, FUNCNAME, etc.)
                    if let Some(elements) = self.get_special_array_elements(arr_name) {
                        let indices: Vec<String> = (0..elements.len()).map(|i| i.to_string()).collect();
                        return indices.join(" ");
                    }
                    return match self.env.get(arr_name) {
                        Some(v) => v.assoc_keys().join(" "),
                        None => String::new(),
                    };
                }
            }
            // ${!prefix*} or ${!prefix@} — list variable names matching prefix
            if let Some(prefix) = inner.strip_suffix('*').or_else(|| inner.strip_suffix('@')) {
                let mut names: Vec<&String> = self.env.keys()
                    .filter(|k| k.starts_with(prefix))
                    .collect();
                names.sort();
                return names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ");
            }
            // ${!VAR} — indirect expansion (expand the value of $VAR as a variable name)
            let var_val = self.expand_var(inner, false);
            if !var_val.is_empty() {
                // If the indirect value contains '[', treat as array reference
                if let Some((arr_name, subscript)) = parse_array_subscript(&var_val) {
                    return match self.env.get(arr_name) {
                        Some(v) => {
                            if subscript == "@" || subscript == "*" {
                                v.all_elements()
                            } else if let Ok(idx) = subscript.parse::<i64>() {
                                match v {
                                    ShellValue::AssocArray(_) => v.assoc_get(subscript).to_string(),
                                    _ => {
                                        let actual_idx = if idx < 0 {
                                            (v.len() as i64 + idx).max(0) as usize
                                        } else {
                                            idx as usize
                                        };
                                        v.index(actual_idx).to_string()
                                    }
                                }
                            } else {
                                v.assoc_get(subscript).to_string()
                            }
                        }
                        None => String::new(),
                    };
                }
                return self.expand_var(&var_val, false);
            }
            return String::new();
        }

        // ${#arr[@]} or ${#arr[*]} — array length
        if let Some(inner) = raw.strip_prefix('#') {
            if let Some((arr_name, subscript)) = parse_array_subscript(inner) {
                if subscript == "@" || subscript == "*" {
                    if let Some(len) = self.special_array_len(arr_name) {
                        return len.to_string();
                    }
                    return match self.env.get(arr_name) {
                        Some(v) => v.len().to_string(),
                        None => "0".to_string(),
                    };
                }
                // ${#arr[n]} — length of element at index (supports negative indices)
                if let Ok(idx) = subscript.parse::<i64>() {
                    // Check special arrays first
                    if let Some(elements) = self.get_special_array_elements(arr_name) {
                        let actual_idx = if idx < 0 {
                            (elements.len() as i64 + idx).max(0) as usize
                        } else {
                            idx as usize
                        };
                        return elements.get(actual_idx).map(|s| s.len()).unwrap_or(0).to_string();
                    }
                    return match self.env.get(arr_name) {
                        Some(v) => {
                            let actual_idx = if idx < 0 {
                                (v.len() as i64 + idx).max(0) as usize
                            } else {
                                idx as usize
                            };
                            v.index(actual_idx).len().to_string()
                        }
                        None => "0".to_string(),
                    };
                }
                // ${#arr[key]} — length of element for assoc array key
                return match self.env.get(arr_name) {
                    Some(v) => v.assoc_get(subscript).len().to_string(),
                    None => "0".to_string(),
                };
            }
            // ${#VAR} — length of scalar variable
            return self.expand_var(inner, true).len().to_string();
        }

        // Dynamic special arrays: FUNCNAME, BASH_SOURCE, BASH_LINENO
        if let Some((arr_name, subscript)) = parse_array_subscript(raw) {
            if let Some(result) = self.expand_special_array(arr_name, subscript) {
                return result;
            }
        }

        // ${arr[@]} or ${arr[*]} — all elements space-joined
        // ${arr[n]} — single element at index n
        // ${arr[key]} — assoc array element by key
        if let Some((arr_name, subscript)) = parse_array_subscript(raw) {
            return match self.env.get(arr_name) {
                Some(v) => {
                    if subscript == "@" || subscript == "*" {
                        v.all_elements()
                    } else if let Ok(idx) = subscript.parse::<i64>() {
                        match v {
                            ShellValue::AssocArray(_) => v.assoc_get(subscript).to_string(),
                            _ => {
                                let actual_idx = if idx < 0 {
                                    (v.len() as i64 + idx).max(0) as usize
                                } else {
                                    idx as usize
                                };
                                v.index(actual_idx).to_string()
                            }
                        }
                    } else {
                        // Non-numeric subscript: try assoc array lookup
                        v.assoc_get(subscript).to_string()
                    }
                }
                None => String::new(),
            };
        }

        // Split into variable name and operator+pattern
        let (var_name, op_and_rest) = split_var_and_op(raw);

        // ${VAR//pat/rep} — replace all occurrences (glob-based)
        if let Some(pat_rep) = op_and_rest.strip_prefix("//") {
            let val = self.expand_var(var_name, true);
            let (pat, rep) = pat_rep.split_once('/').unwrap_or((pat_rep, ""));
            return glob_replace_all(&val, pat, rep, self.options.extglob);
        }

        // ${VAR/pat/rep} — replace first occurrence (glob-based)
        if let Some(pat_rep) = op_and_rest.strip_prefix('/') {
            let val = self.expand_var(var_name, true);
            let (pat, rep) = pat_rep.split_once('/').unwrap_or((pat_rep, ""));
            return glob_replace_first(&val, pat, rep, self.options.extglob);
        }

        // ${VAR##pat} — remove longest matching prefix (check before single #)
        if let Some(pat) = op_and_rest.strip_prefix("##") {
            let val = self.expand_var(var_name, true);
            return remove_longest_prefix(&val, pat, self.options.extglob);
        }

        // ${VAR#pat} — remove shortest matching prefix
        if let Some(pat) = op_and_rest.strip_prefix('#') {
            let val = self.expand_var(var_name, true);
            return remove_shortest_prefix(&val, pat, self.options.extglob);
        }

        // ${VAR%%pat} — remove longest matching suffix (check before single %)
        if let Some(pat) = op_and_rest.strip_prefix("%%") {
            let val = self.expand_var(var_name, true);
            return remove_longest_suffix(&val, pat, self.options.extglob);
        }

        // ${VAR%pat} — remove shortest matching suffix
        if let Some(pat) = op_and_rest.strip_prefix('%') {
            let val = self.expand_var(var_name, true);
            return remove_shortest_suffix(&val, pat, self.options.extglob);
        }

        // ${VAR^^} — convert entire value to uppercase (check ^^ before ^)
        if op_and_rest.starts_with("^^") {
            let val = self.expand_var(var_name, true);
            return val.to_uppercase();
        }

        // ${VAR^} — capitalize first character only
        if op_and_rest.starts_with('^') {
            let val = self.expand_var(var_name, true);
            let mut chars = val.chars();
            return match chars.next() {
                Some(c) => format!("{}{}", c.to_uppercase().collect::<String>(), chars.as_str()),
                None => String::new(),
            };
        }

        // ${VAR,,} — convert entire value to lowercase (check ,, before ,)
        if op_and_rest.starts_with(",,") {
            let val = self.expand_var(var_name, true);
            return val.to_lowercase();
        }

        // ${VAR,} — lowercase first character only
        if op_and_rest.starts_with(',') {
            let val = self.expand_var(var_name, true);
            let mut chars = val.chars();
            return match chars.next() {
                Some(c) => format!("{}{}", c.to_lowercase().collect::<String>(), chars.as_str()),
                None => String::new(),
            };
        }

        // ${VAR:...} — substring or default/alternate
        if let Some(colon_rest) = op_and_rest.strip_prefix(':') {
            // ${VAR:-default} — default if empty (nounset should NOT fire here)
            if let Some(default) = colon_rest.strip_prefix('-') {
                let val = self.expand_var(var_name, false);
                return if val.is_empty() { default.to_string() } else { val };
            }
            // ${VAR:+alt} — alternate if not empty (nounset should NOT fire here)
            if let Some(alt) = colon_rest.strip_prefix('+') {
                let val = self.expand_var(var_name, false);
                return if val.is_empty() { String::new() } else { alt.to_string() };
            }
            // ${VAR:offset} or ${VAR:offset:length} — substring (digit or minus sign)
            if colon_rest.starts_with(|c: char| c.is_ascii_digit() || c == '-') {
                let val = self.expand_var(var_name, true);
                return shell_substring(&val, colon_rest);
            }
        }

        // Plain ${VAR} — but use raw if var_name is empty (shouldn't happen) or op is empty
        if op_and_rest.is_empty() {
            self.expand_var(var_name, true)
        } else {
            self.expand_var(raw, true)
        }
    }

    pub(crate) fn expand_arith_vars(&self, expr: &str) -> String {
        let mut result = String::new();
        let chars: Vec<char> = expr.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '$' {
                i += 1;
                if i < chars.len() && chars[i] == '{' {
                    i += 1;
                    let start = i;
                    while i < chars.len() && chars[i] != '}' { i += 1; }
                    let name: String = chars[start..i].iter().collect();
                    result.push_str(self.env.get(&name).map(|v| v.as_scalar()).unwrap_or("0"));
                    if i < chars.len() { i += 1; }
                } else if i < chars.len() && (chars[i].is_alphabetic() || chars[i] == '_') {
                    let start = i;
                    while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') { i += 1; }
                    let name: String = chars[start..i].iter().collect();
                    result.push_str(self.env.get(&name).map(|v| v.as_scalar()).unwrap_or("0"));
                } else {
                    result.push('$');
                }
            } else {
                result.push(chars[i]);
                i += 1;
            }
        }
        result
    }

    pub(crate) fn eval_arithmetic(&mut self, expr: &str) -> String {
        use std::cell::RefCell;

        let expanded_expr = self.expand_arith_vars(expr);

        let working: RefCell<std::collections::HashMap<String, i64>> = RefCell::new(
            self.env.iter()
                .map(|(k, v)| (k.clone(), v.as_scalar().parse::<i64>().unwrap_or(0)))
                .collect()
        );
        // Track every variable that was explicitly assigned so we always write it back,
        // even if its new value equals the default 0 (e.g. `i=0` on an unset variable).
        let assigned: RefCell<std::collections::HashSet<String>> = RefCell::new(
            std::collections::HashSet::new()
        );

        let lookup = |name: &str| -> i64 { *working.borrow().get(name).unwrap_or(&0) };
        let mut assign = |name: &str, val: i64| {
            working.borrow_mut().insert(name.to_string(), val);
            assigned.borrow_mut().insert(name.to_string());
        };
        let arith_result = crate::arith::eval(&expanded_expr, &lookup, &mut assign);

        let assigned_set = assigned.into_inner();
        for (k, v) in working.into_inner() {
            let orig = self.env.get(&k)
                .map(|sv| sv.as_scalar().parse::<i64>().unwrap_or(0))
                .unwrap_or(0);
            if v != orig || assigned_set.contains(&k) {
                self.env.insert(k, ShellValue::Scalar(v.to_string()));
            }
        }

        match arith_result {
            Ok(val) => val.to_string(),
            Err(msg) => {
                self.rt.write_stderr(&format!("{}: {}\n", self.shell_name, msg));
                self.last_exit = 1;
                self.expansion_error = true;
                String::new()
            }
        }
    }

    pub(crate) fn expand_glob(&self, pattern: &str) -> Vec<String> {
        let extglob = self.options.extglob;
        let globstar = self.options.globstar;

        // Check for globstar (**) in path
        if globstar && pattern.contains("**") {
            let result = self.expand_globstar(pattern);
            if !result.is_empty() {
                return result;
            }
            return vec![pattern.to_string()];
        }

        let (dir_part, name_pat) = match pattern.rfind('/') {
            Some(pos) => (&pattern[..pos], &pattern[pos + 1..]),
            None => ("", pattern),
        };

        let dir_path = if dir_part.is_empty() {
            self.cwd.clone()
        } else {
            self.resolve_path(dir_part)
        };

        let entries = self.rt.read_directory(&dir_path);
        if entries.is_empty() {
            return vec![pattern.to_string()];
        }

        let mut matches: Vec<String> = entries
            .into_iter()
            .filter(|name| {
                !name.starts_with('.') || name_pat.starts_with('.')
            })
            .filter(|name| glob_match_ext(name_pat, name, extglob))
            .map(|name| {
                if dir_part.is_empty() {
                    name
                } else {
                    format!("{}/{}", dir_part, name)
                }
            })
            .collect();

        if matches.is_empty() {
            vec![pattern.to_string()]
        } else {
            matches.sort();
            matches
        }
    }

    fn expand_globstar(&self, pattern: &str) -> Vec<String> {
        let extglob = self.options.extglob;

        // Split pattern on the first "**" occurrence
        let parts: Vec<&str> = pattern.splitn(2, "**").collect();
        if parts.len() != 2 { return Vec::new(); }

        let prefix = parts[0]; // e.g., "" or "dir/"
        let suffix = parts[1]; // e.g., "/*.rs" or "/subdir" or ""

        // Resolve the base directory
        let base_dir = if prefix.is_empty() || prefix == "./" {
            self.cwd.clone()
        } else {
            let trimmed = prefix.trim_end_matches('/');
            if trimmed.is_empty() { "/".to_string() } else { self.resolve_path(trimmed) }
        };

        let display_prefix = if prefix.is_empty() || prefix == "./" {
            String::new()
        } else {
            prefix.to_string()
        };

        // Remove the leading "/" from suffix pattern if present
        let suffix_pat = suffix.strip_prefix('/').unwrap_or(suffix);

        // Recursively walk directories and collect all relative paths
        let mut all_paths: Vec<String> = Vec::new();
        self.walk_directory_recursive(&base_dir, "", &mut all_paths);

        let mut matches: Vec<String> = Vec::new();

        for path in &all_paths {
            // Match suffix pattern against each discovered path
            let matched = if suffix_pat.is_empty() {
                true
            } else {
                glob_match_ext(suffix_pat, path, extglob)
            };
            if matched {
                let full = if display_prefix.is_empty() {
                    path.clone()
                } else {
                    format!("{}{}", display_prefix, path)
                };
                // Skip dotfiles at each level unless pattern starts with dot
                if !path.split('/').any(|seg| !seg.is_empty() && seg.starts_with('.') && !suffix_pat.starts_with('.')) {
                    matches.push(full);
                }
            }
        }

        // Also try matching the suffix directly in the base dir (** can match zero dirs)
        if !suffix_pat.is_empty() {
            let entries = self.rt.read_directory(&base_dir);
            for name in entries {
                if name.starts_with('.') && !suffix_pat.starts_with('.') { continue; }
                if glob_match_ext(suffix_pat, &name, extglob) {
                    let full = if display_prefix.is_empty() {
                        name
                    } else {
                        format!("{}{}", display_prefix, name)
                    };
                    if !matches.contains(&full) {
                        matches.push(full);
                    }
                }
            }
        }

        matches.sort();
        matches
    }

    fn walk_directory_recursive(&self, base: &str, relative: &str, results: &mut Vec<String>) {
        use crate::runtime::FileType;

        let dir_path = if relative.is_empty() {
            base.to_string()
        } else {
            format!("{}/{}", base, relative)
        };

        let entries = self.rt.read_directory(&dir_path);
        for name in entries {
            if name.starts_with('.') { continue; }
            let rel_path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", relative, name)
            };
            results.push(rel_path.clone());

            let full_path = format!("{}/{}", base, rel_path);
            if self.rt.file_type(&full_path) == FileType::Directory {
                self.walk_directory_recursive(base, &rel_path, results);
            }
        }
    }

    pub(crate) fn exec_capturing(&mut self, raw: &str) -> String {
        let (inp, out) = self.rt.create_pipe();
        let mut parser = Parser::new_with_options(raw, self.options.posix, self.options.extglob);
        if let Some(list) = parser.parse() {
            self.exec_list_with_stdout(list, out);
        } else {
            self.rt.pipe_close_write(out);
        }
        let bytes = self.rt.pipe_read_all(inp);
        let s = String::from_utf8_lossy(&bytes).into_owned();
        s.trim_end_matches('\n').to_string()
    }

    pub(crate) fn exec_proc_sub_in(&mut self, raw: &str) -> String {
        let output = self.exec_capturing(raw);
        let tmp_path = format!("/tmp/.procsub_{}", self.next_id());
        self.rt.mkdir("/tmp");
        let mut data = output.into_bytes();
        data.push(b'\n');
        self.rt.write_file(&tmp_path, &data);
        self.procsub_paths.push(tmp_path.clone());
        tmp_path
    }

    pub(crate) fn exec_proc_sub_out(&mut self, raw: &str) -> String {
        let tmp_path = format!("/tmp/.procsub_{}", self.next_id());
        self.rt.mkdir("/tmp");
        self.rt.write_file(&tmp_path, &[]);
        self.procsub_out_pending.push((tmp_path.clone(), raw.to_string()));
        self.procsub_paths.push(tmp_path.clone());
        tmp_path
    }

    pub(crate) fn next_id(&mut self) -> u64 {
        self.procsub_counter += 1;
        self.procsub_counter
    }

    pub(crate) fn cleanup_procsub_files(&self) {
        for path in &self.procsub_paths {
            self.rt.unlink(path);
        }
    }

    pub(crate) fn flush_procsub_out(&mut self) {
        let pending: Vec<_> = self.procsub_out_pending.drain(..).collect();
        for (path, raw) in pending {
            let data = self.rt.read_file(&path);
            if !data.is_empty() {
                let (inp, out) = self.rt.create_pipe();
                self.rt.pipe_write(&out, &data);
                self.rt.pipe_close_write(out);
                let mut parser = crate::parser::Parser::new_with_options(&raw, self.options.posix, self.options.extglob);
                if let Some(list) = parser.parse() {
                    self.exec_list_with_stdin(list, inp);
                }
            }
        }
    }

    fn get_special_array_elements(&self, name: &str) -> Option<Vec<String>> {
        match name {
            "FUNCNAME" => {
                let mut elements: Vec<String> = self.call_stack.iter().rev()
                    .map(|f| f.function_name.clone())
                    .collect();
                elements.push("main".to_string());
                Some(elements)
            }
            "BASH_SOURCE" => {
                let mut elements: Vec<String> = self.call_stack.iter().rev()
                    .map(|f| f.source_file.clone())
                    .collect();
                elements.push(self.current_source_file.clone());
                Some(elements)
            }
            "BASH_LINENO" => {
                let mut elements: Vec<String> = self.call_stack.iter().rev()
                    .map(|f| f.call_line.to_string())
                    .collect();
                elements.push("0".to_string());
                Some(elements)
            }
            "BASH_VERSINFO" => {
                Some(crate::config::bash_versinfo_elements())
            }
            _ => None,
        }
    }

    pub(crate) fn expand_special_array(&self, arr_name: &str, subscript: &str) -> Option<String> {
        let elements = self.get_special_array_elements(arr_name)?;
        if subscript == "@" || subscript == "*" {
            Some(elements.join(" "))
        } else if let Ok(idx) = subscript.parse::<usize>() {
            Some(elements.get(idx).cloned().unwrap_or_default())
        } else {
            Some(String::new())
        }
    }

    pub(crate) fn special_array_len(&self, arr_name: &str) -> Option<usize> {
        self.get_special_array_elements(arr_name).map(|e| e.len())
    }

    pub(crate) fn exec_list_with_stdin(&mut self, list: List, stdin: InputHandle) -> u8 {
        let mut exit = 0u8;
        let mut skip_next = false;
        let mut stdin_opt = Some(stdin);

        for ListItem { pipeline, op } in list.items {
            if !skip_next {
                if let Some(inp) = stdin_opt.take() {
                    let negate = pipeline.negate;
                    let cmds = pipeline.commands;
                    if cmds.len() == 1 {
                        let cmd = cmds.into_iter().next().unwrap();
                        exit = match cmd {
                            crate::parser::Command::Simple(sc) => {
                                self.dispatch_simple(sc, Some(inp), None, None)
                            }
                            other => self.exec_compound(other),
                        };
                        if negate {
                            exit = if exit == 0 { 1 } else { 0 };
                        }
                    } else {
                        // Multi-command pipeline: stdin cannot be threaded through;
                        // exec_pipeline handles negate internally.
                        exit = self.exec_pipeline(crate::parser::Pipeline { commands: cmds, negate, pipe_stderr: vec![] });
                    }
                } else {
                    exit = self.exec_pipeline(pipeline);
                }
                if self.exit_requested { break; }
            }
            skip_next = match op {
                Some(ListOp::And) => exit != 0,
                Some(ListOp::Or) => exit == 0,
                _ => false,
            };
        }
        exit
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use crate::runtime_test::TestRuntime;
    use crate::shell::Shell;
    use crate::value::ShellValue;

    fn make_shell(env: HashMap<String, ShellValue>) -> Shell<TestRuntime> {
        let rt = TestRuntime::new();
        Shell::new(rt, env, "/".to_string(), false)
    }

    #[test]
    fn test_shlvl_default_is_1() {
        let mut shell = make_shell(HashMap::new());
        assert_eq!(shell.expand_var("SHLVL", true), "1");
    }

    #[test]
    fn test_shlvl_increments_from_env() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("3".to_string()));
        let mut shell = make_shell(env);
        assert_eq!(shell.expand_var("SHLVL", true), "4");
    }

    #[test]
    fn test_shlvl_invalid_value_resets_to_1() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("abc".to_string()));
        let mut shell = make_shell(env);
        assert_eq!(shell.expand_var("SHLVL", true), "1");
    }

    #[test]
    fn test_shlvl_zero_becomes_1() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("0".to_string()));
        let mut shell = make_shell(env);
        assert_eq!(shell.expand_var("SHLVL", true), "1");
    }

    #[test]
    fn test_shlvl_negative_becomes_1() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("-5".to_string()));
        let mut shell = make_shell(env);
        assert_eq!(shell.expand_var("SHLVL", true), "1");
    }

    #[test]
    fn test_bash_version_format() {
        let mut shell = make_shell(HashMap::new());
        assert_eq!(shell.expand_var("BASH_VERSION", true), crate::config::bash_version_string());
    }

    #[test]
    fn test_bash_versinfo_bare_is_major() {
        let mut shell = make_shell(HashMap::new());
        assert_eq!(shell.expand_var("BASH_VERSINFO", true), crate::config::VERSION_MAJOR);
    }

    #[test]
    fn test_bash_versinfo_length() {
        let shell = make_shell(HashMap::new());
        assert_eq!(shell.special_array_len("BASH_VERSINFO"), Some(6));
    }

    #[test]
    fn test_bash_versinfo_elements() {
        let shell = make_shell(HashMap::new());
        let elements = shell.get_special_array_elements("BASH_VERSINFO").unwrap();
        let expected = crate::config::bash_versinfo_elements();
        assert_eq!(elements, expected);
    }

    #[test]
    fn test_bash_versinfo_subscript() {
        let shell = make_shell(HashMap::new());
        assert_eq!(shell.expand_special_array("BASH_VERSINFO", "0"), Some(crate::config::VERSION_MAJOR.to_string()));
        assert_eq!(shell.expand_special_array("BASH_VERSINFO", "4"), Some(crate::config::VERSION_STATUS.to_string()));
        assert_eq!(shell.expand_special_array("BASH_VERSINFO", "5"), Some(crate::config::VERSION_MACHTYPE.to_string()));
    }

    #[test]
    fn test_bash_versinfo_at_expansion() {
        let shell = make_shell(HashMap::new());
        let result = shell.expand_special_array("BASH_VERSINFO", "@").unwrap();
        let expected = crate::config::bash_versinfo_elements().join(" ");
        assert_eq!(result, expected);
    }

    #[test]
    fn test_shlvl_in_env_for_children() {
        let shell = make_shell(HashMap::new());
        let env_val = shell.env.get("SHLVL").unwrap().as_scalar().to_string();
        assert_eq!(env_val, "1");
    }

    #[test]
    fn test_shlvl_in_env_incremented() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("5".to_string()));
        let shell = make_shell(env);
        let env_val = shell.env.get("SHLVL").unwrap().as_scalar().to_string();
        assert_eq!(env_val, "6");
    }

    #[test]
    fn test_bash_version_in_env() {
        let shell = make_shell(HashMap::new());
        let env_val = shell.env.get("BASH_VERSION").unwrap().as_scalar().to_string();
        assert_eq!(env_val, crate::config::bash_version_string());
    }

    #[test]
    fn test_shlvl_wraps_at_1000() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("999".to_string()));
        let mut shell = make_shell(env);
        assert_eq!(shell.expand_var("SHLVL", true), "1000");

        // At 1000, it wraps to 1
        let mut env2 = HashMap::new();
        env2.insert("SHLVL".to_string(), ShellValue::Scalar("1000".to_string()));
        let mut shell2 = make_shell(env2);
        assert_eq!(shell2.expand_var("SHLVL", true), "1");
    }

    #[test]
    fn test_shlvl_large_value_wraps() {
        let mut env = HashMap::new();
        env.insert("SHLVL".to_string(), ShellValue::Scalar("5000".to_string()));
        let mut shell = make_shell(env);
        assert_eq!(shell.expand_var("SHLVL", true), "1");
    }

    #[test]
    fn test_bash_versinfo_out_of_bounds() {
        let shell = make_shell(HashMap::new());
        assert_eq!(shell.expand_special_array("BASH_VERSINFO", "6"), Some(String::new()));
        assert_eq!(shell.expand_special_array("BASH_VERSINFO", "100"), Some(String::new()));
    }

    #[test]
    fn test_bash_versinfo_index_list() {
        let mut shell = make_shell(HashMap::new());
        let result = shell.expand_brace_var("!BASH_VERSINFO[@]");
        assert_eq!(result, "0 1 2 3 4 5");
    }
}

mod cat;
mod head;
mod tail;
mod wc;
mod grep;
mod seq;
mod sort;
mod uniq;
mod tr;
mod cut;
mod tee;
mod xargs;
mod sleep;
mod basename;
mod dirname;
mod mkdir;
mod rm;
mod cp;
mod mv;
mod ls;

pub fn dispatch(name: &str, args: &[&str]) -> u8 {
    match name {
        "cat" => cat::run(args),
        "head" => head::run(args),
        "tail" => tail::run(args),
        "wc" => wc::run(args),
        "grep" => grep::run(args),
        "seq" => seq::run(args),
        "sort" => sort::run(args),
        "uniq" => uniq::run(args),
        "tr" => tr::run(args),
        "cut" => cut::run(args),
        "tee" => tee::run(args),
        "xargs" => xargs::run(args),
        "sleep" => sleep::run(args),
        "basename" => basename::run(args),
        "dirname" => dirname::run(args),
        "mkdir" => mkdir::run(args),
        "rm" => rm::run(args),
        "cp" => cp::run(args),
        "mv" => mv::run(args),
        "ls" => ls::run(args),
        _ => {
            write_stderr(&format!("{}: command not found\n", name));
            127
        }
    }
}

pub fn write_stdout(s: &str) {
    use crate::bindings::wasi::cli::stdout::get_stdout;
    let out = get_stdout();
    out.blocking_write_and_flush(s.as_bytes()).ok();
}

pub fn write_stderr(s: &str) {
    use crate::bindings::wasi::cli::stderr::get_stderr;
    let err = get_stderr();
    err.blocking_write_and_flush(s.as_bytes()).ok();
}

pub fn read_stdin_all() -> Vec<u8> {
    use crate::bindings::wasi::cli::stdin::get_stdin;
    let inp = get_stdin();
    let mut buf = Vec::new();
    loop {
        match inp.blocking_read(65536) {
            Ok(chunk) if chunk.is_empty() => break,
            Ok(chunk) => buf.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }
    buf
}

pub fn read_file(path: &str) -> Option<Vec<u8>> {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        let flags = fs::PathFlags::SYMLINK_FOLLOW;
        let open_flags = fs::OpenFlags::empty();
        let desc_flags = fs::DescriptorFlags::READ;
        match descriptor.open_at(flags, path, open_flags, desc_flags) {
            Ok(file) => {
                let mut buf = Vec::new();
                let mut offset = 0u64;
                loop {
                    match file.read(65536, offset) {
                        Ok((chunk, _done)) if chunk.is_empty() => break,
                        Ok((chunk, done)) => {
                            offset += chunk.len() as u64;
                            buf.extend_from_slice(&chunk);
                            if done { break; }
                        }
                        Err(_) => break,
                    }
                }
                return Some(buf);
            }
            Err(_) => continue,
        }
    }
    None
}

pub fn write_file(path: &str, data: &[u8]) -> bool {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        let flags = fs::PathFlags::SYMLINK_FOLLOW;
        let open_flags = fs::OpenFlags::CREATE | fs::OpenFlags::TRUNCATE;
        let desc_flags = fs::DescriptorFlags::WRITE;
        match descriptor.open_at(flags, path, open_flags, desc_flags) {
            Ok(file) => {
                file.write(data, 0).ok();
                return true;
            }
            Err(_) => continue,
        }
    }
    false
}

pub fn append_file(path: &str, data: &[u8]) -> bool {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        let flags = fs::PathFlags::SYMLINK_FOLLOW;
        let open_flags = fs::OpenFlags::CREATE;
        let desc_flags = fs::DescriptorFlags::WRITE | fs::DescriptorFlags::MUTATE_DIRECTORY;
        // Try to open for append by reading existing and rewriting
        let open_flags_read = fs::OpenFlags::empty();
        let desc_flags_read = fs::DescriptorFlags::READ;
        let existing = match descriptor.open_at(flags, path, open_flags_read, desc_flags_read) {
            Ok(file) => {
                let mut buf = Vec::new();
                let mut offset = 0u64;
                loop {
                    match file.read(65536, offset) {
                        Ok((chunk, _done)) if chunk.is_empty() => break,
                        Ok((chunk, done)) => {
                            offset += chunk.len() as u64;
                            buf.extend_from_slice(&chunk);
                            if done { break; }
                        }
                        Err(_) => break,
                    }
                }
                buf
            }
            Err(_) => Vec::new(),
        };
        let _ = desc_flags;
        let _ = open_flags;
        let truncate_flags = fs::OpenFlags::CREATE | fs::OpenFlags::TRUNCATE;
        let write_flags = fs::DescriptorFlags::WRITE;
        match descriptor.open_at(flags, path, truncate_flags, write_flags) {
            Ok(file) => {
                let mut combined = existing;
                combined.extend_from_slice(data);
                file.write(&combined, 0).ok();
                return true;
            }
            Err(_) => continue,
        }
    }
    false
}

pub fn remove_file(path: &str) -> bool {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        if descriptor.unlink_file_at(path).is_ok() {
            return true;
        }
        // Try parent directory approach for paths with components
        if let Some(slash) = path.rfind('/') {
            let parent = &path[..slash];
            let name = &path[slash + 1..];
            let open_flags = fs::OpenFlags::DIRECTORY;
            let desc_flags = fs::DescriptorFlags::MUTATE_DIRECTORY;
            let p_flags = fs::PathFlags::empty();
            if let Ok(parent_dir) = descriptor.open_at(p_flags, parent, open_flags, desc_flags) {
                if parent_dir.unlink_file_at(name).is_ok() {
                    return true;
                }
            }
        }
    }
    false
}

pub fn remove_dir(path: &str) -> bool {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        if descriptor.remove_directory_at(path).is_ok() {
            return true;
        }
        if let Some(slash) = path.rfind('/') {
            let parent = &path[..slash];
            let name = &path[slash + 1..];
            let open_flags = fs::OpenFlags::DIRECTORY;
            let desc_flags = fs::DescriptorFlags::MUTATE_DIRECTORY;
            let p_flags = fs::PathFlags::empty();
            if let Ok(parent_dir) = descriptor.open_at(p_flags, parent, open_flags, desc_flags) {
                if parent_dir.remove_directory_at(name).is_ok() {
                    return true;
                }
            }
        }
    }
    false
}

pub fn create_dir(path: &str) -> bool {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        if descriptor.create_directory_at(path).is_ok() {
            return true;
        }
        if let Some(slash) = path.rfind('/') {
            let parent = &path[..slash];
            let name = &path[slash + 1..];
            let open_flags = fs::OpenFlags::DIRECTORY;
            let desc_flags = fs::DescriptorFlags::MUTATE_DIRECTORY;
            let p_flags = fs::PathFlags::empty();
            if let Ok(parent_dir) = descriptor.open_at(p_flags, parent, open_flags, desc_flags) {
                if parent_dir.create_directory_at(name).is_ok() {
                    return true;
                }
            }
        }
    }
    false
}

pub enum FileKind {
    Regular,
    Directory,
    Other,
    NotFound,
}

pub fn file_kind(path: &str) -> FileKind {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    for (descriptor, _mount) in &dirs {
        let flags = fs::PathFlags::SYMLINK_FOLLOW;
        if let Ok(stat) = descriptor.stat_at(flags, path) {
            return match stat.type_ {
                fs::DescriptorType::RegularFile => FileKind::Regular,
                fs::DescriptorType::Directory => FileKind::Directory,
                _ => FileKind::Other,
            };
        }
    }
    FileKind::NotFound
}

pub fn read_dir(path: &str) -> Vec<String> {
    use crate::bindings::wasi::filesystem::{preopens, types as fs};
    let dirs = preopens::get_directories();
    let mut entries = Vec::new();
    for (descriptor, _mount) in &dirs {
        let flags = fs::PathFlags::SYMLINK_FOLLOW;
        let open_flags = fs::OpenFlags::DIRECTORY;
        let desc_flags = fs::DescriptorFlags::READ;
        if let Ok(dir) = descriptor.open_at(flags, path, open_flags, desc_flags) {
            if let Ok(stream) = dir.read_directory() {
                loop {
                    match stream.read_directory_entry() {
                        Ok(Some(entry)) => entries.push(entry.name),
                        _ => break,
                    }
                }
            }
            return entries;
        }
    }
    entries
}

/// Read input: from file args if provided, otherwise from stdin.
/// Returns (data, error_count).
pub fn read_input(args: &[&str]) -> (Vec<u8>, u8) {
    if args.is_empty() {
        (read_stdin_all(), 0)
    } else {
        let mut out = Vec::new();
        let mut errors = 0u8;
        for &arg in args {
            match read_file(arg) {
                Some(data) => out.extend_from_slice(&data),
                None => {
                    write_stderr(&format!("{}: No such file or directory\n", arg));
                    errors = 1;
                }
            }
        }
        (out, errors)
    }
}

pub fn lines_of(data: &[u8]) -> Vec<&str> {
    let s = std::str::from_utf8(data).unwrap_or("");
    let mut lines: Vec<&str> = s.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

pub fn expand_char_set(set: &str) -> Vec<char> {
    let chars: Vec<char> = set.chars().collect();
    let mut result = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            let start = chars[i] as u32;
            let end = chars[i + 2] as u32;
            if start <= end {
                for c in start..=end {
                    if let Some(ch) = char::from_u32(c) {
                        result.push(ch);
                    }
                }
                i += 3;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

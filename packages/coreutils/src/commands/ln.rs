use super::{write_stderr, read_file, write_file, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut _symbolic = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-s" | "--symbolic" => _symbolic = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    if c == 's' { _symbolic = true; }
                }
            }
            _ => file_args.push(arg),
        }
    }

    if file_args.len() < 2 {
        write_stderr("ln: missing destination operand\n");
        return 1;
    }

    let target = file_args[file_args.len() - 2];
    let linkname_arg = file_args[file_args.len() - 1];
    let mut linkname = linkname_arg.to_string();

    // If linkname is a directory, place link inside it
    if matches!(file_kind(linkname_arg), FileKind::Directory) {
        let basename = std::path::Path::new(target)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        linkname = format!("{}/{}", linkname_arg.trim_end_matches('/'), basename);
    }

    // WASI P2 has limited symlink support — copy as fallback
    match read_file(target) {
        Some(data) => {
            if write_file(&linkname, &data) {
                0
            } else {
                write_stderr(&format!("ln: failed to create link '{}'\n", linkname));
                1
            }
        }
        None => {
            write_stderr(&format!("ln: failed to access '{}': No such file or directory\n", target));
            1
        }
    }
}

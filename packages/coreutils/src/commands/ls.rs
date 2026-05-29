use super::{write_stdout, write_stderr, file_kind, read_dir, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();

    let targets: Vec<&str> = if file_args.is_empty() {
        vec!["."]
    } else {
        file_args
    };

    let mut errors = 0u8;
    for &target in &targets {
        match file_kind(target) {
            FileKind::Regular | FileKind::Other => {
                let name = std::path::Path::new(target)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| target.to_string());
                write_stdout(&name);
                write_stdout("\n");
            }
            FileKind::Directory => {
                let mut entries = read_dir(target);
                entries.sort();
                for entry in &entries {
                    write_stdout(entry);
                    write_stdout("\n");
                }
            }
            FileKind::NotFound => {
                write_stderr(&format!("ls: cannot access '{}': No such file or directory\n", target));
                errors = 1;
            }
        }
    }
    errors
}

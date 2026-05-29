use super::{write_stderr, read_file, write_file, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
    if file_args.len() < 2 {
        write_stderr("cp: missing destination\n");
        return 1;
    }
    let src = file_args[file_args.len() - 2];
    let dst_arg = file_args[file_args.len() - 1];
    let mut dst = dst_arg.to_string();

    if matches!(file_kind(dst_arg), FileKind::Directory) {
        let basename = std::path::Path::new(src)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        dst = format!("{}/{}", dst_arg.trim_end_matches('/'), basename);
    }

    match read_file(src) {
        Some(data) => {
            write_file(&dst, &data);
            0
        }
        None => {
            write_stderr(&format!("cp: cannot stat '{}': No such file or directory\n", src));
            1
        }
    }
}

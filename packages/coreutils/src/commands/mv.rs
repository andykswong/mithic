use super::{write_stderr, read_file, write_file, remove_file, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
    if file_args.len() < 2 {
        write_stderr("mv: missing destination\n");
        return 1;
    }

    let dst_arg = file_args[file_args.len() - 1];
    let srcs = &file_args[..file_args.len() - 1];
    let dst_is_dir = matches!(file_kind(dst_arg), FileKind::Directory);

    if srcs.len() > 1 && !dst_is_dir {
        write_stderr("mv: target must be a directory when moving multiple files\n");
        return 1;
    }

    let mut errors = 0u8;
    for &src in srcs {
        let dst = if dst_is_dir {
            let basename = std::path::Path::new(src)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("{}/{}", dst_arg.trim_end_matches('/'), basename)
        } else {
            dst_arg.to_string()
        };

        match read_file(src) {
            Some(data) => {
                write_file(&dst, &data);
                remove_file(src);
            }
            None => {
                write_stderr(&format!("mv: cannot stat '{}': No such file or directory\n", src));
                errors = 1;
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    #[test]
    fn basename_extraction() {
        let src = "/tmp/foo/bar.txt";
        let basename = std::path::Path::new(src)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        assert_eq!(basename, "bar.txt");
    }

    #[test]
    fn destination_path_when_dir() {
        let dst_arg = "/tmp/dest";
        let src = "/tmp/src/file.txt";
        let basename = std::path::Path::new(src)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dst = format!("{}/{}", dst_arg.trim_end_matches('/'), basename);
        assert_eq!(dst, "/tmp/dest/file.txt");
    }
}

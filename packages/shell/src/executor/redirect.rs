#[cfg(not(test))]
use crate::shell::Shell;

#[cfg(not(test))]
impl Shell {
    /// Returns `true` on success, `false` if a redirect failed (command should not execute).
    pub(crate) fn apply_redirects(
        &mut self,
        redirects: &[crate::parser::Redirect],
        stdin: &mut Option<crate::bindings::mithic::process::types::InputStream>,
        stdout: &mut Option<crate::bindings::mithic::process::types::OutputStream>,
        stderr: &mut Option<crate::bindings::mithic::process::types::OutputStream>,
    ) -> bool {
        use crate::bindings::mithic::process::manager as proc_manager;
        use crate::bindings::wasi::filesystem::types::{DescriptorFlags, OpenFlags, PathFlags};
        use crate::parser::Redirect;
        use crate::io;
        use crate::shell::get_root_descriptor;

        let root = match get_root_descriptor() {
            Some(d) => d,
            None => return true,
        };

        for redirect in redirects {
            match redirect {
                Redirect::Out(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.write_via_stream(0) {
                            Ok(stream) => *stdout = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for writing\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::OutAppend(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.append_via_stream() {
                            Ok(stream) => *stdout = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for appending\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::In(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::empty(), DescriptorFlags::READ,
                    ) {
                        Ok(desc) => match desc.read_via_stream(0) {
                            Ok(stream) => *stdin = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for reading\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::Err(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.write_via_stream(0) {
                            Ok(stream) => *stderr = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for writing\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::ErrAppend(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.append_via_stream() {
                            Ok(stream) => *stderr = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for appending\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::ErrToOut => {
                    if let Some(out) = stdout.as_ref() {
                        *stderr = Some(proc_manager::dup_output_stream(out));
                    }
                }
                Redirect::Both(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.write_via_stream(0) {
                            Ok(stream) => {
                                let dup = proc_manager::dup_output_stream(&stream);
                                *stdout = Some(stream);
                                *stderr = Some(dup);
                            },
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for writing\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::HereString(w) => {
                    let content = self.expand_word(w);
                    let mut bytes = content.into_bytes();
                    bytes.push(b'\n');
                    let (inp, out) = proc_manager::create_pipe();
                    let _ = out.blocking_write_and_flush(&bytes);
                    drop(out);
                    *stdin = Some(inp);
                }
            }
        }
        true
    }
}

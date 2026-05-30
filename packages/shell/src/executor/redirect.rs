use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;

impl<R: Runtime> Shell<R> {
    /// Returns `true` on success, `false` if a redirect failed (command should not execute).
    pub(crate) fn apply_redirects(
        &mut self,
        redirects: &[crate::parser::Redirect],
        stdin: &mut Option<InputHandle>,
        stdout: &mut Option<OutputHandle>,
        stderr: &mut Option<OutputHandle>,
    ) -> bool {
        use crate::parser::Redirect;

        for redirect in redirects {
            match redirect {
                Redirect::Out(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    if self.options.noclobber && self.rt.file_exists(&path) {
                        self.rt.write_stderr(&format!("{}: {}: cannot overwrite existing file\n", self.shell_name, expanded));
                        return false;
                    }
                    match self.rt.open_file_write(&path, false) {
                        Some(h) => *stdout = Some(h),
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for writing\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::OutClobber(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    match self.rt.open_file_write(&path, false) {
                        Some(h) => *stdout = Some(h),
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for writing\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::OutAppend(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    match self.rt.open_file_write(&path, true) {
                        Some(h) => *stdout = Some(h),
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for appending\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::In(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    match self.rt.open_file_read(&path) {
                        Some(h) => *stdin = Some(h),
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: No such file or directory\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::Err(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    match self.rt.open_file_write(&path, false) {
                        Some(h) => *stderr = Some(h),
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for writing\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::ErrAppend(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    match self.rt.open_file_write(&path, true) {
                        Some(h) => *stderr = Some(h),
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for appending\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::ErrToOut => {
                    if let Some(out) = stdout.as_ref() {
                        let duped = self.rt.dup_output(out);
                        *stderr = Some(duped);
                    }
                }
                Redirect::Both(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    match self.rt.open_file_write(&path, false) {
                        Some(h) => {
                            let dup = self.rt.dup_output(&h);
                            *stdout = Some(h);
                            *stderr = Some(dup);
                        }
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for writing\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::HereString(w) => {
                    let content = self.expand_word(w);
                    let mut bytes = content.into_bytes();
                    bytes.push(b'\n');
                    let (inp, out) = self.rt.create_pipe();
                    self.rt.pipe_write(&out, &bytes);
                    self.rt.pipe_close_write(out);
                    *stdin = Some(inp);
                }
            }
        }
        true
    }
}

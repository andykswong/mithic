use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;

impl<R: Runtime> Shell<R> {
    /// Check if a path is a /dev/tcp or /dev/udp virtual path.
    /// Previously returned true to block network redirects; now returns false to
    /// let them fall through to normal VFS file operations (handled by NetworkDeviceFsProvider).
    pub(crate) fn is_network_redirect(&mut self, _path: &str) -> bool {
        false
    }

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
                    if self.is_network_redirect(&path) { return false; }
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
                    if self.is_network_redirect(&path) { return false; }
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
                    if self.is_network_redirect(&path) { return false; }
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
                    if self.is_network_redirect(&path) { return false; }
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
                    if self.is_network_redirect(&path) { return false; }
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
                    if self.is_network_redirect(&path) { return false; }
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
                    if self.is_network_redirect(&path) { return false; }
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
                Redirect::FdOut(fd, w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    if self.is_network_redirect(&path) { return false; }
                    match self.rt.open_file_write(&path, false) {
                        Some(h) => {
                            match *fd {
                                0 => {
                                    self.rt.write_stderr(&format!("{}: {}: fd 0 cannot be opened for writing\n", self.shell_name, expanded));
                                    return false;
                                }
                                1 => *stdout = Some(h),
                                2 => *stderr = Some(h),
                                _ => { self.extra_fds.insert(*fd, h); }
                            }
                        }
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for writing\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::FdOutAppend(fd, w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    if self.is_network_redirect(&path) { return false; }
                    match self.rt.open_file_write(&path, true) {
                        Some(h) => {
                            match *fd {
                                0 => {
                                    self.rt.write_stderr(&format!("{}: {}: fd 0 cannot be opened for appending\n", self.shell_name, expanded));
                                    return false;
                                }
                                1 => *stdout = Some(h),
                                2 => *stderr = Some(h),
                                _ => { self.extra_fds.insert(*fd, h); }
                            }
                        }
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for appending\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::FdDup(fd, target) => {
                    // Resolve the target fd: check extra_fds, then fd_aliases, then std fds
                    let resolved_target = if let Some(&alias) = self.fd_aliases.get(target) {
                        alias
                    } else {
                        *target
                    };

                    let duped = match resolved_target {
                        1 => {
                            if let Some(out) = stdout.as_ref() {
                                Some(self.rt.dup_output(out))
                            } else {
                                None
                            }
                        }
                        2 => {
                            if let Some(err) = stderr.as_ref() {
                                Some(self.rt.dup_output(err))
                            } else {
                                None
                            }
                        }
                        _ => {
                            if let Some(h) = self.extra_fds.get(&resolved_target) {
                                Some(self.rt.dup_output(h))
                            } else {
                                None
                            }
                        }
                    };
                    match duped {
                        Some(h) => {
                            match *fd {
                                1 => *stdout = Some(h),
                                2 => *stderr = Some(h),
                                _ => { self.extra_fds.insert(*fd, h); }
                            }
                        }
                        None => {
                            // For stdout(1) and stderr(2) resolved targets without explicit
                            // handles: the redirect means "use default stdout/stderr".
                            // For fd=1, leaving stdout as None means "use default stdout".
                            if resolved_target != 1 && resolved_target != 2 {
                                self.rt.write_stderr(&format!("{}: {}: Bad file descriptor\n", self.shell_name, target));
                                return false;
                            }
                            // If fd is 1 or 2, this is effectively a no-op (already default)
                            // If fd is > 2 and target resolves to stdout/stderr, store alias
                            if *fd > 2 {
                                self.fd_aliases.insert(*fd, resolved_target);
                            }
                        }
                    }
                }
                Redirect::FdIn(fd, w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    if self.is_network_redirect(&path) { return false; }
                    match self.rt.open_file_read(&path) {
                        Some(h) => {
                            if *fd == 0 {
                                *stdin = Some(h);
                            } else {
                                self.extra_input_fds.insert(*fd, h);
                            }
                        }
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: No such file or directory\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::FdReadWrite(fd, w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    if self.is_network_redirect(&path) { return false; }
                    match self.rt.open_file_write(&path, false) {
                        Some(wh) => {
                            self.extra_fds.insert(*fd, wh);
                        }
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for writing\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                    match self.rt.open_file_read(&path) {
                        Some(rh) => {
                            self.extra_input_fds.insert(*fd, rh);
                        }
                        None => {
                            self.rt.write_stderr(&format!("{}: {}: cannot open for reading\n", self.shell_name, expanded));
                            return false;
                        }
                    }
                }
                Redirect::FdClose(fd) => {
                    match *fd {
                        1 => { *stdout = None; }
                        2 => { *stderr = None; }
                        _ => {
                            self.extra_fds.remove(fd);
                            self.extra_input_fds.remove(fd);
                            self.fd_aliases.remove(fd);
                        }
                    }
                }
            }
        }
        true
    }

    /// Write data to a file descriptor by number. Used by builtins writing to >&N.
    #[allow(dead_code)]
    pub(crate) fn write_to_fd(&mut self, fd: u32, data: &[u8], stdout: &Option<OutputHandle>) {
        let resolved = if let Some(&alias) = self.fd_aliases.get(&fd) { alias } else { fd };
        match resolved {
            1 => {
                if let Some(out) = stdout {
                    self.rt.pipe_write(out, data);
                } else {
                    self.rt.write_stdout(&String::from_utf8_lossy(data));
                }
            }
            2 => {
                self.rt.write_stderr(&String::from_utf8_lossy(data));
            }
            _ => {
                if let Some(h) = self.extra_fds.get(&resolved) {
                    self.rt.pipe_write(h, data);
                }
            }
        }
    }
}

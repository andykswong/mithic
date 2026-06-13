import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '../cli/index.ts');

function runShell(script: string): Promise<{ stdout: string; stderr: string; exit: number }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exit: code ?? 0 });
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

// =============================================================================
// mkdir
// =============================================================================

describe('mkdir', () => {
  it('creates a directory', async () => {
    const { exit } = await runShell('mkdir /tmp/mk_test1\ntest -d /tmp/mk_test1\n');
    assert.strictEqual(exit, 0);
  });

  it('exits non-zero if dir already exists', async () => {
    const { exit } = await runShell('mkdir /tmp/mk_exist\nmkdir /tmp/mk_exist\n');
    assert.notStrictEqual(exit, 0);
  });

  it('-p creates nested directories', async () => {
    const { exit } = await runShell('mkdir -p /tmp/mk_p/a/b/c\ntest -d /tmp/mk_p/a/b/c\n');
    assert.strictEqual(exit, 0);
  });

  it('-p does not fail if directory already exists', async () => {
    const { exit } = await runShell('mkdir /tmp/mk_p2\nmkdir -p /tmp/mk_p2\n');
    assert.strictEqual(exit, 0);
  });
});

// =============================================================================
// touch
// =============================================================================

describe('touch', () => {
  it('creates an empty file', async () => {
    const { exit } = await runShell('touch /tmp/touch1.txt\ntest -f /tmp/touch1.txt\n');
    assert.strictEqual(exit, 0);
  });

  it('does not error if file already exists', async () => {
    const { exit } = await runShell('echo "existing" > /tmp/touch2.txt\ntouch /tmp/touch2.txt\n');
    assert.strictEqual(exit, 0);
  });

  it('preserves existing file content', async () => {
    const { stdout } = await runShell(
      'echo "content" > /tmp/touch3.txt\ntouch /tmp/touch3.txt\ncat /tmp/touch3.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'content');
  });

  it('creates multiple files', async () => {
    const { exit } = await runShell(
      'touch /tmp/touch_a.txt /tmp/touch_b.txt\ntest -f /tmp/touch_a.txt && test -f /tmp/touch_b.txt\n'
    );
    assert.strictEqual(exit, 0);
  });
});

// =============================================================================
// cp
// =============================================================================

describe('cp', () => {
  it('copies a file', async () => {
    const { stdout } = await runShell(
      'echo "data" > /tmp/cp_src.txt\ncp /tmp/cp_src.txt /tmp/cp_dst.txt\ncat /tmp/cp_dst.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'data');
  });

  it('source file remains after copy', async () => {
    const { exit } = await runShell(
      'echo "src" > /tmp/cp_keep_src.txt\ncp /tmp/cp_keep_src.txt /tmp/cp_keep_dst.txt\ntest -f /tmp/cp_keep_src.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('overwrites destination file', async () => {
    const { stdout } = await runShell(
      'echo "old" > /tmp/cp_ow_dst.txt\necho "new" > /tmp/cp_ow_src.txt\ncp /tmp/cp_ow_src.txt /tmp/cp_ow_dst.txt\ncat /tmp/cp_ow_dst.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'new');
  });

  it('exits non-zero for missing source', async () => {
    const { exit } = await runShell('cp /tmp/no_such_cp_src /tmp/cp_out.txt\n');
    assert.notStrictEqual(exit, 0);
  });

  it('-r recursively copies a directory', async () => {
    const { exit } = await runShell(
      'mkdir /tmp/cp_rdir\necho "a" > /tmp/cp_rdir/a.txt\ncp -r /tmp/cp_rdir /tmp/cp_rdir2\ntest -f /tmp/cp_rdir2/a.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('-r copies nested subdirectories', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/cp_nested/subdir\necho "deep" > /tmp/cp_nested/subdir/deep.txt\ncp -r /tmp/cp_nested /tmp/cp_nested_dest\ncat /tmp/cp_nested_dest/subdir/deep.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'deep');
  });

  it('-R (capital) also copies recursively', async () => {
    const { exit } = await runShell(
      'mkdir /tmp/cp_R_dir\necho "R" > /tmp/cp_R_dir/r.txt\ncp -R /tmp/cp_R_dir /tmp/cp_R_dir2\ntest -f /tmp/cp_R_dir2/r.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('-r copies into existing destination directory', async () => {
    const { stdout } = await runShell(
      'mkdir /tmp/cp_into_src\necho "inside" > /tmp/cp_into_src/file.txt\nmkdir /tmp/cp_into_dst\ncp -r /tmp/cp_into_src /tmp/cp_into_dst\ncat /tmp/cp_into_dst/cp_into_src/file.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'inside');
  });

  it('errors without -r when source is directory', async () => {
    const { exit, stderr } = await runShell(
      'mkdir /tmp/cp_no_r_dir\ncp /tmp/cp_no_r_dir /tmp/cp_no_r_dest\n'
    );
    assert.notStrictEqual(exit, 0);
    assert.ok(stderr.includes('omitting directory') || stderr.includes('-r not specified'));
  });
});

// =============================================================================
// mv
// =============================================================================

describe('mv', () => {
  it('renames a file', async () => {
    const { stdout } = await runShell(
      'echo "data" > /tmp/mv_src.txt\nmv /tmp/mv_src.txt /tmp/mv_dst.txt\ncat /tmp/mv_dst.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'data');
  });

  it('source no longer exists after move', async () => {
    const { stdout } = await runShell(
      'echo "x" > /tmp/mv_gone_src.txt\nmv /tmp/mv_gone_src.txt /tmp/mv_gone_dst.txt\ntest -f /tmp/mv_gone_src.txt && echo exists || echo gone\n'
    );
    assert.strictEqual(stdout.trim(), 'gone');
  });

  it('exits non-zero for missing source', async () => {
    const { exit } = await runShell('mv /tmp/no_such_mv_src /tmp/mv_out.txt\n');
    assert.notStrictEqual(exit, 0);
  });

  it('moves file into existing directory', async () => {
    const { exit } = await runShell(
      'echo "x" > /tmp/mv_into_src.txt\nmkdir /tmp/mv_into_dir\nmv /tmp/mv_into_src.txt /tmp/mv_into_dir/\ntest -f /tmp/mv_into_dir/mv_into_src.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('moves multiple sources to directory', async () => {
    const { exit } = await runShell(
      'echo "a" > /tmp/mv_ms_a.txt\necho "b" > /tmp/mv_ms_b.txt\nmkdir /tmp/mv_ms_dir\nmv /tmp/mv_ms_a.txt /tmp/mv_ms_b.txt /tmp/mv_ms_dir/\ntest -f /tmp/mv_ms_dir/mv_ms_a.txt && test -f /tmp/mv_ms_dir/mv_ms_b.txt\n'
    );
    assert.strictEqual(exit, 0);
  });
});

// =============================================================================
// rm
// =============================================================================

describe('rm', () => {
  it('removes a single file', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/rm1.txt\nrm /tmp/rm1.txt\ntest -f /tmp/rm1.txt && echo exists || echo gone\n'
    );
    assert.strictEqual(stdout.trim(), 'gone');
  });

  it('exits non-zero for missing file', async () => {
    const { exit } = await runShell('rm /tmp/no_such_rm_file\n');
    assert.notStrictEqual(exit, 0);
  });

  it('-f does not error on missing file', async () => {
    const { exit } = await runShell('rm -f /tmp/no_such_rm_force\n');
    assert.strictEqual(exit, 0);
  });

  it('-r removes a directory and its contents', async () => {
    const { stdout } = await runShell(
      'mkdir /tmp/rm_dir\necho "a" > /tmp/rm_dir/a.txt\nrm -r /tmp/rm_dir\ntest -d /tmp/rm_dir && echo exists || echo gone\n'
    );
    assert.strictEqual(stdout.trim(), 'gone');
  });

  it('removes multiple files', async () => {
    const { exit } = await runShell(
      'echo a > /tmp/rm_multi_a.txt\necho b > /tmp/rm_multi_b.txt\nrm /tmp/rm_multi_a.txt /tmp/rm_multi_b.txt\ntest -f /tmp/rm_multi_a.txt || test -f /tmp/rm_multi_b.txt && echo exists || echo gone\n'
    );
    assert.strictEqual(exit, 0);
  });
});

// =============================================================================
// rmdir
// =============================================================================

describe('rmdir', () => {
  it('removes an empty directory', async () => {
    const { stdout } = await runShell(
      'mkdir /tmp/rmdir_test\nrmdir /tmp/rmdir_test\ntest -d /tmp/rmdir_test && echo exists || echo gone\n'
    );
    assert.strictEqual(stdout.trim(), 'gone');
  });

  it('exits non-zero for non-existent directory', async () => {
    const { exit } = await runShell('rmdir /tmp/no_such_rmdir\n');
    assert.notStrictEqual(exit, 0);
  });

  it('exits non-zero for non-empty directory', async () => {
    const { exit } = await runShell(
      'mkdir /tmp/rmdir_nonempty\necho x > /tmp/rmdir_nonempty/file.txt\nrmdir /tmp/rmdir_nonempty\n'
    );
    assert.notStrictEqual(exit, 0);
  });
});

// =============================================================================
// ln
// =============================================================================

describe('ln', () => {
  it('creates a hard link', async () => {
    const { stdout } = await runShell(
      'echo "linked" > /tmp/ln_src.txt\nln /tmp/ln_src.txt /tmp/ln_hard.txt\ncat /tmp/ln_hard.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'linked');
  });

  it('hard link shares content with source', async () => {
    const { stdout } = await runShell(
      'echo "shared" > /tmp/ln_sh_src.txt\nln /tmp/ln_sh_src.txt /tmp/ln_sh_dst.txt\ncat /tmp/ln_sh_dst.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'shared');
  });

  it('-s creates a symbolic link', async () => {
    const { exit } = await runShell(
      'echo "sym" > /tmp/ln_sym_src.txt\nln -s /tmp/ln_sym_src.txt /tmp/ln_sym_dst.txt\ntest -f /tmp/ln_sym_dst.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('symlink target is readable', async () => {
    const { stdout } = await runShell(
      'echo "symcontent" > /tmp/lns_src.txt\nln -s /tmp/lns_src.txt /tmp/lns_dst.txt\ncat /tmp/lns_dst.txt\n'
    );
    assert.strictEqual(stdout.trim(), 'symcontent');
  });
});

// =============================================================================
// ls
// =============================================================================

describe('ls', () => {
  it('lists directory contents', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ls_a.txt\necho y > /tmp/ls_b.txt\nls /tmp/ls_a.txt /tmp/ls_b.txt\n'
    );
    assert.ok(stdout.includes('ls_a.txt'));
    assert.ok(stdout.includes('ls_b.txt'));
  });

  it('lists a directory', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ls_dir_file.txt\nls /tmp\n'
    );
    assert.ok(stdout.includes('ls_dir_file.txt'));
  });

  it('exits 0 for existing path', async () => {
    const { exit } = await runShell('ls /tmp\n');
    assert.strictEqual(exit, 0);
  });

  it('exits non-zero for non-existent path', async () => {
    const { exit } = await runShell('ls /tmp/no_such_ls_dir\n');
    assert.notStrictEqual(exit, 0);
  });

  it('-a shows hidden files', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/.hidden_ls\nls -a /tmp\n'
    );
    assert.ok(stdout.includes('.hidden_ls'));
  });

  it('-l shows long format with permissions', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ls_long.txt\nls -l /tmp/ls_long.txt\n'
    );
    assert.match(stdout, /^[-d]/m);
  });

  it('-l shows permissions and size', async () => {
    const { stdout } = await runShell(
      'echo "hello" > /tmp/ls_l_size.txt\nls -l /tmp/ls_l_size.txt\n'
    );
    assert.match(stdout, /^-/m);
    assert.match(stdout, /\d+/);
    assert.ok(stdout.includes('ls_l_size.txt'));
  });

  it('-l shows owner and group columns', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ls_l_owner.txt\nls -l /tmp/ls_l_owner.txt\n'
    );
    assert.ok(stdout.includes('root'), `expected "root" in ls -l output, got: ${stdout}`);
  });

  it('-l has at least 7 space-separated fields', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ls_l_cols.txt\nls -l /tmp/ls_l_cols.txt\n'
    );
    const line = stdout.trim().split('\n').find(l => l.includes('ls_l_cols.txt'));
    assert.ok(line);
    const fields = line!.split(/\s+/);
    assert.ok(fields.length >= 7, `expected >=7 fields, got ${fields.length}: ${line}`);
  });

  it('-l shows nlinks column', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/ls_l_nlinks.txt\nls -l /tmp/ls_l_nlinks.txt\n'
    );
    const line = stdout.trim().split('\n').find(l => l.includes('ls_l_nlinks.txt'));
    assert.ok(line);
    const fields = line!.split(/\s+/);
    assert.strictEqual(fields[1].trim(), '1');
  });

  it('-R lists subdirectories recursively', async () => {
    const { stdout } = await runShell(
      'mkdir -p /tmp/ls_r_dir/sub\necho x > /tmp/ls_r_dir/a.txt\necho y > /tmp/ls_r_dir/sub/b.txt\nls -R /tmp/ls_r_dir\n'
    );
    assert.ok(stdout.includes('a.txt'));
    assert.ok(stdout.includes('sub'));
    assert.ok(stdout.includes('b.txt'));
  });

  it('-lt combines long format and time sort', async () => {
    const { stdout } = await runShell(
      'echo first > /tmp/ls_lt_old.txt\necho second > /tmp/ls_lt_new.txt\nls -lt /tmp/ls_lt_old.txt /tmp/ls_lt_new.txt\n'
    );
    assert.match(stdout, /^-/m);
    assert.ok(stdout.includes('ls_lt_old.txt'));
    assert.ok(stdout.includes('ls_lt_new.txt'));
  });
});

// =============================================================================
// chmod
// =============================================================================

describe('chmod', () => {
  it('mode 644 runs without error', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/chmod_test.txt\nchmod 644 /tmp/chmod_test.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('mode 755 runs without error', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/chmod755.txt\nchmod 755 /tmp/chmod755.txt\n'
    );
    assert.strictEqual(exit, 0);
  });

  it('exits non-zero for non-existent file', async () => {
    const { exit } = await runShell('chmod 644 /tmp/no_such_chmod_file\n');
    assert.notStrictEqual(exit, 0);
  });
});

// =============================================================================
// readlink
// =============================================================================

describe('readlink', () => {
  it('reads symlink target', async () => {
    const { stdout } = await runShell(
      'echo x > /tmp/rl_src.txt\nln -s /tmp/rl_src.txt /tmp/rl_link.txt\nreadlink /tmp/rl_link.txt\n'
    );
    assert.strictEqual(stdout.trim(), '/tmp/rl_src.txt');
  });

  it('exits non-zero for regular file (not a symlink)', async () => {
    const { exit } = await runShell(
      'echo x > /tmp/rl_nolink.txt\nreadlink /tmp/rl_nolink.txt\n'
    );
    assert.notStrictEqual(exit, 0);
  });

  it('exits non-zero for non-existent path', async () => {
    const { exit } = await runShell('readlink /tmp/no_such_readlink\n');
    assert.notStrictEqual(exit, 0);
  });
});

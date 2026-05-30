use super::{write_stdout, write_stderr, read_file, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let unified = args.iter().any(|a| *a == "-u" || *a == "--unified");
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();

    if file_args.len() < 2 {
        write_stderr("diff: missing operand\n");
        return 1;
    }

    let path1 = file_args[0];
    let path2 = file_args[1];

    let data1 = match read_file(path1) {
        Some(d) => d,
        None => {
            write_stderr(&format!("diff: {}: No such file or directory\n", path1));
            return 2;
        }
    };
    let data2 = match read_file(path2) {
        Some(d) => d,
        None => {
            write_stderr(&format!("diff: {}: No such file or directory\n", path2));
            return 2;
        }
    };

    let lines1 = lines_of(&data1);
    let lines2 = lines_of(&data2);

    if unified {
        let output = compute_unified_diff(&lines1, &lines2, path1, path2);
        if output.is_empty() {
            return 0;
        }
        write_stdout(&output);
        return 1;
    }

    let diffs = compute_diff(&lines1, &lines2);

    if diffs.is_empty() {
        return 0;
    }

    for chunk in &diffs {
        write_stdout(chunk);
        write_stdout("\n");
    }
    1
}

fn compute_unified_diff(lines1: &[&str], lines2: &[&str], path1: &str, path2: &str) -> String {
    let m = lines1.len();
    let n = lines2.len();

    // Build LCS table
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            if lines1[i] == lines2[j] {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    // Collect edit operations: (type, line) where type is ' ', '-', '+'
    let mut ops: Vec<(char, &str)> = Vec::new();
    let mut i = 0;
    let mut j = 0;
    while i < m || j < n {
        if i < m && j < n && lines1[i] == lines2[j] {
            ops.push((' ', lines1[i]));
            i += 1;
            j += 1;
        } else if i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push(('-', lines1[i]));
            i += 1;
        } else {
            ops.push(('+', lines2[j]));
            j += 1;
        }
    }

    if ops.iter().all(|(t, _)| *t == ' ') {
        return String::new();
    }

    // Group into hunks (context = 3)
    const CONTEXT: usize = 3;
    let mut hunks: Vec<(usize, usize)> = Vec::new(); // (start, end) in ops
    let mut k = 0;
    while k < ops.len() {
        if ops[k].0 != ' ' {
            let start = if k > CONTEXT { k - CONTEXT } else { 0 };
            let mut end = k + 1;
            while end < ops.len() && (ops[end].0 != ' ' || end < k + CONTEXT + 1) {
                end += 1;
            }
            let end = (end + CONTEXT).min(ops.len());
            if let Some(last) = hunks.last_mut() {
                if start <= last.1 {
                    last.1 = end;
                    k = end;
                    continue;
                }
            }
            hunks.push((start, end));
            k = end;
        } else {
            k += 1;
        }
    }

    let mut result = format!("--- {}\n+++ {}\n", path1, path2);

    for (hstart, hend) in hunks {
        // Compute line numbers
        let mut old_start = 1usize;
        let mut new_start = 1usize;
        for (t, _) in &ops[..hstart] {
            match t {
                ' ' | '-' => old_start += 1,
                '+' => new_start += 1,
                _ => {}
            }
        }
        let old_count = ops[hstart..hend].iter().filter(|(t, _)| *t == ' ' || *t == '-').count();
        let new_count = ops[hstart..hend].iter().filter(|(t, _)| *t == ' ' || *t == '+').count();

        let old_range = if old_count == 1 {
            format!("{}", old_start)
        } else {
            format!("{},{}", old_start, old_count)
        };
        let new_range = if new_count == 1 {
            format!("{}", new_start)
        } else {
            format!("{},{}", new_start, new_count)
        };
        result.push_str(&format!("@@ -{} +{} @@\n", old_range, new_range));

        for (t, line) in &ops[hstart..hend] {
            result.push(*t);
            result.push_str(line);
            result.push('\n');
        }
    }

    result
}

fn compute_diff(lines1: &[&str], lines2: &[&str]) -> Vec<String> {
    let m = lines1.len();
    let n = lines2.len();

    // Build LCS table
    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            if lines1[i] == lines2[j] {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    // Backtrack to find matching pairs
    // matches[k] = true means lines1[k] is matched (kept)
    // We'll collect hunks of (removed_range, added_range)
    let mut hunks: Vec<(usize, usize, usize, usize)> = Vec::new(); // (i_start, i_end, j_start, j_end) exclusive

    let mut i = 0;
    let mut j = 0;
    while i < m || j < n {
        if i < m && j < n && lines1[i] == lines2[j] {
            i += 1;
            j += 1;
        } else {
            let hunk_i_start = i;
            let hunk_j_start = j;
            while i < m || j < n {
                if i < m && j < n && lines1[i] == lines2[j] {
                    break;
                }
                if i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1]) {
                    i += 1;
                } else {
                    j += 1;
                }
            }
            hunks.push((hunk_i_start, i, hunk_j_start, j));
        }
    }

    let mut result = Vec::new();
    for (i_start, i_end, j_start, j_end) in hunks {
        let removed = &lines1[i_start..i_end];
        let added = &lines2[j_start..j_end];

        let hdr = if removed.is_empty() {
            let a_end = if added.len() == 1 {
                format!("{}", j_start + 1)
            } else {
                format!("{},{}", j_start + 1, j_end)
            };
            format!("{}a{}", i_start, a_end)
        } else if added.is_empty() {
            let d_range = if removed.len() == 1 {
                format!("{}", i_start + 1)
            } else {
                format!("{},{}", i_start + 1, i_end)
            };
            format!("{}d{}", d_range, j_start)
        } else {
            let left = if removed.len() == 1 {
                format!("{}", i_start + 1)
            } else {
                format!("{},{}", i_start + 1, i_end)
            };
            let right = if added.len() == 1 {
                format!("{}", j_start + 1)
            } else {
                format!("{},{}", j_start + 1, j_end)
            };
            format!("{}c{}", left, right)
        };
        result.push(hdr);
        for line in removed {
            result.push(format!("< {}", line));
        }
        if !removed.is_empty() && !added.is_empty() {
            result.push("---".to_string());
        }
        for line in added {
            result.push(format!("> {}", line));
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_files_produce_no_diff() {
        let lines = vec!["a", "b", "c"];
        assert!(compute_diff(&lines, &lines).is_empty());
    }

    #[test]
    fn single_line_change() {
        let a = vec!["one", "two", "three"];
        let b = vec!["one", "TWO", "three"];
        let diff = compute_diff(&a, &b);
        assert!(diff.iter().any(|l| l.contains('c')));
        assert!(diff.iter().any(|l| l.starts_with("< two")));
        assert!(diff.iter().any(|l| l.starts_with("> TWO")));
    }

    #[test]
    fn added_lines_produce_append_hunk() {
        let a = vec!["a", "b"];
        let b = vec!["a", "b", "c"];
        let diff = compute_diff(&a, &b);
        // Should contain an 'a' hunk header
        assert!(diff.iter().any(|l| l.contains('a')));
        assert!(diff.iter().any(|l| l.starts_with("> c")));
    }

    #[test]
    fn deleted_lines_produce_delete_hunk() {
        let a = vec!["a", "b", "c"];
        let b = vec!["a", "c"];
        let diff = compute_diff(&a, &b);
        // Should contain a 'd' hunk header
        assert!(diff.iter().any(|l| l.contains('d')));
        assert!(diff.iter().any(|l| l.starts_with("< b")));
    }

    #[test]
    fn separator_line_in_change_hunk() {
        let a = vec!["old"];
        let b = vec!["new"];
        let diff = compute_diff(&a, &b);
        assert!(diff.contains(&"---".to_string()));
    }

    #[test]
    fn empty_vs_nonempty() {
        let a: Vec<&str> = vec![];
        let b = vec!["line1", "line2"];
        let diff = compute_diff(&a, &b);
        assert!(!diff.is_empty());
        assert!(diff.iter().any(|l| l.starts_with("> line1")));
    }

    #[test]
    fn nonempty_vs_empty() {
        let a = vec!["line1"];
        let b: Vec<&str> = vec![];
        let diff = compute_diff(&a, &b);
        assert!(!diff.is_empty());
        assert!(diff.iter().any(|l| l.starts_with("< line1")));
    }

    #[test]
    fn multiple_hunks() {
        let a = vec!["a", "b", "c", "d", "e"];
        let b = vec!["a", "X", "c", "Y", "e"];
        let diff = compute_diff(&a, &b);
        // Two change hunks
        let change_hunks: Vec<_> = diff.iter().filter(|l| l.contains('c') && !l.starts_with('<') && !l.starts_with('>')).collect();
        assert_eq!(change_hunks.len(), 2);
    }
}

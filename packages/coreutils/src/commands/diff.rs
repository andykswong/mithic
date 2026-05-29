use super::{write_stdout, write_stderr, read_file, lines_of};

pub fn run(args: &[&str]) -> u8 {
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

fn compute_diff(lines1: &[&str], lines2: &[&str]) -> Vec<String> {
    // Simple line-by-line diff without LCS
    // Group consecutive changed lines into hunks
    let len1 = lines1.len();
    let len2 = lines2.len();

    let mut result = Vec::new();
    let mut i = 0;
    let mut j = 0;

    while i < len1 || j < len2 {
        if i < len1 && j < len2 && lines1[i] == lines2[j] {
            i += 1;
            j += 1;
            continue;
        }

        // Collect differing lines
        let start1 = i + 1;
        let start2 = j + 1;
        let mut removed: Vec<&str> = Vec::new();
        let mut added: Vec<&str> = Vec::new();

        // Advance through non-matching lines
        // Try to find next common line within a small lookahead
        let lookahead = 5;
        let mut matched = false;
        'outer: for di in 0..=lookahead {
            for dj in 0..=lookahead {
                if di == 0 && dj == 0 { continue; }
                let ni = i + di;
                let nj = j + dj;
                if ni <= len1 && nj <= len2 {
                    let l1_ok = ni == len1 || (ni < len1 && nj < len2 && lines1[ni] == lines2[nj]);
                    if l1_ok || (ni < len1 && nj < len2 && lines1[ni] == lines2[nj]) {
                        for k in i..ni { removed.push(lines1[k]); }
                        for k in j..nj { added.push(lines2[k]); }
                        i = ni;
                        j = nj;
                        matched = true;
                        break 'outer;
                    }
                }
            }
        }

        if !matched {
            // Consume remaining lines
            while i < len1 { removed.push(lines1[i]); i += 1; }
            while j < len2 { added.push(lines2[j]); j += 1; }
        }

        if removed.is_empty() && added.is_empty() {
            // Safety: avoid infinite loop
            if i < len1 { removed.push(lines1[i]); i += 1; }
            else if j < len2 { added.push(lines2[j]); j += 1; }
        }

        if removed.is_empty() && added.is_empty() { continue; }

        // Format hunk header
        let end1 = start1 + removed.len().saturating_sub(1);
        let end2 = start2 + added.len().saturating_sub(1);
        let hdr = if removed.is_empty() {
            format!("{}a{}", start1 - 1, if added.len() == 1 { format!("{}", start2) } else { format!("{},{}", start2, end2) })
        } else if added.is_empty() {
            format!("{}{}d{}", start1, if removed.len() == 1 { String::new() } else { format!(",{}", end1) }, start2 - 1)
        } else {
            format!("{}{},{}{}", start1, if removed.len() == 1 { String::new() } else { format!(",{}", end1) }, start2, if added.len() == 1 { String::new() } else { format!(",{}", end2) })
        };
        result.push(hdr);
        for line in &removed {
            result.push(format!("< {}", line));
        }
        if !removed.is_empty() && !added.is_empty() {
            result.push("---".to_string());
        }
        for line in &added {
            result.push(format!("> {}", line));
        }
    }

    result
}

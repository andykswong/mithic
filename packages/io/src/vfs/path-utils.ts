export function normalizePath(path: string): string {
  if (!path.startsWith('/')) path = '/' + path;
  const parts = path.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { resolved.pop(); }
    else { resolved.push(part); }
  }
  return '/' + resolved.join('/');
}

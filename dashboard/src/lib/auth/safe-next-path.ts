export function safeNextPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\%:\x00-\x20\x7f]/.test(value)
  )
    return '/';
  try {
    const url = new URL(value, 'https://dashboard.invalid');
    if (
      url.origin !== 'https://dashboard.invalid' ||
      url.pathname === '/login' ||
      url.pathname.startsWith('/login/')
    )
      return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

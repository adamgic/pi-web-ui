// Tokens stay in the fragment, never in HTTP request URLs or server logs.
export function previewFragment(token = '', anchor = '') {
  if (!token) return anchor ? `#${encodeURIComponent(anchor)}` : '';
  const fragment = new URLSearchParams({ token });
  if (anchor) fragment.set('anchor', anchor);
  return `#${fragment}`;
}

export function readPreviewFragment(hash) {
  const value = hash.replace(/^#/, '');
  const decode = text => { try { return decodeURIComponent(text); } catch { return text; } };
  // Accept old links with a second # before or after the token as well.
  const parts = value.split('#');
  const auth = parts.findIndex(part => part.startsWith('token='));
  if (auth < 0) return { token: '', anchor: decode(value) };
  const params = new URLSearchParams(parts[auth]);
  return { token: params.get('token') || '', anchor: params.get('anchor') ?? decode(parts.filter((_, index) => index !== auth).join('#')) };
}

export function previewLink(params, token, anchor = '') {
  return `/preview.html?${new URLSearchParams(params)}${previewFragment(token, anchor)}`;
}

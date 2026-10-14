export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_cursor'); }
}

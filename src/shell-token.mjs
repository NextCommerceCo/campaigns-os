export function shellToken(value) {
  // null and undefined are "no value"; 0, false and NaN are values and print as themselves.
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}


/**
 * Admin search that ignores the digit script: "01712" finds "০১৭১২" and the other way round
 * (shopkeepers often type phone numbers in Bangla digits). Everything else is a plain,
 * case-insensitive "contains" match with regex characters escaped.
 */
const BN = '০১২৩৪৫৬৭৮৯';

export function searchRegex(q: string): RegExp {
  let out = '';
  for (const ch of q.trim()) {
    const ascii = ch >= '0' && ch <= '9' ? Number(ch) : BN.indexOf(ch);
    if (ascii >= 0) out += `[${ascii}${BN[ascii]}]`;
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out, 'i');
}

export function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  let count = 0;
  for (let index = 0; index < value.length;) {
    count += 1;
    if (count > maximum) {
      return false;
    }
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      index += next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    } else {
      index += 1;
    }
  }
  return count >= minimum;
}

// Exact decimal inputs use 12 fractional digits; computed market prices have a separate quantizer.
const SCALE = 1_000_000_000_000n;

export function positiveNumber(value, name) {
  if (typeof value !== 'number' && typeof value !== 'string') throw Error('invalid_' + name);
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) throw Error('invalid_' + name);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number >= 1e21) throw Error('invalid_' + name);
  return number;
}

export function units(value, name = 'decimal') {
  const number = positiveNumber(value, name);
  if (typeof value === 'string') {
    const [whole, fraction = ''] = value.split('.');
    if (fraction.length > 12) throw Error('invalid_' + name + '_precision');
    return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
  }
  const fixed = number.toFixed(12);
  if (Number(fixed) !== number) throw Error('invalid_' + name + '_precision');
  return BigInt(fixed.replace('.', ''));
}

export function decimalString(value) {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}

export function quantize(value, step, up = false) {
  const valueUnits = units(value), stepUnits = units(step, 'step');
  return decimalString((valueUnits / stepUnits + (up && valueUnits % stepUnits !== 0n ? 1n : 0n)) * stepUnits);
}

export function quantizeMarketPrice(value, step, up = false) {
  const ratio = positiveNumber(value, 'market_price') / positiveNumber(step, 'step');
  if (!Number.isFinite(ratio) || ratio > Number.MAX_SAFE_INTEGER) throw Error('invalid_market_price_precision');
  const nearest = Math.round(ratio);
  // Midpoint arithmetic may leave a few binary ULPs at an exact tick boundary.
  const adjusted = Math.abs(ratio - nearest) <= Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4 ? nearest : ratio;
  const ticks = up ? Math.ceil(adjusted) : Math.floor(adjusted);
  return decimalString(BigInt(ticks) * units(step, 'step'));
}

export function sizeFor(qty, step, factor) {
  const value = units(qty, 'qty') * units(factor, 'size_factor') / SCALE;
  const stepUnits = units(step, 'qty_step');
  return decimalString(value / stepUnits * stepUnits);
}

const OPERATORS = ['+', '-', '×', '÷'];
const isOperator = (value) => OPERATORS.includes(value);
const cleanNumber = (value) => Number(Number(value).toFixed(10));

export function calculateExpression(expression) {
  const compact = String(expression || '').replaceAll(' ', '');
  if (!compact || isOperator(compact.at(-1))) return { value: null, error: null };
  const tokens = compact.match(/(?:\d+(?:\.\d*)?|\.\d+)|[+\-×÷]/g);
  if (!tokens || tokens.join('') !== compact || tokens.length % 2 === 0) return { value: null, error: '算式不完整' };

  const values = [Number(tokens[0])];
  const additions = [];
  if (!Number.isFinite(values[0])) return { value: null, error: '金額格式錯誤' };
  for (let index = 1; index < tokens.length; index += 2) {
    const operator = tokens[index];
    const operand = Number(tokens[index + 1]);
    if (!Number.isFinite(operand)) return { value: null, error: '金額格式錯誤' };
    if (operator === '÷' && operand === 0) return { value: null, error: '不能除以 0' };
    if (operator === '×' || operator === '÷') {
      const previous = values.pop();
      values.push(operator === '×' ? previous * operand : previous / operand);
    } else {
      additions.push(operator);
      values.push(operand);
    }
  }
  const value = values.slice(1).reduce((total, operand, index) => additions[index] === '+' ? total + operand : total - operand, values[0]);
  return Number.isFinite(value) ? { value: cleanNumber(value), error: null } : { value: null, error: '計算結果無效' };
}

// 無條件捨去到十位；以放大 100 倍的整數運算，避免浮點數誤差。
export function floorToTens(value) {
  const scaled = Math.round(Number(value) * 100);
  if (!Number.isFinite(scaled)) return 0;
  const remainder = ((scaled % 1000) + 1000) % 1000;
  return (scaled - remainder) / 100;
}

// 依請款比例（0-100）計算可請款金額：比例 100% 維持原始金額，其餘比例的結果無條件捨去到十位。
// 全程以整數運算（金額、比例各放大 100 倍）取代浮點乘除，避免精度誤差。
export function calculateClaimAmount(amount, ratioPercent) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const ratioInput = Number(ratioPercent);
  const ratio = Math.min(100, Math.max(0, Number.isFinite(ratioInput) ? ratioInput : 100));
  if (ratio <= 0) return 0;
  if (ratio >= 100) return amt;
  const scaledAmount = Math.round(amt * 100);
  const scaledRatio = Math.round(ratio * 100);
  const numerator = scaledAmount * scaledRatio;
  const remainder = numerator % 10000000;
  const quotient = (numerator - remainder) / 10000000;
  return quotient * 10;
}

export function updateExpression(expression, key, { maxLength = 32 } = {}) {
  let next = String(expression || '');
  if (key === 'AC') return { expression: '', ...calculateExpression('') };
  if (key === 'backspace') {
    next = next.slice(0, -1);
    return { expression: next, ...calculateExpression(next) };
  }
  if (key === '=') {
    const result = calculateExpression(next);
    return result.error || result.value === null ? { expression: next, ...result } : { expression: String(result.value), ...result };
  }
  if (isOperator(key)) {
    if (!next) return { expression: next, value: null, error: null };
    next = isOperator(next.at(-1)) ? `${next.slice(0, -1)}${key}` : `${next}${key}`;
    return { expression: next, ...calculateExpression(next) };
  }
  if (!/^\d$|^00$|^\.$/.test(key) || next.length + key.length > maxLength) return { expression: next, ...calculateExpression(next) };
  const current = next.split(/[+\-×÷]/).at(-1);
  if (key === '.' && current.includes('.')) return { expression: next, ...calculateExpression(next) };
  if (key === '.' && current === '') next += '0';
  if (key === '00' && current === '') next += '0';
  next += key;
  return { expression: next, ...calculateExpression(next) };
}

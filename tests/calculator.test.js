import { calculateExpression, updateExpression } from '../calculator.js';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}

export async function runCalculatorTests() {
  await test('四則運算與優先順序', () => {
    assert(calculateExpression('100+50').value === 150, '加法錯誤');
    assert(calculateExpression('300-50').value === 250, '減法錯誤');
    assert(calculateExpression('120×3').value === 360, '乘法錯誤');
    assert(calculateExpression('360÷3').value === 120, '除法錯誤');
    assert(calculateExpression('2+3×4').value === 14, '運算優先順序錯誤');
  });
  await test('小數、00 與等號', () => {
    let state = updateExpression('', '1');
    state = updateExpression(state.expression, '.');
    state = updateExpression(state.expression, '2');
    state = updateExpression(state.expression, '00');
    state = updateExpression(state.expression, '+');
    state = updateExpression(state.expression, '0');
    state = updateExpression(state.expression, '.');
    state = updateExpression(state.expression, '3');
    state = updateExpression(state.expression, '=');
    assert(state.expression === '1.5' && state.value === 1.5, `小數或 00 錯誤：${state.expression}`);
  });
  await test('連續運算子、退格與 AC', () => {
    assert(updateExpression('12+', '×').expression === '12×', '連續運算子沒有替換');
    assert(updateExpression('12+3', 'backspace').expression === '12+', '退格錯誤');
    assert(updateExpression('12+3', 'AC').expression === '', 'AC 未清空');
  });
  await test('空值與除以 0 會安全拒絕', () => {
    assert(calculateExpression('').value === null, '空值不應產生金額');
    assert(calculateExpression('10÷0').error === '不能除以 0', '除以 0 未阻擋');
  });
  return results;
}

import { calculateClaimAmount, calculateExpression, floorToTens, updateExpression } from '../calculator.js';

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
  await test('無條件捨去到十位', () => {
    assert(floorToTens(617) === 610, '617 應捨去為 610');
    assert(floorToTens(999) === 990, '999 應捨去為 990');
    assert(floorToTens(1234) === 1230, '1234 應捨去為 1230');
    assert(floorToTens(1005) === 1000, '1005 應捨去為 1000');
    assert(floorToTens(100) === 100, '已是十位數的金額不應被改變');
    assert(floorToTens(0) === 0, '0 應維持 0');
  });
  await test('請款比例計算：100% 精確全額，其餘比例無條件捨去到十位', () => {
    assert(calculateClaimAmount(1000, 100) === 1000, '100% 應請款原始金額');
    assert(calculateClaimAmount(1000, 50) === 500, '50% 計算錯誤');
    assert(calculateClaimAmount(1234, 50) === 610, '50% 沒有無條件捨去到十位');
    assert(calculateClaimAmount(999, 25) === 240, '25% 沒有正確計算並捨去到十位');
    assert(calculateClaimAmount(1000, 0) === 0, '0% 應請款 0');
    assert(calculateClaimAmount(999, 100) === 999, '100% 請款不應被捨去，須與原始金額完全相容。');
    assert(calculateClaimAmount(45, 100) === 45, '舊資料預設 100% 請款須與原始金額精確相容，不可打折。');
    assert(calculateClaimAmount(1000, -10) === 0, '比例小於 0 應安全夾在 0。');
    assert(calculateClaimAmount(1000, 150) === 1000, '比例大於 100 應安全夾在 100。');
  });
  return results;
}

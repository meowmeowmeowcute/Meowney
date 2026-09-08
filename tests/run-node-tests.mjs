import 'fake-indexeddb/auto';

const suites = [
  { name: 'stage2', module: './stage2.test.js', exported: 'runStage2Tests' },
  { name: 'stage3', module: './stage3.test.js', exported: 'runStage3Tests' },
  { name: 'stage4', module: './stage4.test.js', exported: 'runStage4Tests' },
  { name: 'stage5', module: './stage5.test.js', exported: 'runStage5Tests' },
  { name: 'stage6', module: './stage6.test.js', exported: 'runStage6Tests' },
  { name: 'stage7', module: './stage7.test.js', exported: 'runStage7Tests' },
  { name: 'stage8', module: './stage8.test.js', exported: 'runStage8Tests' },
  { name: 'calculator', module: './calculator.test.js', exported: 'runCalculatorTests' },
];

const requested = new Set(process.argv.slice(2));
const selectedSuites = requested.size
  ? suites.filter((suite) => requested.has(suite.name))
  : suites;

if (selectedSuites.length === 0 || [...requested].some((name) => !suites.some((suite) => suite.name === name))) {
  console.error(`Unknown test suite. Available suites: ${suites.map((suite) => suite.name).join(', ')}`);
  process.exitCode = 1;
} else {
  let failed = 0;

  for (const suite of selectedSuites) {
    const module = await import(suite.module);
    const results = await module[suite.exported]();
    for (const result of results) {
      const status = result.passed ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${suite.name}: ${result.name}${result.message ? ` — ${result.message}` : ''}`);
      if (!result.passed) failed += 1;
    }
  }

  if (failed) {
    console.error(`${failed} test(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('All selected runtime tests passed.');
  }
}

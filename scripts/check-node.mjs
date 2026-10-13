// Runs before `npm test`. The suite replaces modules with `mock.module` (node:test), whose behaviour across tests in one file
// changed in Node 22.23: on 22.22 and older about 40 tests fail with "Cannot mock '@/lib/db'. The module is already mocked."
// or see a mock from an earlier test. The app itself runs on Node 22.12+ (Vite 8); only the test runner needs this.
const MIN = [22, 23, 0];
const have = process.versions.node.split(".").map(Number);
const older = have[0] === MIN[0] && (have[1] < MIN[1] || (have[1] === MIN[1] && have[2] < MIN[2]));
if (have[0] < MIN[0] || older) {
  console.error(`The test suite needs Node ${MIN.join(".")} or newer (this is ${process.versions.node}). Upgrade Node (CI uses the newest 22.x).`);
  process.exit(1);
}

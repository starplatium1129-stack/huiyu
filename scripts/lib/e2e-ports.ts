'use strict';

let defaults: typeof import('../../tests/e2e/mock-ports.json') = require('../../tests/e2e/mock-ports.json');
let offset = Number(process.env.AICS_E2E_PORT_OFFSET || 0);
if (!Number.isInteger(offset) || offset < 0 || offset > 50000) {
  throw new Error('AICS_E2E_PORT_OFFSET must be an integer between 0 and 50000');
}
// Browser assertions, the real gateway and every mock upstream share this mapping.
export = Object.freeze(Object.fromEntries(
  Object.entries(Object.assign({ web: 3000 }, defaults)).map(function (entry) {
    return [entry[0], entry[1] + offset];
  })
));

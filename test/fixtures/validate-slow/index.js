// Takes three seconds to require, so concurrent validations overlap (review R1-4).
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
module.exports = {};

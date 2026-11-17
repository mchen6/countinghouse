'use strict';
// listed in readNote's changesWith, and never succeeds: no update follows it
module.exports = async () => { throw new Error('this action always fails'); };

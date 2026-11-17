'use strict';
module.exports = async () => ({output: {late: global.__lateUsage != null ? global.__lateUsage : null}});

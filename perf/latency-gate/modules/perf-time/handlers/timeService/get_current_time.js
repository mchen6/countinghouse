'use strict';
module.exports = async (input) => ({output: {timezone: input.timezone, datetime: new Date().toLocaleString('sv-SE', {timeZone: input.timezone})}});

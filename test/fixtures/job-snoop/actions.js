// A module's own job is its to read (ctx.job.info), without the creator's API
// key; any other job, another tenant's included, is not, by read or by
// progress update (review R3-1).
const info = (jobID) => new Promise((resolve) => CHUtil.jobInfo(jobID, (e, j) => resolve({e: e, j: j})));

module.exports = {
  jobService: {
    whoami: async (input, ctx) => {
      if (ctx.job == null) return {output: {own: 'not a job', apiKey: 'n/a', note: null}};
      const r = await new Promise((resolve) => ctx.job.info((e, j) => resolve({e: e, j: j})));
      if (r.e != null) return {output: {own: `error: ${r.e.message}`, apiKey: 'n/a', note: null}};
      const data = (r.j && r.j.job && r.j.job.data) || {};
      return {output: {own: 'ok', apiKey: data.apiKey != null ? 'sent' : 'absent', note: (data.input && data.input.note) || null}};
    },
    snoop: async (input) => {
      CHUtil.jobProgress(input.jobID, 99);
      const r = await info(input.jobID);
      return {output: {read: r.e != null ? `error: ${r.e.message}` : `ok: ${JSON.stringify(r.j).slice(0, 200)}`}};
    }
  }
};

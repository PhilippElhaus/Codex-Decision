"use strict";
// Sample only this harness and its owned child PIDs; never read argv or env.
const fs = require("node:fs/promises");

function sampler(ownedPids) {
  const peaks = { samples:0, peak_hook_hwm_kib:0, peak_concurrent_hook_rss_kib:0,
    peak_harness_rss_bytes:0, peak_lab_memory_current_bytes:0 };
  let pending = Promise.resolve(), busy = false;
  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const states = await Promise.all(ownedPids().map(async pid => {
        try {
          const status = await fs.readFile(`/proc/${pid}/status`,"utf8");
          const value = field => Number(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`,"m").exec(status)?.[1] || 0);
          return {rss:value("VmRSS"),hwm:value("VmHWM")};
        } catch (error) { if (["ENOENT","ESRCH"].includes(error.code)) return null; throw error; }
      }));
      peaks.samples++;
      peaks.peak_concurrent_hook_rss_kib = Math.max(peaks.peak_concurrent_hook_rss_kib,states.reduce((sum,state)=>sum+(state?.rss||0),0));
      peaks.peak_hook_hwm_kib = Math.max(peaks.peak_hook_hwm_kib,...states.map(state=>state?.hwm||0));
      peaks.peak_harness_rss_bytes = Math.max(peaks.peak_harness_rss_bytes,process.memoryUsage().rss);
      const current = Number(await fs.readFile("/sys/fs/cgroup/memory.current","utf8").catch(error=>{
        if(error.code==="ENOENT")return "0";throw error;
      }));
      peaks.peak_lab_memory_current_bytes = Math.max(peaks.peak_lab_memory_current_bytes,current);
    } finally { busy = false; }
  }
  const failures=[];
  const timer = process.platform === "linux" ? setInterval(()=>{if(!busy)pending=sample().catch(error=>failures.push(error.code||error.message));},100) : null;
  timer?.unref();
  return { async stop() { if(timer)clearInterval(timer);await pending;return {...peaks,interval_ms:100,linux_supported:process.platform==="linux",sampling_errors:[...new Set(failures)]}; } };
}
module.exports={sampler};

"use strict";
// Millisecond buckets bound memory during multi-hour process measurements.
class Latencies {
  constructor(){this.groups=new Map();}
  add(lines,outcome,milliseconds){
    const key=`${lines}:${outcome}`;
    if(!this.groups.has(key))this.groups.set(key,{lines,outcome,count:0,total:0,min:Infinity,max:0,buckets:new Uint32Array(55001)});
    const group=this.groups.get(key);
    group.count++;group.total+=milliseconds;group.min=Math.min(group.min,milliseconds);group.max=Math.max(group.max,milliseconds);
    group.buckets[Math.min(55000,Math.ceil(milliseconds))]++;
  }
  summary(){
    return [...this.groups.values()].map(group=>{
      const percentile=ratio=>{const target=Math.ceil(group.count*ratio);let seen=0;for(let bucket=0;bucket<group.buckets.length;bucket++){seen+=group.buckets[bucket];if(seen>=target)return bucket;}return 55000;};
      return {lines:group.lines,outcome:group.outcome,count:group.count,min_ms:group.min,mean_ms:group.total/group.count,p50_ms:percentile(.5),p95_ms:percentile(.95),max_ms:group.max};
    }).sort((a,b)=>a.lines-b.lines||a.outcome.localeCompare(b.outcome));
  }
}
module.exports={Latencies};
